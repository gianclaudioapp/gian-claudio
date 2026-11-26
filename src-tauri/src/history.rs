//! History: when a context starts a new chat, the previous one is saved as
//! `contexts\<dir>\history\<YYYY-MM-DD>\<chat-name>.md`: a summary written
//! by Claude followed by the readable conversation.
//!
//! Each new chat receives (through `--append-system-prompt-file`) the summary
//! of the latest chat plus those of the chats marked as important, which get a
//! more detailed summary, and the path of the whole history folder.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{pty, store};

const SUMMARY_PROMPT: &str = "Summarize the conversation so far for a chat history archive. \
First line: a one-sentence summary of at most 140 characters, with no heading. \
Then a short bullet list with: what was done, decisions made, rules or preferences given by the user, main files touched, open items. \
Reply with the summary only, without using tools.";

const DETAILED_PROMPT: &str = "This conversation was marked as important: its content must stay available to future chats. \
Write a detailed, faithful summary for someone who has to continue the work without reading the conversation. \
Include precisely: goals, decisions and their reasons, instructions, rules and preferences given by the user (quote them verbatim), \
names of files, functions, commands and important values, problems met and their solutions, final state and open items. \
Use short headings and bullet lists. Reply with the summary only, without using tools.";

/// The language summaries are written in ("en" or "it"), as an instruction for Claude.
fn language_instruction(lang: &str) -> &'static str {
    match lang {
        "it" => " Write it in Italian.",
        _ => " Write it in English.",
    }
}

/// Section headings of a history file.
const SUMMARY: &str = "Summary";
const DETAILED: &str = "Detailed summary";
const CONVERSATION: &str = "Conversation";

/// Cap of the text handed to each new chat (summaries of past chats).
const PROMPT_BUDGET: usize = 24_000;

// ---- data written by versions up to 0.1 (Italian names) --------------------------

/// Front-matter keys and headings used by the first versions.
const LEGACY_KEYS: [(&str, &str); 9] = [
    ("nome", "name"),
    ("sessione", "session"),
    ("inizio", "start"),
    ("fine", "end"),
    ("cartella", "folder"),
    ("account_api", "api_account"),
    ("riassunto", "summary"),
    ("importante", "important"),
    ("config", "config"),
];
const LEGACY_HEADINGS: [(&str, &str); 3] = [
    ("\n## Riassunto dettagliato\n", "\n## Detailed summary\n"),
    ("\n## Riassunto\n", "\n## Summary\n"),
    ("\n## Conversazione\n", "\n## Conversation\n"),
];

/// A history file with English keys and headings, or None when it already has them.
fn english_history_file(text: &str) -> Option<String> {
    let fm_end = text.strip_prefix("---\n").and_then(|rest| rest.find("\n---\n")).map(|i| i + 4)?;
    let (fm, body) = text.split_at(fm_end);
    if !fm.lines().any(|l| l.starts_with("nome: ")) {
        return None;
    }
    let fm: String = fm
        .split_inclusive('\n')
        .map(|line| {
            for (old, new) in LEGACY_KEYS {
                if let Some(rest) = line.strip_prefix(&format!("{old}: ")) {
                    return format!("{new}: {rest}");
                }
            }
            line.to_string()
        })
        .collect();
    let mut body = body.to_string();
    for (old, new) in LEGACY_HEADINGS {
        body = body.replacen(old, new, 1);
    }
    Some(fm + &body)
}

