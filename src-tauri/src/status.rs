//! Precise chat state from Claude Code hooks, Windows notifications, tray,
//! start with Windows and the global shortcut.
//!
//! Every `claude` the app starts gets `--settings <file>` with hooks that run
//! this executable (`gian-claudio.exe --gc-hook <pty id> <state>`); it writes
//! `status\<pty id>` and exits. The UI polls those files:
//! - `working`  the user sent a prompt / a tool is running
//! - `waiting`  Claude needs the user (permission prompt, question)
//! - `idle`     Claude has finished its turn

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::store;

/// Close button hides the window to the tray instead of quitting.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

fn status_dir() -> std::path::PathBuf {
    store::data_dir().join("status")
}

/// Entry point of `--gc-hook <id> <state>`. Must stay fast and silent.
pub fn hook_main(args: &[String]) {
    let (Some(id), Some(state)) = (args.first(), args.get(1)) else { return };
    let id = store::safe_name(id);
    if !matches!(state.as_str(), "working" | "waiting" | "idle") {
        return;
    }
    // Drain the hook's JSON input so Claude Code never blocks writing it.
    let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
    let dir = status_dir();
    let _ = std::fs::create_dir_all(&dir);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let _ = std::fs::write(dir.join(id), format!("{state} {ts}"));
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Entry point of `--gc-statusline <pty id> <account id>`: Claude Code runs it
/// as its status line after each response, with a JSON on stdin. We keep the
/// chat's context fill (per session) and the plan usage limits (per account,
/// documented only for Pro/Max/Ultra) and print nothing, so Claude Code's
/// bottom line stays as it is.
pub fn statusline_main(args: &[String]) {
    let (Some(pty), Some(account)) = (args.first(), args.get(1)) else { return };
    let mut raw = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    let dir = status_dir();
    let _ = std::fs::create_dir_all(&dir);
    let ts = now_ms();
    let cw = &v["context_window"];
    let line = serde_json::json!({
        "contextPct": cw["used_percentage"],
        "contextSize": cw["context_window_size"],
        "model": v["model"]["display_name"],
        "ts": ts,
    });
    let _ = std::fs::write(dir.join(format!("{}.line.json", store::safe_name(pty))), line.to_string());
    let rl = &v["rate_limits"];
    if rl.is_object() {
        let window = |w: &serde_json::Value| {
            if w.is_object() { serde_json::json!({ "pct": w["used_percentage"], "resetsAt": w["resets_at"] }) } else { serde_json::Value::Null }
        };
        let limits = serde_json::json!({ "fiveHour": window(&rl["five_hour"]), "sevenDay": window(&rl["seven_day"]), "ts": ts });
        let _ = std::fs::write(dir.join(format!("account-{}.limits.json", store::safe_name(account))), limits.to_string());
    }
}

/// Write the hooks settings file for one session and return its path,
/// passed as `claude --settings <path>`.
#[tauri::command]
pub fn status_settings_file(pty_id: String, account_id: String) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Forward slashes and quotes work whether hooks run in cmd or Git Bash.
    let exe = exe.to_string_lossy().replace('\\', "/");
    let id = store::safe_name(&pty_id);
    let account = store::safe_name(&account_id);
    let hook = |state: &str| serde_json::json!({ "type": "command", "command": format!("\"{exe}\" --gc-hook {id} {state}"), "timeout": 10 });
    let settings = serde_json::json!({
        "statusLine": { "type": "command", "command": format!("\"{exe}\" --gc-statusline {id} {account}"), "padding": 0 },
        "hooks": {
            "UserPromptSubmit": [{ "hooks": [hook("working")] }],
            "PreToolUse": [{ "matcher": "*", "hooks": [hook("working")] }],
            "PostToolUse": [{ "matcher": "*", "hooks": [hook("working")] }],
            "Notification": [{ "matcher": "permission_prompt|elicitation_dialog", "hooks": [hook("waiting")] }],
            "Stop": [{ "hooks": [hook("idle")] }]
        }
    });
    let dir = status_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dir.join(&id)); // fresh session, no stale state
    let path = dir.join(format!("{id}.settings.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&settings).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct Status {
    state: String,
    ts: u64,
}

/// Latest hook state of each session that has reported one.
#[tauri::command]
pub fn status_read(ids: Vec<String>) -> HashMap<String, Status> {
    let dir = status_dir();
    ids.into_iter()
        .filter_map(|id| {
            let text = std::fs::read_to_string(dir.join(store::safe_name(&id))).ok()?;
            let (state, ts) = text.split_once(' ')?;
            Some((id, Status { state: state.to_string(), ts: ts.trim().parse().unwrap_or(0) }))
        })
        .collect()
}

/// Remove a closed session's files.
#[tauri::command]
pub fn status_forget(pty_id: String) {
    let dir = status_dir();
    let id = store::safe_name(&pty_id);
    let _ = std::fs::remove_file(dir.join(&id));
    let _ = std::fs::remove_file(dir.join(format!("{id}.settings.json")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.line.json")));
}

fn read_json(path: std::path::PathBuf) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Context fill of each session (from its status line), when reported.
#[tauri::command]
pub fn status_line_read(ids: Vec<String>) -> HashMap<String, serde_json::Value> {
    let dir = status_dir();
    ids.into_iter()
        .filter_map(|id| Some((id.clone(), read_json(dir.join(format!("{}.line.json", store::safe_name(&id))))?)))
        .collect()
}

/// Last known plan usage limits of each account, when Claude Code reported them.
#[tauri::command]
pub fn account_limits_read(ids: Vec<String>) -> HashMap<String, serde_json::Value> {
    let dir = status_dir();
    ids.into_iter()
        .filter_map(|id| Some((id.clone(), read_json(dir.join(format!("account-{}.limits.json", store::safe_name(&id))))?)))
        .collect()
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The tray menu items, kept to translate their labels.
pub struct TrayItems {
    open: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}

/// Labels of the tray menu in the interface language (the UI sends them).
#[tauri::command]
pub fn tray_set_labels(items: tauri::State<'_, TrayItems>, open: String, quit: String) {
    let _ = items.open.set_text(open);
    let _ = items.quit.set_text(quit);
}

/// Tray icon with Open / Quit; a click on the icon brings the window back.
pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open Gian Claudio", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Gian Claudio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems { open, quit });
    Ok(())
}

/// Ctrl+Alt+G from anywhere shows the app (or hides it when it is in front).
pub fn setup_shortcut(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG);
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, sc, event| {
                if sc == &shortcut && event.state() == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            show_main(app);
                        }
                    }
                }
            })
            .build(),
    )?;
    // Another program may own the combination: the app still starts.
    let _ = app.global_shortcut().register(shortcut);
    Ok(())
}
