//! The git state of a context's working folder, for the chip in the chat
//! header: branch, commits to push or pull, and the changes not staged yet
//! (untracked files included) with their line counts. Read only: nothing here
//! changes the repo.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::store;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    /// "A" (new, untracked), "M" or "D".
    status: &'static str,
    added: Option<u32>,
    removed: Option<u32>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// The branch, or None on a detached HEAD.
    branch: Option<String>,
    /// Short commit id of HEAD (None in a repo with no commits yet).
    head: Option<String>,
    ahead: u32,
    behind: u32,
    /// Whether the branch has an upstream (ahead/behind mean something).
    upstream: bool,
    files: Vec<GitFile>,
    last_subject: Option<String>,
    /// Unix seconds.
    last_time: Option<i64>,
}

/// At most this many untracked files get their lines counted (the rest show no count).
const COUNT_UNTRACKED: usize = 200;
/// Untracked files above this size are not read to count lines.
const COUNT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Run git in `dir`; stdout on success, stderr as the error.
fn run(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    // Never prompt, never take locks that could get in the way of the user's git.
    cmd.env("GIT_OPTIONAL_LOCKS", "0").arg("-C").arg(dir).args(args);
    store::no_window(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    run(dir, args).ok()
}

/// What the chip shows for a working folder.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    /// None when the folder is not a repo git can read.
    repo: Option<GitInfo>,
    /// A repo git refuses because another user owns it ("dubious ownership"):
    /// its path as git writes it, to add to safe.directory once the user agrees.
    untrusted: Option<String>,
}

#[tauri::command]
pub async fn git_info(dir: String) -> GitState {
    tauri::async_runtime::spawn_blocking(move || read_state(Path::new(&dir))).await.unwrap_or_default()
}

fn read_state(dir: &Path) -> GitState {
    match read(dir) {
        Ok(info) => GitState { repo: Some(info), untrusted: None },
        Err(e) => GitState { repo: None, untrusted: untrusted_path(&e) },
    }
}

/// The path in git's "detected dubious ownership in repository at '<path>'" error.
fn untrusted_path(err: &str) -> Option<String> {
    err.contains("dubious ownership").then(|| err.split('\'').nth(1).map(String::from)).flatten()
}

