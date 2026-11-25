//! Copy and paste for the terminal. Text goes through the Windows clipboard;
//! an image (e.g. a screenshot) is saved as a PNG under `paste\` and the chat
//! receives its path, which Claude Code reads as an image.

use std::borrow::Cow;

use serde::Serialize;

use crate::store;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pasted {
    text: Option<String>,
    /// PNG written from an image on the clipboard.
    image_path: Option<String>,
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| format!("Cannot copy: {e}"))
}

/// What to paste: an image when the clipboard holds one (and no text),
/// otherwise its text.
#[tauri::command]
pub async fn clipboard_read() -> Result<Pasted, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let text = cb.get_text().ok().filter(|t| !t.is_empty());
        if text.is_none() {
            if let Ok(img) = cb.get_image() {
                let path = save_png(img.width, img.height, &img.bytes)?;
                return Ok(Pasted { text: None, image_path: Some(path) });
            }
        }
        Ok(Pasted { text, image_path: None })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn save_png(width: usize, height: usize, rgba: &Cow<'_, [u8]>) -> Result<String, String> {
    let dir = store::data_dir().join("paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    prune_old(&dir);
    let name = format!("screenshot-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S-%3f"));
    let path = dir.join(name);
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Pasted images are only needed while Claude reads them: drop those older than a week.
fn prune_old(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    for e in entries.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > week);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_a_valid_png() {
        let px = vec![255u8; 2 * 2 * 4];
        let path = super::save_png(2, 2, &std::borrow::Cow::Borrowed(&px)).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        std::fs::remove_file(path).unwrap();
    }
}
