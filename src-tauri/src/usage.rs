//! Token usage of chats, read from Claude Code transcripts. Each assistant
//! entry carries `message.usage` and `message.model`; one API response can be
//! written as several lines (one per content block), so entries are counted
//! once per message id.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::pty;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    config_dir: Option<String>,
    cwd: String,
    session_id: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
    requests: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    session_id: String,
    /// Per model id (e.g. "claude-opus-5-5").
    by_model: HashMap<String, Tokens>,
    /// Total tokens (input + output + cache) per local day "YYYY-MM-DD".
    by_day: HashMap<String, u64>,
    first: Option<String>,
    last: Option<String>,
}

fn num(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

fn read_usage(r: &SessionRef, since: Option<&str>) -> SessionUsage {
    let mut out = SessionUsage { session_id: r.session_id.clone(), ..Default::default() };
    let Some(path) = pty::transcript_path(r.config_dir.as_deref(), &r.cwd, &r.session_id) else { return out };
    let Ok(raw) = std::fs::read_to_string(path) else { return out };
    let mut seen = HashSet::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"].as_str() != Some("assistant") {
            continue;
        }
        let msg = &v["message"];
        let usage = &msg["usage"];
        if !usage.is_object() {
            continue;
        }
        let model = msg["model"].as_str().unwrap_or("");
        if model.is_empty() || model.starts_with('<') {
            continue; // "<synthetic>" entries are not API calls
        }
        let key = msg["id"].as_str().or(v["requestId"].as_str()).or(v["uuid"].as_str()).unwrap_or("").to_string();
        if !key.is_empty() && !seen.insert(key) {
            continue;
        }
        let ts = v["timestamp"].as_str().unwrap_or("");
        if let Some(s) = since {
            if !ts.is_empty() && ts < s {
                continue;
            }
        }
        let (input, output, read) = (num(&usage["input_tokens"]), num(&usage["output_tokens"]), num(&usage["cache_read_input_tokens"]));
        let cc = &usage["cache_creation"];
        let (w5, w1) = if cc.is_object() {
            (num(&cc["ephemeral_5m_input_tokens"]), num(&cc["ephemeral_1h_input_tokens"]))
        } else {
            (num(&usage["cache_creation_input_tokens"]), 0)
        };
        let t = out.by_model.entry(model.to_string()).or_default();
        t.input += input;
        t.output += output;
        t.cache_read += read;
        t.cache_write_5m += w5;
        t.cache_write_1h += w1;
        t.requests += 1;
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
            let day = dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
            *out.by_day.entry(day).or_default() += input + output + read + w5 + w1;
        }
        if !ts.is_empty() {
            if out.first.as_deref().is_none_or(|f| ts < f) {
                out.first = Some(ts.to_string());
            }
            if out.last.as_deref().is_none_or(|l| ts > l) {
                out.last = Some(ts.to_string());
            }
        }
    }
    out
}

/// Usage of each session, in the order given. `since` (RFC 3339) keeps only
/// requests from that moment on, e.g. the start of the month.
#[tauri::command]
pub async fn usage_sessions(items: Vec<SessionRef>, since: Option<String>) -> Vec<SessionUsage> {
    tauri::async_runtime::spawn_blocking(move || items.iter().map(|r| read_usage(r, since.as_deref())).collect())
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_each_message_once() {
        let dir = std::env::temp_dir().join("gc-usage-test");
        let cwd = "C:\\x\\y";
        let r = SessionRef { config_dir: Some(dir.to_string_lossy().into()), cwd: cwd.into(), session_id: "s1".into() };
        let p = pty::transcript_path(r.config_dir.as_deref(), cwd, "s1").unwrap();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let line = |id: &str, ts: &str| format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"{id}","model":"claude-opus-5-5","usage":{{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":20}}}}}}}}"#
        );
        let raw = [line("m1", "2026-11-01T10:00:00Z"), line("m1", "2026-11-01T10:00:00Z"), line("m2", "2026-11-20T10:00:00Z")].join("\n");
        std::fs::write(&p, raw).unwrap();
        let u = read_usage(&r, None);
        let t = &u.by_model["claude-opus-5-5"];
        assert_eq!((t.input, t.output, t.cache_read, t.cache_write_1h, t.requests), (20, 10, 200, 40, 2));
        let since = read_usage(&r, Some("2026-11-10T00:00:00Z"));
        assert_eq!(since.by_model["claude-opus-5-5"].requests, 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