fn read(dir: &Path) -> Result<GitInfo, String> {
    let status = run(dir, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let mut info = parse_status(&status);
    if !info.files.is_empty() {
        let counts = git(dir, &["diff", "--numstat", "-z", "--no-renames"]).map(|s| parse_numstat(&s)).unwrap_or_default();
        let mut untracked = 0;
        for f in &mut info.files {
            if f.status == "A" {
                untracked += 1;
                if untracked <= COUNT_UNTRACKED {
                    f.added = count_lines(&dir.join(&f.path));
                    f.removed = f.added.map(|_| 0);
                }
            } else if let Some(&(a, r)) = counts.get(&f.path) {
                (f.added, f.removed) = (a, r);
            }
        }
    }
    if info.head.is_some() {
        if let Some(log) = git(dir, &["log", "-1", "--format=%s%x00%ct"]) {
            let mut it = log.trim_end().splitn(2, '\0');
            info.last_subject = it.next().map(str::to_string).filter(|s| !s.is_empty());
            info.last_time = it.next().and_then(|s| s.parse().ok());
        }
    }
    Ok(info)
}

/// `git status --porcelain=v2 --branch -z`: headers, then one record per path.
/// Keeps only what is not staged: the worktree side of tracked files, and untracked files.
fn parse_status(s: &str) -> GitInfo {
    let mut info = GitInfo::default();
    let mut recs = s.split('\0').filter(|r| !r.is_empty());
    while let Some(r) = recs.next() {
        if let Some(h) = r.strip_prefix("# ") {
            if let Some(oid) = h.strip_prefix("branch.oid ") {
                info.head = (oid != "(initial)").then(|| oid.chars().take(7).collect());
            } else if let Some(b) = h.strip_prefix("branch.head ") {
                info.branch = (b != "(detached)").then(|| b.to_string());
            } else if h.starts_with("branch.upstream ") {
                info.upstream = true;
            } else if let Some(ab) = h.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(n) = part.strip_prefix('+') {
                        info.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        info.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if let Some(p) = r.strip_prefix("? ") {
            info.files.push(GitFile { path: p.to_string(), status: "A", added: None, removed: None });
            continue;
        }
        let kind = r.as_bytes()[0];
        // "1 XY sub mH mI mW hH hI path", "2 XY ... Xscore path" + origPath, "u XY ... path".
        let fields = match kind {
            b'1' => 8,
            b'2' => 9,
            b'u' => 10,
            _ => continue,
        };
        if kind == b'2' {
            recs.next(); // the original path of a rename
        }
        let mut parts = r.splitn(fields + 1, ' ');
        let y = parts.nth(1).and_then(|xy| xy.chars().nth(1)).unwrap_or('.');
        let Some(path) = parts.nth(fields - 2) else { continue };
        let status = match y {
            '.' => continue,
            'D' => "D",
            _ => "M",
        };
        info.files.push(GitFile { path: path.to_string(), status, added: None, removed: None });
    }
    info.files.sort_by(|a, b| a.path.cmp(&b.path));
    info
}

/// `git diff --numstat -z --no-renames`: "added\tremoved\tpath\0"; binary files show "-".
fn parse_numstat(s: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    s.split('\0')
        .filter_map(|r| {
            let mut it = r.splitn(3, '\t');
            let (a, d, p) = (it.next()?, it.next()?, it.next()?);
            Some((p.to_string(), (a.parse().ok(), d.parse().ok())))
        })
        .collect()
}

/// Lines of a new text file, counted like git does (a last line without a newline counts).
fn count_lines(path: &Path) -> Option<u32> {
    if std::fs::metadata(path).ok()?.len() > COUNT_MAX_BYTES {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if data.contains(&0) {
        return None;
    }
    let n = data.iter().filter(|&&b| b == b'\n').count() + usize::from(data.last().is_some_and(|&b| b != b'\n'));
    Some(n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_unstaged_changes() {
        let s = [
            "# branch.oid f2a8800aaaabbbbccccddddeeeeffff00001111",
            "# branch.head feature/form",
            "# branch.upstream origin/feature/form",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
            "1 M. N... 100644 100644 100644 aaa bbb staged-only.ts",
            "1 MD N... 100644 100644 000000 aaa bbb gone.css",
            "2 .M N... 100644 100644 100644 aaa bbb R100 new-name.ts",
            "old-name.ts",
            "? notes/new.md",
            "",
        ]
        .join("\0");
        let info = parse_status(&s);
        assert_eq!(info.branch.as_deref(), Some("feature/form"));
        assert_eq!(info.head.as_deref(), Some("f2a8800"));
        assert_eq!((info.ahead, info.behind, info.upstream), (2, 1, true));
        let files: Vec<(&str, &str)> = info.files.iter().map(|f| (f.path.as_str(), f.status)).collect();
        assert_eq!(files, [("gone.css", "D"), ("new-name.ts", "M"), ("notes/new.md", "A"), ("src/a b.ts", "M")]);
    }

    #[test]
    fn detached_and_empty_repo() {
        let info = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((info.branch, info.head, info.upstream), (None, None, false));
    }

    #[test]
    fn finds_the_untrusted_path() {
        let err = "fatal: detected dubious ownership in repository at 'C:/DEV/repo'\n'C:/DEV/repo' is owned by:\n...";
        assert_eq!(untrusted_path(err).as_deref(), Some("C:/DEV/repo"));
        assert_eq!(untrusted_path("fatal: not a git repository"), None);
    }

    #[test]
    fn parses_numstat_with_binary() {
        let m = parse_numstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0");
        assert_eq!(m["src/a.ts"], (Some(3), Some(1)));
        assert_eq!(m["img.png"], (None, None));
    }

    #[test]
    fn reads_a_real_repo() {
        let d = std::env::temp_dir().join(format!("gc-gitinfo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&d).args(args).output().unwrap().status.success());
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "First"]);
        std::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(d.join("b.txt"), "x\ny").unwrap();
        let info = read_state(&d).repo.unwrap();
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.last_subject.as_deref(), Some("First"));
        assert_eq!(info.files, [
            GitFile { path: "a.txt".into(), status: "M", added: Some(2), removed: Some(1) },
            GitFile { path: "b.txt".into(), status: "A", added: Some(2), removed: Some(0) },
        ]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