/// Move data saved by the first versions to the English layout:
/// `contesti\<dir>\cronologia` becomes `contexts\<dir>\history`, and history
/// files get English keys and headings. Runs at startup; does nothing twice.
pub fn migrate_legacy_layout() {
    let data = store::data_dir();
    let (old, new) = (data.join("contesti"), data.join("contexts"));
    if old.is_dir() {
        if !new.exists() {
            let _ = std::fs::rename(&old, &new);
        } else {
            // Both exist: move over each context the new folder does not have yet.
            for ctx in std::fs::read_dir(&old).into_iter().flatten().flatten() {
                let target = new.join(ctx.file_name());
                if !target.exists() {
                    let _ = std::fs::rename(ctx.path(), target);
                }
            }
            let _ = std::fs::remove_dir(&old); // only when nothing was left behind
        }
    }
    let Ok(contexts) = std::fs::read_dir(&new) else { return };
    for ctx in contexts.flatten() {
        let (old, hist) = (ctx.path().join("cronologia"), ctx.path().join("history"));
        if old.is_dir() && !hist.exists() {
            let _ = std::fs::rename(&old, &hist);
        }
        let Ok(days) = std::fs::read_dir(&hist) else { continue };
        for day in days.flatten() {
            let Ok(files) = std::fs::read_dir(day.path()) else { continue };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                if let Some(updated) = std::fs::read_to_string(&path).ok().as_deref().and_then(english_history_file) {
                    let _ = std::fs::write(&path, updated);
                }
            }
        }
    }
}

pub fn context_root(dir: &str) -> PathBuf {
    store::data_dir().join("contexts").join(store::safe_name(dir))
}

pub fn history_dir(dir: &str) -> PathBuf {
    context_root(dir).join("history")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    context_dir: String,
    session_id: String,
    name: String,
    cwd: String,
    config_dir: Option<String>,
    api_key_account: Option<String>,
    /// "haiku", "sonnet" or "off".
    summary_model: String,
    /// Language of the summary: "en" or "it".
    #[serde(default)]
    language: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    path: String,
    file: String,
    name: String,
    session_id: String,
    cwd: String,
    config_dir: Option<String>,
    start: String,
    end: String,
    summary: String,
    important: bool,
    /// An important chat whose detailed summary exists.
    detailed: bool,
}

/// One message of a Claude Code transcript, reduced to what the archive needs.
struct Msg {
    user: bool,
    time: String,
    parts: Vec<String>,
}

fn parse_transcript(raw: &str) -> Vec<Msg> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let kind = v["type"].as_str().unwrap_or("");
        if (kind != "user" && kind != "assistant") || v["isMeta"].as_bool() == Some(true) || v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        let time = v["timestamp"].as_str().unwrap_or("").to_string();
        let mut parts = Vec::new();
        match &v["message"]["content"] {
            Value::String(s) => parts.push(clean_user_text(s)),
            Value::Array(blocks) => {
                for b in blocks {
                    match b["type"].as_str() {
                        Some("text") => parts.push(clean_user_text(b["text"].as_str().unwrap_or(""))),
                        Some("tool_use") => parts.push(format!("> Tool: {}{}", b["name"].as_str().unwrap_or("?"), tool_detail(&b["input"]))),
                        _ => {} // tool results and thinking stay out of the archive
                    }
                }
            }
            _ => {}
        }
        parts.retain(|p| !p.trim().is_empty());
        if !parts.is_empty() {
            out.push(Msg { user: kind == "user", time, parts });
        }
    }
    out
}

/// Slash-command wrappers become a readable line; everything else as typed.
fn clean_user_text(s: &str) -> String {
    if let Some(start) = s.find("<command-name>") {
        let rest = &s[start + 14..];
        let name = rest.split("</command-name>").next().unwrap_or("").trim();
        return format!("`{name}`");
    }
    if s.contains("<local-command-stdout>") || s.contains("<local-command-caveat>") {
        return String::new();
    }
    s.trim().to_string()
}

fn tool_detail(input: &Value) -> String {
    for key in ["file_path", "command", "pattern", "path", "url", "description"] {
        if let Some(s) = input[key].as_str() {
            let one_line: String = s.lines().next().unwrap_or("").chars().take(120).collect();
            return format!(" · {one_line}");
        }
    }
    String::new()
}

