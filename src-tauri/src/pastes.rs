//! What a `[Pasted text #N +X lines]` or `[Image #N]` placeholder in the chat
//! stands for, so Ctrl+hover can preview it.
//!
//! Claude Code numbers text and image pastes with one counter per session and
//! keeps what was sent:
//! - text: `<config>/history.jsonl` maps the session's paste ids to a
//!   `contentHash`, whose text is in `<config>/paste-cache/<hash>.txt`
//!   (or, in some versions, inline as `content`);
//! - images: the transcript's user entries list their `imagePasteIds`, in the
//!   same order as the message's image blocks (base64).
//!
//! Pastes still in the prompt (not sent yet) are matched by the frontend.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

use crate::{pty, store};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Paste {
    /// "text" or "image".
    kind: &'static str,
    text: Option<String>,
    /// PNG/JPEG on disk (images only), for "Open" and "Copy".
    path: Option<String>,
    /// The image as a data URL, for the preview.
    data_url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    bytes: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    paste: Option<Paste>,
    /// Highest paste id already sent in this session (0 when none): higher
    /// ids are still in the prompt.
    max_sent_id: u32,
}

fn config_base(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir.filter(|d| !d.is_empty()) {
        Some(d) => Some(PathBuf::from(d)),
        None => Some(dirs::home_dir()?.join(".claude")),
    }
}

/// Find paste `id` of a session (`kind` is "text" or "image").
#[tauri::command]
pub async fn paste_lookup(config_dir: Option<String>, cwd: String, session_id: String, kind: String, id: u32) -> Result<Lookup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = config_base(config_dir.as_deref()).ok_or("No home folder")?;
        let mut out = Lookup::default();
        let text = scan_history(&base, &session_id, (kind == "text").then_some(id), &mut out.max_sent_id);
        let transcript = pty::transcript_path(config_dir.as_deref(), &cwd, &session_id);
        let image = transcript.and_then(|t| scan_transcript(&t, &session_id, (kind == "image").then_some(id), &mut out.max_sent_id));
        out.paste = if kind == "text" { text.map(text_paste) } else { image };
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An image file pasted from the app (still in the prompt).
#[tauri::command]
pub async fn paste_image_file(path: String) -> Result<Paste, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(image_paste(&bytes, mime_of(&path), path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write pasted text to a temporary file and open it in the default editor.
#[tauri::command]
pub async fn paste_open_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = store::data_dir().join("paste");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("pasted-{}.txt", chrono::Local::now().format("%Y%m%d-%H%M%S-%3f")));
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put an image file (PNG) back on the clipboard.
#[tauri::command]
pub async fn clipboard_write_image(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut dec = png::Decoder::new(file);
        dec.set_transformations(png::Transformations::normalize_to_color8() | png::Transformations::ALPHA);
        let mut reader = dec.read_info().map_err(|e| format!("Only PNG images can be copied: {e}"))?;
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(info.buffer_size());
        let rgba = match info.color_type {
            png::ColorType::Rgba => buf,
            png::ColorType::GrayscaleAlpha => buf.chunks(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
            _ => return Err("Unsupported PNG".into()),
        };
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_image(arboard::ImageData { width: info.width as usize, height: info.height as usize, bytes: rgba.into() }))
            .map_err(|e| format!("Cannot copy: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read the session's entries of history.jsonl: note the highest paste id,
/// and return the text of paste `want` if asked.
fn scan_history(base: &Path, session_id: &str, want: Option<u32>, max_id: &mut u32) -> Option<String> {
    let file = std::fs::File::open(base.join("history.jsonl")).ok()?;
    let mut found = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains(session_id) || !line.contains("pastedContents") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["sessionId"].as_str() != Some(session_id) {
            continue;
        }
        let Some(pastes) = v["pastedContents"].as_object() else { continue };
        for (key, p) in pastes {
            let Ok(id) = key.parse::<u32>() else { continue };
            *max_id = (*max_id).max(id);
            if Some(id) == want && p["type"].as_str() == Some("text") {
                found = p["content"].as_str().map(str::to_string).or_else(|| {
                    let hash = store::safe_name(p["contentHash"].as_str()?);
                    std::fs::read_to_string(base.join("paste-cache").join(format!("{hash}.txt"))).ok()
                });
            }
        }
    }
    found
}

/// Read the transcript's user entries: note the highest image id, and return
/// image `want` (saved to a file) if asked.
fn scan_transcript(path: &Path, session_id: &str, want: Option<u32>, max_id: &mut u32) -> Option<Paste> {
    let file = std::fs::File::open(path).ok()?;
    let mut found = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("\"imagePasteIds\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(ids) = v["imagePasteIds"].as_array() else { continue };
        let ids: Vec<u32> = ids.iter().filter_map(|i| i.as_u64().map(|n| n as u32)).collect();
        if let Some(&m) = ids.iter().max() {
            *max_id = (*max_id).max(m);
        }
        let Some(pos) = want.and_then(|w| ids.iter().position(|&i| i == w)) else { continue };
        let images: Vec<&Value> = v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "image").collect();
        let Some(src) = images.get(pos).map(|b| &b["source"]) else { continue };
        let (Some(data), mime) = (src["data"].as_str(), src["media_type"].as_str().unwrap_or("image/png")) else { continue };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { continue };
        // A file too, so the image can be opened or copied.
        let ext = if mime.ends_with("jpeg") { "jpg" } else { mime.rsplit('/').next().unwrap_or("png") };
        let dir = store::data_dir().join("paste");
        let file = dir.join(format!("chat-{}-{}.{ext}", store::safe_name(session_id), want.unwrap_or(0)));
        if !file.exists() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&file, &bytes);
        }
        found = Some(image_paste(&bytes, mime, file.to_string_lossy().into_owned()));
    }
    found
}

