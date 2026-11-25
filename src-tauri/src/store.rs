//! App data folder, persisted state, accounts and the `claude` executable.
//!
//! Layout of `%APPDATA%\GianClaudio`:
//! - `state.json`                       contexts, accounts, open tabs, settings
//! - `accounts\<id>\`                   CLAUDE_CONFIG_DIR of each added account
//! - `contexts\<dir>\history\<date>\<chat>.md`     past chats (see history.rs)

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const KEYRING_SERVICE: &str = "GianClaudio";

pub fn data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("GianClaudio")
}

/// Keep ids usable as folder names whatever the frontend sends.
pub fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Hide the console window of helper processes (claude --version, -p, explorer).
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Locate the `claude` CLI: PATH first, then the native installer's and npm's
/// default folders (the app's PATH does not see a just-finished install).
pub fn resolve_claude() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for n in names {
                let p = dir.join(n);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    let mut extra = Vec::new();
    if let Some(home) = dirs::home_dir() {
        extra.push(home.join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" }));
    }
    if let Some(roaming) = dirs::config_dir() {
        extra.push(roaming.join("npm").join("claude.cmd"));
    }
    extra.into_iter().find(|p| p.is_file())
}

/// How to start `claude`: program + leading args, plus a folder to put first
/// in PATH. A .cmd shim must go through cmd.exe, which mangles a quoted full
/// path containing spaces (e.g. C:\Users\First Last\...), so it is called
/// by bare name with its folder prepended to PATH instead.
pub struct ClaudeLaunch {
    pub argv: Vec<String>,
    pub path_prefix: Option<PathBuf>,
}

impl ClaudeLaunch {
    /// PATH value with `path_prefix` in front, when there is one.
    pub fn path_env(&self) -> Option<std::ffi::OsString> {
        let dir = self.path_prefix.as_ref()?;
        let mut parts = vec![dir.clone()];
        if let Some(cur) = std::env::var_os("PATH") {
            parts.extend(std::env::split_paths(&cur));
        }
        std::env::join_paths(parts).ok()
    }
}

pub fn claude_launch() -> ClaudeLaunch {
    let cmd_shell = |name: String| vec!["cmd.exe".into(), "/d".into(), "/c".into(), name];
    match resolve_claude() {
        Some(p) if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) => ClaudeLaunch {
            argv: cmd_shell(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "claude.cmd".into())),
            path_prefix: p.parent().map(Path::to_path_buf),
        },
        Some(p) => ClaudeLaunch { argv: vec![p.to_string_lossy().into_owned()], path_prefix: None },
        None if cfg!(windows) => ClaudeLaunch { argv: cmd_shell("claude".into()), path_prefix: None },
        None => ClaudeLaunch { argv: vec!["claude".into()], path_prefix: None },
    }
}

/// A std Command ready to run `claude` (helpers: --version, -p summaries).
pub fn claude_std_command() -> Command {
    let l = claude_launch();
    let mut cmd = Command::new(&l.argv[0]);
    cmd.args(&l.argv[1..]);
    if let Some(p) = l.path_env() {
        cmd.env("PATH", p);
    }
    crate::pty::strip_parent_session_env_std(&mut cmd);
    no_window(&mut cmd);
    cmd
}

pub fn api_key(account_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, account_id).ok()?.get_password().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    data_dir: String,
    home_dir: String,
}

#[tauri::command]
pub fn app_paths() -> AppPaths {
    AppPaths {
        data_dir: data_dir().to_string_lossy().into_owned(),
        home_dir: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn state_load() -> Option<String> {
    std::fs::read_to_string(data_dir().join("state.json")).ok()
}

#[tauri::command]
pub fn state_save(json: String) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Write then rename, so a crash never leaves a half-written state file.
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("state.json")).map_err(|e| e.to_string())
}

/// Create (if needed) the isolated config folder of an account.
#[tauri::command]
pub fn account_dir(id: String) -> Result<String, String> {
    let dir = data_dir().join("accounts").join(safe_name(&id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The app's terminal is always dark: preset Claude Code's dark theme.
    let global = dir.join(".claude.json");
    if !global.exists() {
        let _ = std::fs::write(&global, "{\n  \"theme\": \"dark\"\n}\n");
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Whether the account can start sessions: a login for subscriptions,
/// a stored key for API accounts.
#[tauri::command]
pub fn account_status(id: String, kind: String, config_dir: Option<String>) -> bool {
    match kind.as_str() {
        "apikey" => api_key(&id).is_some(),
        _ => {
            let base = config_dir
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|h| h.join(".claude")));
            base.is_some_and(|b| b.join(".credentials.json").is_file())
        }
    }
}

#[tauri::command]
pub fn apikey_set(id: String, key: String) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, &id)
        .and_then(|e| e.set_password(key.trim()))
        .map_err(|e| format!("Cannot save the key: {e}"))
}

/// Forget an account: its stored key and, when it lives in our data folder,
/// its config folder (login, settings, transcripts).
#[tauri::command]
pub fn account_remove(id: String, config_dir: Option<String>) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) {
        let _ = entry.delete_credential();
    }
    if let Some(dir) = config_dir {
        let dir = PathBuf::from(dir);
        let accounts = data_dir().join("accounts");
        if dir.starts_with(&accounts) && dir != accounts && dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Delete everything the app stored for a context (its history).
#[tauri::command]
pub fn context_remove_files(dir_name: String) -> Result<(), String> {
    let name = safe_name(&dir_name);
    if name.trim_matches('-').is_empty() {
        return Err("Invalid folder name".into());
    }
    let dir = data_dir().join("contexts").join(name);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a folder in Explorer (created first if missing). Goes through the
/// shell (ShellExecute) rather than `explorer.exe <arg>`, whose own command
/// line parsing rejects some quoted paths with spaces.
/// Async + spawn_blocking: sync commands run on the main thread, and a shell
/// call there freezes the whole window (close button, tray menu included).
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Show a file selected in its Explorer folder (off the main thread, see above).
#[tauri::command]
pub async fn reveal_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Latest Claude Code version published on npm (the same releases the native
/// installer ships). Only the package name goes out; nothing about the user.
#[tauri::command]
pub async fn claude_latest() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let body = ureq::get("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
            .timeout(std::time::Duration::from_secs(10))
            .call()
            .ok()?
            .into_string()
            .ok()?;
        let v: serde_json::Value = serde_json::from_str(&body).ok()?;
        v.get("version")?.as_str().map(str::to_string)
    })
    .await
    .ok()
    .flatten()
}

/// `claude --version`, or None when the CLI cannot be found or run.
#[tauri::command]
pub async fn claude_check() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = claude_std_command().arg("--version").output().ok()?;
        if !out.status.success() {
            return None;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!v.is_empty()).then_some(v)
    })
    .await
    .ok()
    .flatten()
}