fn fmt_time(ts: &str, pattern: &str) -> String {
    DateTime::parse_from_rfc3339(ts)
        .map(|t| t.with_timezone(&Local).format(pattern).to_string())
        .unwrap_or_default()
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        let c = match c {
            'à' | 'á' | 'â' | 'ä' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let t = out.trim_matches('-');
    if t.is_empty() { "chat".into() } else { t.chars().take(60).collect() }
}

/// Ask Claude about a session in a throwaway fork, so the original transcript
/// is not touched and nothing new is saved to disk.
pub(crate) fn ask_session(session_id: &str, cwd: &str, config_dir: Option<&str>, api_key_account: Option<&str>, model: &str, prompt: &str) -> Option<String> {
    if model == "off" {
        return None;
    }
    let mut cmd = store::claude_std_command();
    cmd.args(["-p", "--resume", session_id, "--fork-session", "--no-session-persistence"])
        .args(["--model", model, "--output-format", "text"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = config_dir.filter(|d| !d.is_empty()) {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    if let Some(key) = api_key_account.filter(|a| !a.is_empty()).and_then(store::api_key) {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    let mut child = cmd.spawn().ok()?;
    // The prompt goes through stdin: no quoting trouble with cmd.exe.
    child.stdin.take()?.write_all(prompt.as_bytes()).ok()?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(Duration::from_secs(240)) {
        Ok(Ok(out)) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!text.is_empty()).then_some(text)
        }
        Ok(_) => None,
        Err(_) => {
            kill_tree(pid);
            None
        }
    }
}

/// Stop a summary that hangs, with the processes it started.
fn kill_tree(pid: u32) {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    } else {
        let mut c = Command::new("kill");
        c.args(["-9", &pid.to_string()]);
        c
    };
    store::no_window(&mut cmd);
    let _ = cmd.output();
}

fn unique_path(dir: &Path, base: &str) -> PathBuf {
    let mut p = dir.join(format!("{base}.md"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base}-{n}.md"));
        n += 1;
    }
    p
}

fn yaml(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn save(req: SaveRequest) -> Result<Option<String>, String> {
    let Some(tpath) = pty::transcript_path(req.config_dir.as_deref(), &req.cwd, &req.session_id) else { return Ok(None) };
    let Ok(raw) = std::fs::read_to_string(&tpath) else { return Ok(None) }; // chat never used
    let msgs = parse_transcript(&raw);
    if !msgs.iter().any(|m| m.user) {
        return Ok(None);
    }
    let start = msgs.first().map(|m| m.time.clone()).unwrap_or_default();
    let end = msgs.last().map(|m| m.time.clone()).unwrap_or_default();

    let prompt = format!("{SUMMARY_PROMPT}{}", language_instruction(&req.language));
    let summary = ask_session(&req.session_id, &req.cwd, req.config_dir.as_deref(), req.api_key_account.as_deref(), &req.summary_model, &prompt);
    let summary_line = summary
        .as_deref()
        .and_then(|s| s.lines().find(|l| !l.trim().is_empty()))
        .map(|l| l.trim().trim_start_matches(['#', '*', '-', ' ']).to_string())
        .unwrap_or_default();

    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("name: {}\n", yaml(&req.name)));
    md.push_str(&format!("session: {}\n", yaml(&req.session_id)));
    md.push_str(&format!("start: {}\n", yaml(&start)));
    md.push_str(&format!("end: {}\n", yaml(&end)));
    md.push_str(&format!("folder: {}\n", yaml(&req.cwd)));
    md.push_str(&format!("config: {}\n", yaml(req.config_dir.as_deref().unwrap_or(""))));
    md.push_str(&format!("api_account: {}\n", yaml(req.api_key_account.as_deref().unwrap_or(""))));
    md.push_str(&format!("summary: {}\n", yaml(&summary_line)));
    md.push_str("important: false\n");
    md.push_str("---\n\n");
    md.push_str(&format!("# {}\n\n", req.name));
    md.push_str(&format!("{} – {} · {}\n\n", fmt_time(&start, "%Y-%m-%d %H:%M"), fmt_time(&end, "%H:%M"), req.cwd));
    md.push_str(&format!("## {SUMMARY}\n\n"));
    md.push_str(summary.as_deref().unwrap_or("_Summary not available._"));
    md.push_str(&format!("\n\n## {CONVERSATION}\n\n"));
    for m in &msgs {
        md.push_str(&format!("**{}** · {}\n\n", if m.user { "You" } else { "Claude" }, fmt_time(&m.time, "%H:%M")));
        for p in &m.parts {
            md.push_str(p);
            md.push_str("\n\n");
        }
    }

    let day = {
        let d = fmt_time(&start, "%Y-%m-%d");
        if d.is_empty() { Local::now().format("%Y-%m-%d").to_string() } else { d }
    };
    let dir = history_dir(&req.context_dir).join(day);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &slug(&req.name));
    std::fs::write(&path, md).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Save a finished chat to the context's history. Returns the file path, or
/// None when the chat had no messages.
#[tauri::command]
pub async fn history_save(req: SaveRequest) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || save(req)).await.map_err(|e| e.to_string())?
}

