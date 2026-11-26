//! Shells for the terminal panel next to Claude: which ones are installed and
//! how to start them. Each runs in a PTY like a chat (see pty.rs, `program`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Stable id saved in the context ("powershell", "pwsh", "gitbash", "cmd", "wsl").
    id: &'static str,
    available: bool,
    /// Command line to start it; empty when not available.
    argv: Vec<String>,
    /// Extra environment for it.
    env: HashMap<String, String>,
}

/// The shells the app knows, in menu order, with the ones not installed marked.
#[tauri::command]
pub async fn shells_list() -> Vec<ShellInfo> {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default()
}

fn list() -> Vec<ShellInfo> {
    let found = |id, exe: Option<PathBuf>, args: &[&str], env: &[(&str, &str)]| ShellInfo {
        id,
        available: exe.is_some(),
        argv: exe
            .map(|p| std::iter::once(p.to_string_lossy().into_owned()).chain(args.iter().map(|a| a.to_string())).collect())
            .unwrap_or_default(),
        env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    };
    vec![
        found("powershell", in_path("powershell.exe").or_else(|| Some("powershell.exe".into())), &["-NoLogo"], &[]),
        found("pwsh", in_path("pwsh.exe").or_else(|| existing(program_files().map(|p| p.join(r"PowerShell\7\pwsh.exe")))), &["-NoLogo"], &[]),
        // --login loads the user's profile; CHERE_INVOKING keeps it from moving to HOME.
        found("gitbash", git_bash(), &["--login", "-i"], &[("CHERE_INVOKING", "1")]),
        found("cmd", in_path("cmd.exe").or_else(|| Some("cmd.exe".into())), &[], &[]),
        found("wsl", in_path("wsl.exe"), &[], &[]),
    ]
}

fn existing(p: Option<PathBuf>) -> Option<PathBuf> {
    p.filter(|p| p.is_file())
}

fn program_files() -> Option<PathBuf> {
    std::env::var_os("ProgramFiles").map(PathBuf::from)
}

fn in_path(exe: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(exe)).find(|p| p.is_file())
}

/// Git for Windows' bash.exe: next to git.exe on the PATH, or in the usual install folders.
fn git_bash() -> Option<PathBuf> {
    let from_git = in_path("git.exe")
        .and_then(|git| git.parent()?.parent().map(Path::to_path_buf))
        .map(|root| root.join(r"bin\bash.exe"));
    let local = dirs::data_local_dir().map(|d| d.join(r"Programs\Git\bin\bash.exe"));
    let x86 = std::env::var_os("ProgramFiles(x86)").map(|p| PathBuf::from(p).join(r"Git\bin\bash.exe"));
    [from_git, program_files().map(|p| p.join(r"Git\bin\bash.exe")), local, x86]
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_and_cmd_are_always_listed() {
        let l = list();
        let ids: Vec<_> = l.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["powershell", "pwsh", "gitbash", "cmd", "wsl"]);
        assert!(l[0].available && l[3].available);
        assert!(l.iter().all(|s| s.available == !s.argv.is_empty()));
    }
}
