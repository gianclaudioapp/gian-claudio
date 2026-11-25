mod clipboard;
mod history;
mod links;
mod pty;
mod status;
mod store;
mod usage;

pub use status::{hook_main, statusline_main};

use std::sync::atomic::Ordering;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // In-app updates from the GitHub releases (see plugins.updater in tauri.conf.json).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(pty::PtyState::default())
        .setup(|app| {
            history::migrate_legacy_layout();
            status::setup_tray(app)?;
            status::setup_shortcut(app)?;
            if store::DEV {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_title("Gian Claudio (dev)");
                }
            }
            // Started with Windows: stay in the tray until called.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray, so running chats keep going. Not in a
            // dev build: there the × really quits, like any test run.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !store::DEV && status::CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::session_exists,
            pty::session_titles,
            store::app_paths,
            store::state_load,
            store::state_save,
            store::account_dir,
            store::account_status,
            store::apikey_set,
            store::account_remove,
            store::context_remove_files,
            store::open_folder,
            store::reveal_file,
            links::link_resolve,
            links::link_open,
            store::claude_latest,
            store::claude_check,
            usage::context_base,
            history::history_save,
            history::history_list,
            history::transcript_read,
            history::history_read_file,
            history::history_set_important,
            history::context_prompt_file,
            history::history_search,
            status::status_settings_file,
            status::status_read,
            status::status_forget,
            status::status_line_read,
            status::account_limits_read,
            status::notify,
            status::tray_set_labels,
            status::set_close_to_tray,
            status::autostart_get,
            status::autostart_set,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            usage::usage_sessions,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Really quit (the close button only hides to the tray).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