// ---- reading history files -------------------------------------------------------

type FrontMatter = std::collections::HashMap<String, String>;

fn front_matter(text: &str) -> FrontMatter {
    let mut map = FrontMatter::new();
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return map;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(": ") {
            let v = serde_json::from_str::<String>(v).unwrap_or_else(|_| v.to_string());
            map.insert(k.to_string(), v);
        }
    }
    map
}

/// Body of a `## <title>` section, up to the next `## `.
fn section<'a>(text: &'a str, title: &str) -> Option<&'a str> {
    let head = format!("\n## {title}\n");
    let start = text.find(&head)? + head.len();
    let rest = &text[start..];
    let end = rest.find("\n## ").unwrap_or(rest.len());
    Some(rest[..end].trim())
}

fn entry_from(path: &Path, text: &str) -> HistoryEntry {
    let fm = front_matter(text);
    let get = |k: &str| fm.get(k).cloned().unwrap_or_default();
    let config = get("config");
    HistoryEntry {
        path: path.to_string_lossy().into_owned(),
        file: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        name: get("name"),
        session_id: get("session"),
        cwd: get("folder"),
        config_dir: (!config.is_empty()).then_some(config),
        start: get("start"),
        end: get("end"),
        summary: get("summary"),
        important: get("important") == "true",
        detailed: section(text, DETAILED).is_some(),
    }
}

fn list_files(dir: &str) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let Ok(days) = std::fs::read_dir(history_dir(dir)) else { return out };
    for day in days.flatten() {
        let Ok(files) = std::fs::read_dir(day.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.push((path, text));
            }
        }
    }
    out
}

#[tauri::command]
pub fn history_list(context_dir: String) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = list_files(&context_dir).iter().map(|(p, t)| entry_from(p, t)).collect();
    out.sort_by(|a, b| b.start.cmp(&a.start));
    out
}

/// Raw JSONL transcript of a session, for the read-only view.
#[tauri::command]
pub fn transcript_read(config_dir: Option<String>, cwd: String, session_id: String) -> Option<String> {
    let p = pty::transcript_path(config_dir.as_deref(), &cwd, &session_id)?;
    std::fs::read_to_string(p).ok()
}

fn checked_history_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.starts_with(store::data_dir()) || p.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("Invalid path".into());
    }
    Ok(p)
}

/// Text of a history file (fallback when the transcript is gone).
#[tauri::command]
pub fn history_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(checked_history_path(&path)?).map_err(|e| e.to_string())
}

// ---- important chats -------------------------------------------------------------

fn set_front_matter(text: &str, key: &str, value: &str) -> String {
    let mut out = String::new();
    let mut in_fm = false;
    let mut done = false;
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let bare = line.trim_end_matches(['\r', '\n']);
        if i == 0 && bare == "---" {
            in_fm = true;
        } else if in_fm && bare == "---" {
            if !done {
                out.push_str(&format!("{key}: {value}\n"));
                done = true;
            }
            in_fm = false;
        } else if in_fm && bare.starts_with(&format!("{key}: ")) {
            out.push_str(&format!("{key}: {value}\n"));
            done = true;
            continue;
        }
        out.push_str(line);
    }
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportantRequest {
    path: String,
    important: bool,
    /// Fallbacks for files written before these fields were recorded.
    api_key_account: Option<String>,
    model: String,
    /// Language of the detailed summary: "en" or "it".
    #[serde(default)]
    language: String,
}

