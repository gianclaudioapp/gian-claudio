//! Pseudo-terminal sessions running the `claude` CLI (ConPTY on Windows).

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::store;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    /// Id chosen by the frontend; used to route output events.
    pub id: String,
    /// Working directory (the context's working folder).
    pub cwd: String,
    /// Arguments passed to `claude` (e.g. --session-id, --resume, --add-dir).
    pub args: Vec<String>,
    /// Extra environment, e.g. CLAUDE_CONFIG_DIR for the account.
    pub env: HashMap<String, String>,
    /// Run this argv instead of `claude` (e.g. the Claude Code installer).
    #[serde(default)]
    pub program: Option<Vec<String>>,
    /// API-key account whose key (from Windows Credential Manager) is passed
    /// as ANTHROPIC_API_KEY. Read here so the key never reaches the UI.
    #[serde(default)]
    pub api_key_account: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<u32>,
}

/// Variables of a parent Claude Code session to drop. When the app itself was
/// started from inside Claude Code (e.g. in development) they leak into every
/// `claude` we spawn: it then believes it is a child session and, among other
/// things, stops saving transcripts, which breaks `--resume`. Only done in that
/// case, so variables a user set on purpose are kept.
fn parent_session_vars() -> Vec<OsString> {
    let inside_claude = std::env::var_os("CLAUDECODE").is_some()
        || std::env::var_os("CLAUDE_CODE_CHILD_SESSION").is_some();
    if !inside_claude {
        return Vec::new();
    }
    std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|key| {
            let k = key.to_string_lossy();
            k == "CLAUDECODE"
                || k == "CLAUDE_PID"
                || k == "ANTHROPIC_BASE_URL"
                || k.starts_with("CLAUDE_CODE_")
                || k.starts_with("CLAUDE_AGENT_SDK_")
                || k.starts_with("CLAUDE_PREVIEW_")
                || k.starts_with("MCP_")
        })
        .collect()
}

pub fn strip_parent_session_env_std(cmd: &mut std::process::Command) {
    for k in parent_session_vars() {
        cmd.env_remove(k);
    }
}

fn build_command(req: &SpawnRequest) -> CommandBuilder {
    let (argv, path_env) = match &req.program {
        Some(p) if !p.is_empty() => (p.clone(), None),
        _ => {
            let launch = store::claude_launch();
            let mut v = launch.argv.clone();
            v.extend(req.args.iter().cloned());
            (v, launch.path_env())
        }
    };
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.cwd(&req.cwd);
    for k in parent_session_vars() {
        cmd.env_remove(k);
    }
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    for (k, v) in &req.env {
        cmd.env(k, v);
    }
    if let Some(key) = req.api_key_account.as_deref().and_then(store::api_key) {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<'_, PtyState>, req: SpawnRequest) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: req.rows, cols: req.cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Cannot open the terminal: {e}"))?;

    let child = pair
        .slave
        .spawn_command(build_command(&req))
        .map_err(|e| format!("Cannot start the process: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = req.id.clone();
    let sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Bytes of a UTF-8 sequence split across two reads.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(), // invalid bytes: decode lossily
                    };
                    let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    let _ = app.emit("pty-output", OutputEvent { id: id.clone(), data });
                }
            }
        }
        let code = sessions
            .lock()
            .ok()
            .and_then(|mut s| s.remove(&id))
            .and_then(|mut s| s.child.wait().ok())
            .map(|status| status.exit_code());
        let _ = app.emit("pty-exit", ExitEvent { id, code });
    });

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(req.id, Session { master: pair.master, writer, child });
    Ok(())
}

/// Path of Claude Code's transcript for a session:
/// `<config dir>/projects/<cwd with every non-alphanumeric char as '-'>/<id>.jsonl`.
pub fn transcript_path(config_dir: Option<&str>, cwd: &str, session_id: &str) -> Option<std::path::PathBuf> {
    let base = match config_dir {
        Some(dir) => std::path::PathBuf::from(dir),
        None => dirs::home_dir()?.join(".claude"),
    };
    let encoded: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    Some(base.join("projects").join(encoded).join(format!("{}.jsonl", store::safe_name(session_id))))
}

