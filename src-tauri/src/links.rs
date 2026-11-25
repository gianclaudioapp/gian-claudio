//! Ctrl+click links in the terminal: find which pieces of a line are real
//! files, and open files or URLs with the program Windows associates with them.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Characters a path won't end with in prose ("see C:\a.png." or "(src/x.ts)").
const TRAILING: &[char] = &['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '\'', '"', '`'];
/// Longest piece of a line tried as a path, in chars.
const MAX_LEN: usize = 400;
/// How many end points (one per space) are tried for one candidate.
const MAX_ENDS: usize = 24;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkHit {
    /// Length of the matched text in UTF-16 units (JavaScript string indices).
    len: usize,
    path: String,
}

/// For each candidate (text starting where a path may start), the longest
/// prefix that names an existing file or folder. Relative paths resolve
/// against `cwd`; a `:line:col` suffix is allowed. Paths with spaces work
/// because every space is tried as the end, longest first.
#[tauri::command]
pub async fn link_resolve(cwd: String, candidates: Vec<String>) -> Result<Vec<Option<LinkHit>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = Path::new(&cwd);
        candidates.iter().map(|c| resolve(cwd, c)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Open a URL in the browser, or a file / folder with its default program.
/// Off the main thread: a shell call there freezes the window (see open_folder).
#[tauri::command]
pub async fn link_open(target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lower = target.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file://") {
            tauri_plugin_opener::open_url(&target, None::<&str>)
        } else {
            tauri_plugin_opener::open_path(&target, None::<&str>)
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn resolve(cwd: &Path, candidate: &str) -> Option<LinkHit> {
    let chars: Vec<char> = candidate.chars().take(MAX_LEN).collect();
    let mut ends: Vec<usize> = (1..chars.len()).filter(|&i| chars[i].is_whitespace()).collect();
    ends.push(chars.len());
    for &end in ends.iter().rev().take(MAX_ENDS) {
        let mut e = end;
        while e > 0 && (TRAILING.contains(&chars[e - 1]) || chars[e - 1].is_whitespace()) {
            e -= 1;
        }
        let text: String = chars[..e].iter().collect();
        // "src/App.tsx:42:7" → the link covers the suffix, the file is without it.
        let file = strip_line_suffix(&text);
        if let Some(path) = existing(cwd, file) {
            return Some(LinkHit { len: text.encode_utf16().count(), path: path.to_string_lossy().into_owned() });
        }
    }
    None
}

fn strip_line_suffix(s: &str) -> &str {
    let mut out = s;
    for _ in 0..2 {
        match out.rfind(':') {
            Some(i) if i + 1 < out.len() && out[i + 1..].bytes().all(|b| b.is_ascii_digit()) && i > 1 => out = &out[..i],
            _ => break,
        }
    }
    out
}

fn existing(cwd: &Path, s: &str) -> Option<PathBuf> {
    if s.is_empty() || s.chars().all(|c| c == '.' || c == '/' || c == '\\') {
        return None;
    }
    let path = if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        dirs::home_dir()?.join(rest)
    } else {
        let p = PathBuf::from(s);
        if p.is_absolute() { p } else if cwd.as_os_str().is_empty() { return None } else { cwd.join(p) }
    };
    path.exists().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_suffix() {
        assert_eq!(strip_line_suffix("src/App.tsx:42:7"), "src/App.tsx");
        assert_eq!(strip_line_suffix("src/App.tsx:42"), "src/App.tsx");
        assert_eq!(strip_line_suffix("C:\\a.png"), "C:\\a.png");
        assert_eq!(strip_line_suffix("C:"), "C:");
    }

    #[test]
    fn finds_paths_with_spaces_and_trailing_punctuation() {
        let dir = std::env::temp_dir().join("gc links test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("my file.png");
        std::fs::write(&file, b"x").unwrap();
        let full = file.to_string_lossy().into_owned();

        let hit = resolve(Path::new(""), &format!("{full}) and more words")).unwrap();
        assert_eq!(hit.len, full.encode_utf16().count());

        let hit = resolve(&dir, "my file.png.").unwrap();
        assert_eq!(hit.len, "my file.png".len());

        assert!(resolve(&dir, "missing.png").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