/// Mark a past chat as important (or not). The first time it is marked, Claude
/// writes a detailed summary that later chats receive in full.
#[tauri::command]
pub async fn history_set_important(req: ImportantRequest) -> Result<HistoryEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_history_path(&req.path)?;
        let mut text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        text = set_front_matter(&text, "important", if req.important { "true" } else { "false" });
        std::fs::write(&path, &text).map_err(|e| e.to_string())?;

        if req.important && section(&text, DETAILED).is_none() {
            let fm = front_matter(&text);
            let get = |k: &str| fm.get(k).cloned().unwrap_or_default();
            let account = Some(get("api_account")).filter(|s| !s.is_empty()).or(req.api_key_account.clone());
            let model = if req.model == "off" { "sonnet" } else { req.model.as_str() };
            let prompt = format!("{DETAILED_PROMPT}{}", language_instruction(&req.language));
            if let Some(detailed) = ask_session(&get("session"), &get("folder"), Some(get("config").as_str()), account.as_deref(), model, &prompt) {
                // Re-read: the file may have changed while Claude was writing.
                let current = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let block = format!("## {DETAILED}\n\n{detailed}\n\n");
                let updated = match current.find(&format!("## {CONVERSATION}")) {
                    Some(i) => format!("{}{}{}", &current[..i], block, &current[i..]),
                    None => format!("{current}\n{block}"),
                };
                std::fs::write(&path, &updated).map_err(|e| e.to_string())?;
                return Ok(entry_from(&path, &updated));
            }
        }
        let now = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(entry_from(&path, &now))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- search across every context ---------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    context_dir: String,
    entry: HistoryEntry,
    /// Text around the first match.
    snippet: String,
}

fn snippet_around(text: &str, at: usize, len: usize) -> String {
    let start = text[..at].char_indices().rev().nth(80).map(|(i, _)| i).unwrap_or(0);
    let end = text[at + len..].char_indices().nth(120).map(|(i, _)| at + len + i).unwrap_or(text.len());
    let s: String = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{}{}", if start > 0 { "…" } else { "" }, s, if end < text.len() { "…" } else { "" })
}

/// Case-insensitive search in every past chat of every context (name,
/// summaries and conversation). At most `limit` results, newest first.
#[tauri::command]
pub fn history_search(query: String, limit: Option<usize>) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    let mut hits = Vec::new();
    if q.chars().count() < 2 {
        return hits;
    }
    let Ok(contexts) = std::fs::read_dir(store::data_dir().join("contexts")) else { return hits };
    for ctx in contexts.flatten() {
        let dir = ctx.file_name().to_string_lossy().into_owned();
        for (path, text) in list_files(&dir) {
            let body = text.splitn(3, "---\n").nth(2).unwrap_or(&text);
            let lower = body.to_lowercase();
            if let Some(i) = lower.find(&q) {
                // Offsets of `lower` match `body` only when lowercasing kept the length.
                let exact = lower.len() == body.len() && body.is_char_boundary(i) && body.is_char_boundary(i + q.len());
                let (at, len) = if exact { (i, q.len()) } else { (0, 0) };
                hits.push(SearchHit { context_dir: dir.clone(), entry: entry_from(&path, &text), snippet: snippet_around(body, at, len) });
            }
        }
    }
    hits.sort_by(|a, b| b.entry.start.cmp(&a.entry.start));
    hits.truncate(limit.unwrap_or(200));
    hits
}

// ---- what each new chat receives -------------------------------------------------

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push_str("\n[…]");
    t
}