/// Whether `claude --resume <id>` can work (a transcript exists).
#[tauri::command]
pub fn session_exists(config_dir: Option<String>, cwd: String, session_id: String) -> bool {
    transcript_path(config_dir.as_deref(), &cwd, &session_id).is_some_and(|p| p.exists())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleRef {
    config_dir: Option<String>,
    cwd: String,
    session_id: String,
}

/// Per transcript: bytes already scanned, and the titles found so far.
#[derive(Default)]
struct TitleScan {
    offset: u64,
    ai: Option<String>,
    custom: Option<String>,
}

static TITLE_SCANS: std::sync::LazyLock<Mutex<HashMap<std::path::PathBuf, TitleScan>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Chat titles Claude Code wrote in the transcripts: `/rename` (custom-title)
/// wins over the generated one (ai-title). The terminal title is not enough:
/// Claude Code may not set it. Only the new part of each file is read.
#[tauri::command]
pub fn session_titles(items: Vec<TitleRef>) -> HashMap<String, String> {
    use std::io::{BufRead, Seek, SeekFrom};
    let mut out = HashMap::new();
    let mut scans = TITLE_SCANS.lock().unwrap_or_else(|e| e.into_inner());
    for it in items {
        let Some(path) = transcript_path(it.config_dir.as_deref(), &it.cwd, &it.session_id) else { continue };
        let Ok(mut file) = std::fs::File::open(&path) else { continue };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let scan = scans.entry(path).or_default();
        if len < scan.offset {
            *scan = TitleScan::default();
        }
        if len > scan.offset && file.seek(SeekFrom::Start(scan.offset)).is_ok() {
            let mut reader = std::io::BufReader::new(file);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // A line still being written: read it again next time.
                        if !line.ends_with('\n') {
                            break;
                        }
                        scan.offset += n as u64;
                        if !line.contains("-title\"") {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                        let text = |k: &str| v.get(k).and_then(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                        match v.get("type").and_then(|t| t.as_str()) {
                            Some("ai-title") => scan.ai = text("aiTitle").or(scan.ai.take()),
                            Some("custom-title") => scan.custom = text("customTitle").or(scan.custom.take()),
                            _ => {}
                        }
                    }
                }
            }
        }
        if let Some(t) = scan.custom.clone().or_else(|| scan.ai.clone()) {
            out.insert(it.session_id, t);
        }
    }
    out
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get_mut(&id).ok_or("Session not found")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get(&id).ok_or("Session not found")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Starts the real `claude` CLI through the same ConPTY path the app uses.
    #[test]
    fn claude_runs_in_pty() {
        // Needs the real CLI; CI machines usually do not have it.
        if store::resolve_claude().is_none() {
            eprintln!("skipped: the claude CLI is not installed");
            return;
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let req = SpawnRequest {
            id: "t".into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            // Several quoted args, like the app's --append-system-prompt: cmd.exe
            // used to mangle these when claude.cmd sat in a path with spaces.
            args: vec!["--version".into(), "--append-system-prompt".into(), "text with spaces C:\\Folder With Spaces".into()],
            env: HashMap::new(),
            program: None,
            api_key_account: None,
            cols: 100,
            rows: 24,
        };
        let mut child = pair.slave.spawn_command(build_command(&req)).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let reading = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // ConPTY asks for the cursor position (DSR) and waits for the
                // answer; xterm.js replies on its own in the app.
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                }
                out.extend_from_slice(&buf[..n]);
            }
            String::from_utf8_lossy(&out).into_owned()
        });
        let status = child.wait().unwrap();
        drop(pair.master);
        let out = reading.join().unwrap();
        assert!(status.success(), "exit {status:?}, output: {out}");
        assert!(out.contains("Claude Code"), "output: {out}");
    }

    #[test]
    fn titles_come_from_the_transcript() {
        let dir = std::env::temp_dir().join(format!("gc-title-{}", std::process::id()));
        let p = transcript_path(Some(dir.to_str().unwrap()), "C:\\x", "s1").unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let req = || vec![TitleRef { config_dir: Some(dir.to_string_lossy().into_owned()), cwd: "C:\\x".into(), session_id: "s1".into() }];
        std::fs::write(&p, "{\"type\":\"user\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Primo\"}\n").unwrap();
        assert_eq!(session_titles(req()).get("s1").map(String::as_str), Some("Primo"));
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Scelto\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Secondo\"}\n").unwrap();
        assert_eq!(session_titles(req()).get("s1").map(String::as_str), Some("Scelto"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_path_encodes_cwd() {
        let p = transcript_path(Some("C:\\cfg"), "C:\\DEV\\MIO\\app", "abc").unwrap();
        assert!(p.ends_with("projects\\C--DEV-MIO-app\\abc.jsonl") || p.ends_with("projects/C--DEV-MIO-app/abc.jsonl"));
    }
}