fn text_paste(text: String) -> Paste {
    Paste { kind: "text", bytes: text.len() as u64, text: Some(text), path: None, data_url: None, width: None, height: None }
}

fn image_paste(bytes: &[u8], mime: &str, path: String) -> Paste {
    let (width, height) = image_size(bytes).unzip();
    Paste {
        kind: "image",
        text: None,
        data_url: Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))),
        path: Some(path),
        width,
        height,
        bytes: bytes.len() as u64,
    }
}

fn mime_of(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    }
}

/// Width and height from a PNG or JPEG header.
fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() > 24 && b.starts_with(b"\x89PNG") {
        let be = |i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        return Some((be(16), be(20)));
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xFF {
                return None;
            }
            let marker = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
            if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gc-pastes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("paste-cache")).unwrap();
        d
    }

    #[test]
    fn finds_text_in_paste_cache_and_inline() {
        let d = temp_dir("text");
        std::fs::write(d.join("paste-cache").join("abc123.txt"), "one\ntwo\n").unwrap();
        let history = [
            r#"{"display":"x [Pasted text #2 +2 lines]","pastedContents":{"2":{"id":2,"type":"text","contentHash":"abc123"}},"sessionId":"s1"}"#,
            r#"{"display":"y [Pasted text #5 +1 lines]","pastedContents":{"5":{"id":5,"type":"text","content":"inline\n"}},"sessionId":"s1"}"#,
            r#"{"display":"z","pastedContents":{"9":{"id":9,"type":"text","content":"other"}},"sessionId":"s2"}"#,
        ];
        std::fs::write(d.join("history.jsonl"), history.join("\n")).unwrap();
        let mut max = 0;
        assert_eq!(scan_history(&d, "s1", Some(2), &mut max).as_deref(), Some("one\ntwo\n"));
        assert_eq!(max, 5);
        assert_eq!(scan_history(&d, "s1", Some(5), &mut max).as_deref(), Some("inline\n"));
        assert_eq!(scan_history(&d, "s1", Some(9), &mut max), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finds_image_by_paste_id() {
        let d = temp_dir("img");
        // 1x1 PNG header is enough for the size; the data only needs to round-trip.
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        let line = format!(
            r#"{{"type":"user","imagePasteIds":[3,4],"message":{{"content":[{{"type":"text","text":"[Image #3] [Image #4]"}},{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"AAAA"}}}},{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{b64}"}}}}]}}}}"#
        );
        let t = d.join("t.jsonl");
        std::fs::write(&t, line).unwrap();
        let mut max = 0;
        let p = scan_transcript(&t, "test-session", Some(4), &mut max).unwrap();
        assert_eq!(max, 4);
        assert_eq!((p.width, p.height), (Some(3), Some(2)));
        let path = p.path.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), png);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(&d);
    }
}