/// Write `contexts\<dir>\prompt.md`: the history folder plus the summaries of
/// the latest chat and of every important chat. Returns its path, passed to
/// `claude --append-system-prompt-file`.
#[tauri::command]
pub fn context_prompt_file(context_dir: String) -> Result<String, String> {
    let root = history_dir(&context_dir);
    let mut files = list_files(&context_dir);
    files.sort_by(|a, b| {
        let sa = front_matter(&a.1).get("start").cloned().unwrap_or_default();
        let sb = front_matter(&b.1).get("start").cloned().unwrap_or_default();
        sb.cmp(&sa)
    });

    let mut text = format!(
        "# History of this context\n\n\
        The past chats of this context are saved in {}: one Markdown file per chat, in subfolders by date (YYYY-MM-DD), \
        each with a summary and the full conversation. Below are the summaries of the latest chat and of the chats marked as important: \
        take them into account (especially the user's instructions, rules and preferences) and open the files when you need the details.\n",
        root.display()
    );

    let mut picked: Vec<(&PathBuf, &String, bool)> = Vec::new();
    if let Some((p, t)) = files.first() {
        picked.push((p, t, false));
    }
    for (p, t) in files.iter() {
        if front_matter(t).get("important").map(String::as_str) == Some("true") && !picked.iter().any(|(q, _, _)| *q == p) {
            picked.push((p, t, true));
        }
    }
    // The latest chat is also flagged when it is important.
    for item in picked.iter_mut() {
        item.2 = front_matter(item.1).get("important").map(String::as_str) == Some("true");
    }

    let per_item = if picked.is_empty() { PROMPT_BUDGET } else { PROMPT_BUDGET / picked.len() };
    for (i, (path, t, important)) in picked.iter().enumerate() {
        let fm = front_matter(t);
        let get = |k: &str| fm.get(k).cloned().unwrap_or_default();
        let label = match (i == 0, *important) {
            (true, true) => "Latest chat · important",
            (true, false) => "Latest chat",
            _ => "Important chat",
        };
        let body = if *important {
            section(t, DETAILED).or_else(|| section(t, SUMMARY))
        } else {
            section(t, SUMMARY)
        }
        .unwrap_or("(summary not available)");
        text.push_str(&format!(
            "\n## {label}: {} ({})\nFile: {}\n\n{}\n",
            get("name"),
            fmt_time(&get("start"), "%Y-%m-%d %H:%M"),
            path.display(),
            clip(body, per_item)
        ));
    }

    let dir = context_root(&context_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("prompt.md");
    std::fs::write(&out, text).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_slugs() {
        let raw = r#"{"type":"user","timestamp":"2026-11-18T13:02:00Z","message":{"content":"Estrai il calcolo IVA"}}
{"type":"assistant","timestamp":"2026-11-18T13:03:00Z","message":{"content":[{"type":"text","text":"Procedo."},{"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}}]}}
{"type":"user","isMeta":true,"timestamp":"x","message":{"content":"meta"}}"#;
        let m = parse_transcript(raw);
        assert_eq!(m.len(), 2);
        assert!(m[0].user);
        assert_eq!(m[1].parts[1], "> Tool: Read · src/a.ts");
        assert_eq!(slug("Why is the café test broken?"), "why-is-the-cafe-test-broken");
        let fm = front_matter("---\nname: \"Hello: world\"\n---\n# x");
        assert_eq!(fm["name"], "Hello: world");
    }

    #[test]
    fn legacy_files_become_english() {
        let old = "---\nnome: \"x\"\nsessione: \"s\"\nfinestra: 1\nimportante: true\n---\n\n# x\n\n## Riassunto\n\nbreve\n\n## Riassunto dettagliato\n\nlungo\n\n## Conversazione\n\n## Riassunto\nresta\n";
        let new = english_history_file(old).unwrap();
        let fm = front_matter(&new);
        assert_eq!(fm["name"], "x");
        assert_eq!(fm["session"], "s");
        assert_eq!(fm["important"], "true");
        assert_eq!(fm["finestra"], "1"); // keys that only start like a legacy one stay
        assert_eq!(section(&new, SUMMARY), Some("breve"));
        assert_eq!(section(&new, DETAILED), Some("lungo"));
        assert!(new.contains("## Conversation\n\n## Riassunto\nresta")); // only the first heading
        assert!(english_history_file(&new).is_none());
    }

    #[test]
    fn front_matter_update_and_sections() {
        let doc = "---\nname: \"x\"\nimportant: false\n---\n\n# x\n\n## Summary\n\nshort\n\n## Conversation\n\nbla\n";
        let on = set_front_matter(doc, "important", "true");
        assert_eq!(front_matter(&on)["important"], "true");
        assert!(on.contains("## Summary\n\nshort"));
        let added = set_front_matter("---\nname: \"x\"\n---\nbody\n", "important", "true");
        assert_eq!(front_matter(&added)["important"], "true");
        assert_eq!(section(doc, SUMMARY), Some("short"));
        assert_eq!(section(doc, DETAILED), None);
    }
}
