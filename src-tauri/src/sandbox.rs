//! Sandboxes: a chat detached into a separate working folder.
//!
//! For a git repo the folder is a worktree on a detached HEAD (no branch is
//! created; git only shows up later, from the "what was done" panel). Any other
//! folder is copied, and a private git repo is started in the copy so its
//! changes can be listed the same way.
//!
//! Layout: `%APPDATA%\GianClaudio\sandboxes\<context dir>\<sandbox id>\`
//! - `work\`      the sandbox folder (the worktree or the copy)
//! - `prompt.md`  the extra system prompt given to Claude in the sandbox

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::store;

/// Run git in `dir`; stdout on success, stderr as the error.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    store::no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn git_available() -> bool {
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    store::no_window(&mut cmd);
    cmd.output().is_ok_and(|o| o.status.success())
}

// ---- what to copy -----------------------------------------------------------------

/// Kind of project, from the files at its root: decides which folders are regenerated
/// (dependencies, builds, caches) and so are never worth copying.
fn project_kind(root: &Path) -> Option<&'static str> {
    let has = |f: &str| root.join(f).exists();
    let has_ext = |ext: &str| {
        std::fs::read_dir(root)
            .map(|rd| rd.flatten().any(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case(ext))))
            .unwrap_or(false)
    };
    if has("package.json") {
        Some("node")
    } else if has("Cargo.toml") {
        Some("rust")
    } else if has("pyproject.toml") || has("requirements.txt") || has("setup.py") {
        Some("python")
    } else if has_ext("csproj") || has_ext("sln") {
        Some("dotnet")
    } else if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") {
        Some("java")
    } else if has("composer.json") {
        Some("php")
    } else {
        None
    }
}

const ALWAYS_REGEN: &[&str] = &[".cache", ".git", "Thumbs.db", ".DS_Store"];

fn regen_names(kind: Option<&str>) -> &'static [&'static str] {
    match kind {
        Some("node") => &["node_modules", "dist", "build", ".next", ".nuxt", ".vite", ".turbo", ".parcel-cache", "coverage", ".svelte-kit"],
        Some("rust") => &["target"],
        Some("python") => &[".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "dist", "build"],
        Some("dotnet") => &["bin", "obj", ".vs"],
        Some("java") => &["target", "build", ".gradle"],
        Some("php") => &["vendor"],
        _ => &[],
    }
}

/// Whether a path (relative, `/`-separated) is a regenerated folder or lies inside one.
fn is_regen(rel: &str, kind: Option<&str>) -> bool {
    rel.split('/').filter(|s| !s.is_empty()).any(|seg| {
        ALWAYS_REGEN.contains(&seg) || regen_names(kind).contains(&seg) || seg.ends_with(".log")
    })
}

/// Size of a file or folder, or None when the folder is too big to measure quickly.
fn size_of(p: &Path) -> Option<u64> {
    let meta = std::fs::symlink_metadata(p).ok()?;
    if !meta.is_dir() {
        return Some(meta.len());
    }
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            seen += 1;
            if seen > 20_000 {
                return None;
            }
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else {
                total += m.len();
            }
        }
    }
    Some(total)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredEntry {
    /// Relative to the repo root (git) or the folder, `/`-separated; folders end with `/`.
    path: String,
    is_dir: bool,
    size: Option<u64>,
    /// Dependencies, builds, caches: not copied unless picked.
    regen: bool,
    /// Small config files (.env and the like): copied unless unpicked.
    preselected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxScan {
    /// The folder is inside a git repo.
    git: bool,
    /// git is installed (without it a copy has no list of changes).
    git_installed: bool,
    /// Files with uncommitted changes (git only).
    changes: usize,
    /// "node", "rust", "python", "dotnet", "java", "php" or null.
    project: Option<&'static str>,
    /// Git: files ignored by git. Plain folder: the folders that won't be copied.
    ignored: Vec<IgnoredEntry>,
    /// A repo git refuses to use because another user owns it ("dubious ownership"):
    /// its path, as git writes it, to add to safe.directory.
    untrusted: Option<String>,
}

/// What the detach dialog shows for a working folder.
#[tauri::command]
pub async fn sandbox_scan(dir: String) -> Result<SandboxScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan(Path::new(&dir))).await.map_err(|e| e.to_string())?
}

fn scan(dir: &Path) -> Result<SandboxScan, String> {
    if !dir.is_dir() {
        return Err(format!("Folder not found: {}", dir.display()));
    }
    let git_installed = git_available();
    let probe = if git_installed { Some(git(dir, &["rev-parse", "--show-toplevel"])) } else { None };
    let untrusted = match &probe {
        Some(Err(e)) if e.contains("dubious ownership") => e.split('\'').nth(1).map(String::from),
        _ => None,
    };
    let top = probe.and_then(Result::ok).map(PathBuf::from);
    let Some(top) = top else {
        // Plain folder: list the top-level folders that the copy leaves out.
        let kind = project_kind(dir);
        let mut ignored: Vec<IgnoredEntry> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let is_dir = e.path().is_dir();
                is_regen(&name, kind).then(|| IgnoredEntry {
                    path: if is_dir { format!("{name}/") } else { name },
                    is_dir,
                    size: size_of(&e.path()),
                    regen: true,
                    preselected: false,
                })
            })
            .collect();
        ignored.sort_by(|a, b| a.path.cmp(&b.path));
        return Ok(SandboxScan { git: false, git_installed, changes: 0, project: kind, ignored, untrusted });
    };
    let kind = project_kind(dir).or_else(|| project_kind(&top));
    let changes = git(&top, &["status", "--porcelain"]).map(|s| s.lines().filter(|l| !l.is_empty()).count()).unwrap_or(0);
    let list = git(&top, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]).unwrap_or_default();
    let mut ignored: Vec<IgnoredEntry> = list
        .lines()
        .filter(|l| !l.is_empty())
        .take(300)
        .map(|rel| {
            let is_dir = rel.ends_with('/');
            let regen = is_regen(rel, kind);
            let size = if regen && is_dir { None } else { size_of(&top.join(rel)) };
            let preselected = !regen && !is_dir && size.is_some_and(|s| s < 1_000_000);
            IgnoredEntry { path: rel.to_string(), is_dir, size, regen, preselected }
        })
        .collect();
    ignored.sort_by(|a, b| (a.regen, &a.path).cmp(&(b.regen, &b.path)));
    Ok(SandboxScan { git: true, git_installed, changes, project: kind, ignored, untrusted: None })
}

/// Mark a repo owned by another user as safe for git (global safe.directory), as
/// git itself suggests. Only that path, and only when the user asks.
#[tauri::command]
pub async fn sandbox_git_trust(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        cmd.args(["config", "--global", "--add", "safe.directory", &path]);
        store::no_window(&mut cmd);
        let out = cmd.output().map_err(|e| format!("git: {e}"))?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- create / remove ----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    /// The context's working folder.
    source: String,
    /// The context's folder name (groups its sandboxes on disk).
    context_dir: String,
    /// The sandbox id (also its folder name).
    id: String,
    /// Move the uncommitted changes into the sandbox (git only).
    carry: bool,
    /// Ignored files to copy (git) or regenerated folders to copy anyway (plain folder).
    copy: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    /// Working folder of the sandbox chat (inside `root`, at the same place as in the repo).
    work: String,
    /// The sandbox folder: the worktree or the copy.
    root: String,
    /// Folder of the sandbox's own files (prompt.md), parent of `root`.
    meta: String,
    /// "git" (worktree of `repo`) or "copy".
    kind: &'static str,
    /// Root of the original repo (git only).
    repo: Option<String>,
    /// Commit the sandbox starts from: its changes are measured against it.
    base: Option<String>,
}

fn sandboxes_dir() -> PathBuf {
    store::data_dir().join("sandboxes")
}

#[tauri::command]
pub async fn sandbox_create(req: CreateRequest) -> Result<Created, String> {
    tauri::async_runtime::spawn_blocking(move || create(&req, &sandboxes_dir())).await.map_err(|e| e.to_string())?
}

fn create(req: &CreateRequest, base_dir: &Path) -> Result<Created, String> {
    let source = Path::new(&req.source);
    let meta = base_dir.join(store::safe_name(&req.context_dir)).join(store::safe_name(&req.id));
    let root = meta.join("work");
    if root.exists() {
        return Err(format!("The sandbox folder already exists: {}", root.display()));
    }
    std::fs::create_dir_all(&meta).map_err(|e| e.to_string())?;
    let result = if git_available() && git(source, &["rev-parse", "--show-toplevel"]).is_ok() {
        create_worktree(req, source, &meta, &root)
    } else {
        create_copy(req, source, &meta, &root)
    };
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&meta);
    }
    result
}

fn create_worktree(req: &CreateRequest, source: &Path, meta: &Path, root: &Path) -> Result<Created, String> {
    let top = PathBuf::from(git(source, &["rev-parse", "--show-toplevel"])?);
    let prefix = git(source, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let base = git(&top, &["rev-parse", "HEAD"]).map_err(|_| "The repository has no commits yet: make a first commit, then detach.".to_string())?;
    let root_s = root.to_string_lossy().into_owned();
    git(&top, &["worktree", "add", "--detach", &root_s, "HEAD"])?;

    if req.carry && git(&top, &["status", "--porcelain"]).is_ok_and(|s| !s.trim().is_empty()) {
        // Move the changes: stash them here (untracked files too), apply them in the
        // sandbox, then drop the stash. If applying fails, they come back here.
        git(&top, &["stash", "push", "--include-untracked", "-m", &format!("Gian Claudio sandbox {}", req.id)])?;
        let sha = git(&top, &["rev-parse", "stash@{0}"])?;
        match git(root, &["stash", "apply", &sha]) {
            Ok(_) => drop_stash(&top, &sha),
            Err(e) => {
                let _ = git(&top, &["stash", "apply", &sha]).map(|_| drop_stash(&top, &sha));
                let _ = git(&top, &["worktree", "remove", "--force", &root_s]);
                return Err(format!("Couldn't move the uncommitted changes into the sandbox: {e}"));
            }
        }
    }
    for rel in &req.copy {
        let rel = rel.trim_end_matches('/');
        copy_path(&top.join(rel), &root.join(rel), &|_| true)?;
    }
    Ok(Created {
        work: root.join(prefix.trim_end_matches('/')).to_string_lossy().into_owned(),
        root: root_s,
        meta: meta.to_string_lossy().into_owned(),
        kind: "git",
        repo: Some(top.to_string_lossy().into_owned()),
        base: Some(base),
    })
}

fn drop_stash(top: &Path, sha: &str) {
    if let Ok(list) = git(top, &["stash", "list", "--format=%H"]) {
        if let Some(i) = list.lines().position(|l| l == sha) {
            let _ = git(top, &["stash", "drop", &format!("stash@{{{i}}}")]);
        }
    }
}

fn create_copy(req: &CreateRequest, source: &Path, meta: &Path, root: &Path) -> Result<Created, String> {
    let kind = project_kind(source);
    let keep: Vec<String> = req.copy.iter().map(|p| p.trim_end_matches('/').to_string()).collect();
    copy_path(source, root, &|rel: &str| keep.iter().any(|k| rel == k || rel.starts_with(&format!("{k}/"))) || !is_regen(rel, kind))?;
    // A private repo with the starting point, so the changes can be listed like in a git sandbox.
    let mut base = None;
    if git_available() {
        let exclude: String = ALWAYS_REGEN.iter().chain(regen_names(kind)).map(|n| format!("{n}/\n")).collect();
        let ok = git(root, &["init", "-q"]).is_ok()
            && std::fs::write(root.join(".git").join("info").join("exclude"), exclude).is_ok()
            && git(root, &["add", "-A"]).is_ok()
            && git(root, &["-c", "user.name=Gian Claudio", "-c", "user.email=sandbox@gianclaudio.local", "commit", "-q", "--no-verify", "--allow-empty", "-m", "Sandbox start"]).is_ok();
        if ok {
            base = git(root, &["rev-parse", "HEAD"]).ok();
        }
    }
    Ok(Created {
        work: root.to_string_lossy().into_owned(),
        root: root.to_string_lossy().into_owned(),
        meta: meta.to_string_lossy().into_owned(),
        kind: "copy",
        repo: None,
        base,
    })
}

/// Copy a file or a folder; `keep` gets each path relative to `from` (`/`-separated).
fn copy_path(from: &Path, to: &Path, keep: &dyn Fn(&str) -> bool) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
    if !meta.is_dir() {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from, to).map_err(|e| format!("{}: {e}", from.display()))?;
        return Ok(());
    }
    let mut stack = vec![(from.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        std::fs::create_dir_all(to.join(&rel)).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if !keep(&child) {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push((e.path(), child));
            } else if ft.is_file() {
                std::fs::copy(e.path(), to.join(&child)).map_err(|err| format!("{}: {err}", e.path().display()))?;
            }
        }
    }
    Ok(())
}

/// Throw a sandbox away: its worktree (or copy), its own files, and the
/// transcripts Claude Code kept for its folder (in the account's config folder).
#[tauri::command]
pub async fn sandbox_remove(meta: String, root: String, repo: Option<String>, work: Option<String>, config_dir: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = work.and_then(|w| crate::pty::transcript_path(config_dir.as_deref(), &w, "x")).and_then(|p| p.parent().map(Path::to_path_buf)) {
            // Only a folder named after a sandbox under the app's data folder.
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if name.contains("-sandboxes-") && dir.is_dir() {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        if let Some(repo) = repo.as_deref() {
            let top = Path::new(repo);
            if git(top, &["worktree", "remove", "--force", &root]).is_err() {
                let _ = git(top, &["worktree", "prune"]);
            }
        }
        let meta = Path::new(&meta);
        // Only ever delete inside the app's sandboxes folder.
        if meta.starts_with(sandboxes_dir()) && meta.exists() {
            std::fs::remove_dir_all(meta).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- what changed -----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Relative to the sandbox root, `/`-separated.
    path: String,
    /// "A" new, "M" modified, "D" deleted.
    status: &'static str,
    /// Lines added / removed; None for binary files.
    added: Option<u64>,
    removed: Option<u64>,
}

/// Files changed in the sandbox since it started (`base`), new files included.
#[tauri::command]
pub async fn sandbox_changes(root: String, base: Option<String>) -> Result<Vec<FileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || match base {
        Some(base) => changes(Path::new(&root), &base),
        None => Ok(Vec::new()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn changes(root: &Path, base: &str) -> Result<Vec<FileChange>, String> {
    let mut out: Vec<FileChange> = Vec::new();
    let status = git(root, &["diff", "--no-renames", "--name-status", base])?;
    let numstat = git(root, &["diff", "--no-renames", "--numstat", base])?;
    let counts: std::collections::HashMap<&str, (Option<u64>, Option<u64>)> = numstat
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let (a, r, path) = (p.next()?, p.next()?, p.next()?);
            Some((path, (a.parse().ok(), r.parse().ok())))
        })
        .collect();
    for l in status.lines() {
        let Some((st, path)) = l.split_once('\t') else { continue };
        let status = match st.chars().next() {
            Some('A') => "A",
            Some('D') => "D",
            _ => "M",
        };
        let (added, removed) = counts.get(path).copied().unwrap_or((None, None));
        out.push(FileChange { path: path.to_string(), status, added, removed });
    }
    // New files git doesn't track yet.
    for path in git(root, &["ls-files", "--others", "--exclude-standard"])?.lines().filter(|l| !l.is_empty()) {
        let lines = std::fs::read(root.join(path))
            .ok()
            .filter(|b| b.len() < 4_000_000 && !b.contains(&0))
            .map(|b| b.iter().filter(|&&c| c == b'\n').count() as u64 + u64::from(!b.is_empty() && b.last() != Some(&b'\n')));
        out.push(FileChange { path: path.to_string(), status: "A", added: lines, removed: lines.map(|_| 0) });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// The diff of one file since the sandbox started (a new file shows as all added).
#[tauri::command]
pub async fn sandbox_diff(root: String, base: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        if git(root, &["ls-files", "--error-unmatch", "--", &path]).is_ok() || git(root, &["cat-file", "-e", &format!("{base}:{path}")]).is_ok() {
            return git(root, &["diff", "--no-renames", &base, "--", &path]);
        }
        // Untracked: show the whole file as added.
        let bytes = std::fs::read(root.join(&path)).map_err(|e| e.to_string())?;
        if bytes.contains(&0) {
            return Ok(String::new());
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<String> = text.lines().take(3000).map(|l| format!("+{l}")).collect();
        Ok(format!("@@ -0,0 +1,{} @@\n{}", lines.len(), lines.join("\n")))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRequest {
    root: String,
    base: String,
    meta: String,
    /// The sandbox chat: asked in a throwaway fork, so it knows why things changed.
    session_id: String,
    cwd: String,
    config_dir: Option<String>,
    api_key_account: Option<String>,
    model: String,
    /// "Italian" or "English": the language of the summary.
    language: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSummary {
    text: String,
    /// Unix ms.
    at: u64,
    /// The starting point it describes the changes from (stale once changes are applied).
    #[serde(default)]
    base: String,
}

fn summary_path(meta: &str) -> PathBuf {
    Path::new(meta).join("summary.json")
}

/// The last summary written for the sandbox, if any.
#[tauri::command]
pub fn sandbox_summary_read(meta: String) -> Option<SandboxSummary> {
    serde_json::from_str(&std::fs::read_to_string(summary_path(&meta)).ok()?).ok()
}

/// Ask Claude for a short summary of what changed in the sandbox, and keep it.
#[tauri::command]
pub async fn sandbox_summary(req: SummaryRequest) -> Result<Option<SandboxSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&req.root);
        let _ = git(root, &["add", "-A", "--intent-to-add"]);
        let stat = git(root, &["diff", "--stat", &req.base]).unwrap_or_default();
        if stat.trim().is_empty() {
            return Ok(None);
        }
        let prompt = format!(
            "In 2 or 3 sentences, in {}, summarize what was changed in this folder during this chat and why. \
             Plain prose for the user: no headings, no lists, no file-by-file detail. The changed files:\n\n{stat}",
            req.language
        );
        let text = crate::history::ask_session(&req.session_id, &req.cwd, req.config_dir.as_deref(), req.api_key_account.as_deref(), &req.model, &prompt);
        let Some(text) = text else { return Ok(None) };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let summary = SandboxSummary { text, at, base: req.base.clone() };
        let _ = std::fs::write(summary_path(&req.meta), serde_json::to_string(&summary).unwrap_or_default());
        Ok(Some(summary))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    root: String,
    base: String,
    meta: String,
    /// Where the changes go: the repo root (git) or the original folder (copy).
    target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// The sandbox's new starting point: what was applied no longer counts as its changes.
    base: String,
    /// Files changed in the original too: merged with conflict markers, or (when they
    /// can't be merged) left as they were with the sandbox's version next to them.
    conflicts: Vec<String>,
}

/// Bring the sandbox's changes into the context's folder as plain uncommitted
/// changes: nothing is committed or staged there. File by file: when the original
/// didn't change, the sandbox's version is taken; when both changed, they're
/// merged (git merge-file) with conflict markers where they clash.
#[tauri::command]
pub async fn sandbox_apply(req: ApplyRequest) -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(move || apply(&req)).await.map_err(|e| e.to_string())?
}

/// Like `git`, but the raw bytes (file contents).
fn git_bytes(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    store::no_window(&mut cmd);
    cmd.output().ok().filter(|o| o.status.success()).map(|o| o.stdout)
}

/// Three-way merge of text; the merged text and whether it has conflicts.
fn merge_text(tmp: &Path, ours: &[u8], base: &[u8], theirs: &[u8]) -> Result<(Vec<u8>, bool), String> {
    std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;
    let (o, b, t) = (tmp.join("ours"), tmp.join("base"), tmp.join("theirs"));
    for (p, data) in [(&o, ours), (&b, base), (&t, theirs)] {
        std::fs::write(p, data).map_err(|e| e.to_string())?;
    }
    let mut cmd = Command::new("git");
    cmd.args(["merge-file", "-p", "-L", "original", "-L", "start", "-L", "sandbox"]).arg(&o).arg(&b).arg(&t);
    store::no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("git: {e}"))?;
    // Exit code: 0 clean, >0 number of conflicts, <0 error.
    match out.status.code() {
        Some(0) => Ok((out.stdout, false)),
        Some(n) if n > 0 => Ok((out.stdout, true)),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

fn apply(req: &ApplyRequest) -> Result<Applied, String> {
    let root = Path::new(&req.root);
    let target = Path::new(&req.target);
    git(root, &["add", "-A"])?;
    let list = git(root, &["diff", "--cached", "--name-status", "--no-renames", &req.base])?;
    if list.trim().is_empty() {
        return Ok(Applied { base: req.base.clone(), conflicts: Vec::new() });
    }
    let tmp = Path::new(&req.meta).join("merge");
    let write = |p: &Path, data: Option<&[u8]>| -> Result<(), String> {
        match data {
            Some(d) => {
                if let Some(dir) = p.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(p, d).map_err(|e| format!("{}: {e}", p.display()))
            }
            None if p.exists() => std::fs::remove_file(p).map_err(|e| format!("{}: {e}", p.display())),
            None => Ok(()),
        }
    };
    let mut conflicts = Vec::new();
    for line in list.lines() {
        let Some((st, path)) = line.split_once('\t') else { continue };
        let theirs = if st.starts_with('D') { None } else { Some(std::fs::read(root.join(path)).map_err(|e| e.to_string())?) };
        let base = if st.starts_with('A') { None } else { git_bytes(root, &["cat-file", "--filters", &format!("{}:{path}", req.base)]) };
        let dest = target.join(path);
        let ours = std::fs::read(&dest).ok();
        if ours == base {
            write(&dest, theirs.as_deref())?;
        } else if ours == theirs {
            continue;
        } else if let (Some(o), Some(b), Some(t)) = (&ours, &base, &theirs) {
            if [o, b, t].iter().all(|d| !d.contains(&0)) {
                let (merged, clash) = merge_text(&tmp, o, b, t)?;
                write(&dest, Some(&merged))?;
                if clash {
                    conflicts.push(path.to_string());
                }
                continue;
            }
            // Binary on both sides: keep the original's, put the sandbox's next to it.
            write(Path::new(&format!("{}.sandbox", dest.display())), Some(t))?;
            conflicts.push(path.to_string());
        } else {
            // Added on both sides, or deleted on one side and changed on the other.
            if let Some(t) = &theirs {
                write(Path::new(&format!("{}.sandbox", dest.display())), Some(t))?;
            }
            conflicts.push(path.to_string());
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);

    // Start the sandbox's changes over from here.
    git(root, &["-c", "user.name=Gian Claudio", "-c", "user.email=sandbox@gianclaudio.local", "commit", "-q", "--no-verify", "-m", "Applied to the original folder"])?;
    let base = git(root, &["rev-parse", "HEAD"])?;
    Ok(Applied { base, conflicts })
}

// ---- branch and commit (git sandboxes) ------------------------------------------------

fn git_cfg(dir: &Path, key: &str) -> Option<String> {
    git(dir, &["config", "--get", key]).ok().filter(|s| !s.is_empty())
}

fn command_exists(exe: &str) -> bool {
    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    store::no_window(&mut cmd);
    cmd.output().is_ok_and(|o| o.status.success())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    name: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    author_name: String,
    author_email: String,
    /// Where the author comes from: "local" (this repo), "global" or "system".
    author_source: Option<String>,
    remotes: Vec<Remote>,
    sign: bool,
    /// The branch the repo is on now: the target of a pull request.
    current_branch: Option<String>,
    /// GitHub CLI is installed (for pull requests).
    gh: bool,
    /// Short id of the commit the branch starts from.
    start_short: String,
}

/// What the "create a branch" dialog shows: git's own configuration for the repo.
#[tauri::command]
pub async fn sandbox_git_info(repo: String, start: String) -> Result<GitInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = Path::new(&repo);
        let origin = git(repo, &["config", "--show-scope", "--get", "user.email"]).ok().and_then(|s| s.split_whitespace().next().map(String::from));
        let remotes = git(repo, &["remote"]).unwrap_or_default().lines().filter(|l| !l.is_empty())
            .map(|name| Remote { name: name.to_string(), url: git(repo, &["remote", "get-url", name]).unwrap_or_default() })
            .collect();
        let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| b != "HEAD");
        Ok(GitInfo {
            author_name: git_cfg(repo, "user.name").unwrap_or_default(),
            author_email: git_cfg(repo, "user.email").unwrap_or_default(),
            author_source: origin,
            remotes,
            sign: git_cfg(repo, "commit.gpgsign").is_some_and(|v| v == "true"),
            current_branch: branch,
            gh: command_exists("gh"),
            start_short: git(repo, &["rev-parse", "--short", &start]).unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRequest {
    root: String,
    start: String,
    repo: String,
    session_id: String,
    cwd: String,
    config_dir: Option<String>,
    api_key_account: Option<String>,
    model: String,
}

/// A commit message proposed by Claude, in the style of the repo's recent commits.
#[tauri::command]
pub async fn sandbox_commit_message(req: MessageRequest) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&req.root);
        let _ = git(root, &["add", "-A", "--intent-to-add"]);
        let stat = git(root, &["diff", "--stat", &req.start]).unwrap_or_default();
        if stat.trim().is_empty() {
            return Ok(None);
        }
        let recent = git(Path::new(&req.repo), &["log", "-8", "--format=%s"]).unwrap_or_default();
        let prompt = format!(
            "Write the git commit message for the changes made in this chat. Reply with the message only: \
             a subject line of at most 72 characters, a blank line, then a short body. No quotes, no code fences. \
             Match the language and style of the repository's recent subjects:\n{recent}\n\nThe changed files:\n{stat}"
        );
        let text = crate::history::ask_session(&req.session_id, &req.cwd, req.config_dir.as_deref(), req.api_key_account.as_deref(), &req.model, &prompt);
        Ok(text.map(|t| t.trim().trim_matches('`').trim().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRequest {
    root: String,
    repo: String,
    /// Commit the sandbox started from.
    start: String,
    /// Branch already made from this sandbox: the commit goes on top of it.
    existing: Option<String>,
    branch: String,
    message: String,
    author_name: String,
    author_email: String,
    sign: bool,
    /// Remote to push to; None = no push.
    push: Option<String>,
    /// Open a pull request with gh, towards this branch.
    pr_base: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDone {
    branch: String,
    commit: String,
    pushed: bool,
    pr_url: Option<String>,
    /// What went wrong after the commit was made (push or pull request).
    warning: Option<String>,
}

/// Commit the sandbox's whole content on a branch of the repo, without touching
/// the context's folder or the sandbox (git plumbing: write-tree + commit-tree).
/// Author and signing are passed for this commit only (`git -c`), so neither the
/// repo's configuration nor the global one changes. Then push and pull request.
#[tauri::command]
pub async fn sandbox_branch(req: BranchRequest) -> Result<BranchDone, String> {
    tauri::async_runtime::spawn_blocking(move || branch(&req)).await.map_err(|e| e.to_string())?
}

fn branch(req: &BranchRequest) -> Result<BranchDone, String> {
    let root = Path::new(&req.root);
    let repo = Path::new(&req.repo);
    let name = req.existing.clone().unwrap_or_else(|| req.branch.trim().to_string());
    if name.is_empty() || git(repo, &["check-ref-format", "--branch", &name]).is_err() {
        return Err(format!("\"{name}\" is not a valid branch name."));
    }
    let parent = match &req.existing {
        Some(b) => git(repo, &["rev-parse", &format!("refs/heads/{b}")]).map_err(|_| format!("The branch {b} no longer exists."))?,
        None => {
            if git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok() {
                return Err(format!("A branch named {name} already exists."));
            }
            req.start.clone()
        }
    };
    git(root, &["add", "-A"])?;
    let tree = git(root, &["write-tree"])?;
    if git(repo, &["rev-parse", &format!("{parent}^{{tree}}")]).is_ok_and(|t| t == tree) {
        return Err("Nothing new to commit since the last time.".into());
    }
    let msg_file = std::env::temp_dir().join(format!("gc-commit-{}.txt", std::process::id()));
    std::fs::write(&msg_file, req.message.trim()).map_err(|e| e.to_string())?;
    let user_name = format!("user.name={}", req.author_name);
    let user_email = format!("user.email={}", req.author_email);
    let mut args = vec!["-c", &user_name, "-c", &user_email, "commit-tree", &tree, "-p", &parent, "-F"];
    let msg_path = msg_file.to_string_lossy().into_owned();
    args.push(&msg_path);
    if req.sign {
        args.push("-S");
    }
    let commit = git(root, &args);
    let _ = std::fs::remove_file(&msg_file);
    let commit = commit?;
    git(repo, &["update-ref", &format!("refs/heads/{name}"), &commit])?;

    let mut done = BranchDone { branch: name.clone(), commit: commit.chars().take(7).collect(), pushed: false, pr_url: None, warning: None };
    if let Some(remote) = &req.push {
        match git(repo, &["push", "-u", remote, &name]) {
            Ok(_) => done.pushed = true,
            Err(e) => {
                done.warning = Some(format!("The branch was created, but the push failed: {e}"));
                return Ok(done);
            }
        }
    }
    if let (Some(base), true) = (&req.pr_base, done.pushed) {
        let (subject, body) = req.message.trim().split_once('\n').unwrap_or((req.message.trim(), ""));
        let mut cmd = Command::new("gh");
        cmd.current_dir(repo).args(["pr", "create", "--head", &name, "--base", base, "--title", subject.trim(), "--body", body.trim()]);
        store::no_window(&mut cmd);
        match cmd.output() {
            Ok(o) if o.status.success() => done.pr_url = String::from_utf8_lossy(&o.stdout).lines().rev().find(|l| l.starts_with("http")).map(String::from),
            Ok(o) => done.warning = Some(format!("Pushed, but the pull request failed: {}", String::from_utf8_lossy(&o.stderr).trim())),
            Err(e) => done.warning = Some(format!("Pushed, but the pull request failed: {e}")),
        }
    }
    Ok(done)
}

// ---- the sandbox's copy of the chat -------------------------------------------------

/// The ways a Windows path appears inside a transcript line (JSON-escaped):
/// as is, with a lowercase drive, with forward slashes, and as /c/… (Git Bash).
fn path_forms(p: &str) -> Vec<String> {
    let lower_drive = |s: &str| {
        let mut c = s.chars();
        c.next().map(|d| d.to_ascii_lowercase().to_string() + c.as_str()).unwrap_or_default()
    };
    let fwd = p.replace('\\', "/");
    let posix = format!("/{}", lower_drive(&fwd).replacen(':', "", 1));
    [p.to_string(), lower_drive(p), fwd.clone(), lower_drive(&fwd), posix]
        .iter()
        .map(|f| serde_json::to_string(f).unwrap_or_default().trim_matches('"').to_string())
        .collect()
}

/// Replace `from` with `to` where it is a whole path: not followed by more of a name
/// (so C:\proj doesn't touch C:\proj-old).
fn replace_path(line: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find(from) {
        let after = rest[i + from.len()..].chars().next();
        out.push_str(&rest[..i]);
        if after.is_some_and(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
            out.push_str(from);
        } else {
            out.push_str(to);
        }
        rest = &rest[i + from.len()..];
    }
    out.push_str(rest);
    out
}

/// Give the sandbox its own copy of the chat, as if it had always been there:
/// the parent's transcript under the sandbox folder, with the new session id
/// and every mention of the original folder pointing to the sandbox. Resuming
/// it, Claude Code sees no change of folder, so Claude has nothing to point out.
/// False when the parent's transcript isn't there (the app then forks instead).
#[tauri::command]
pub fn sandbox_fork(config_dir: Option<String>, original: String, parent_session: String, work: String, session: String) -> Result<bool, String> {
    let (Some(src), Some(dst)) = (
        crate::pty::transcript_path(config_dir.as_deref(), &original, &parent_session),
        crate::pty::transcript_path(config_dir.as_deref(), &work, &session),
    ) else {
        return Ok(false);
    };
    if dst.exists() {
        return Ok(true);
    }
    let Ok(raw) = std::fs::read_to_string(&src) else { return Ok(false) };
    let pairs: Vec<(String, String)> = path_forms(&original).into_iter().zip(path_forms(&work)).collect();
    let mut text = String::with_capacity(raw.len() + raw.len() / 8);
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let mut l = line.replace(&parent_session, &session);
        for (from, to) in &pairs {
            l = replace_path(&l, from, to);
        }
        // Keep the line as it was if the rewrite broke it (it shouldn't).
        let keep = if serde_json::from_str::<serde_json::Value>(&l).is_ok() { l } else { line.replace(&parent_session, &session) };
        text.push_str(&keep);
        text.push('\n');
    }
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dst, text).map_err(|e| e.to_string())?;
    Ok(true)
}

/// The system prompt for the sandbox chat: the context's one plus where it now works.
#[tauri::command]
pub fn sandbox_prompt_file(meta: String, base_prompt: Option<String>, original: String, work: String) -> Result<String, String> {
    let mut text = base_prompt.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    text.push_str(&format!(
        "\n\n# Sandbox\n\n\
        The user detached this chat into a sandbox on purpose: {work} is a copy of the project \
        at {original}, made so you can work on it separately. You will see a note that the working \
        directory changed from {original} to {work}: that is expected and needs no comment.\n\n\
        - For you, {work} *is* the project. Do every request there exactly as you would have done \
        it in the original, without asking where, and answer as if nothing had changed.\n\
        - Never create or modify files in {original}, never offer to, and don't mention {original}, \
        the move or the sandbox in your answers unless the user asks about them. The user brings the \
        changes back to the original from Gian Claudio when they want to.\n\
        - Earlier messages may refer to paths in {original}: use the matching path inside {work}.\n\
        - Files ignored by git (dependencies, build output) may be missing here: reinstall or rebuild \
        them inside {work} when needed.\n"
    ));
    let path = Path::new(&meta).join("prompt.md");
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gc-sandbox-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fork_copy_rewrites_the_folder_and_the_session() {
        let cfg = tmp("fork-cfg");
        let cfg_s = cfg.to_string_lossy().into_owned();
        let (orig, work) = (r"C:\DEV\proj", r"C:\data\sandboxes\p\1\work");
        let src = crate::pty::transcript_path(Some(&cfg_s), orig, "aaa").unwrap();
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        let lines = [
            r#"{"sessionId":"aaa","cwd":"C:\\DEV\\proj","text":"Primary working directory: C:\\DEV\\proj\\src"}"#,
            r#"{"sessionId":"aaa","cwd":"/c/DEV/proj","other":"C:\\DEV\\proj-old stays","fwd":"C:/DEV/proj/x"}"#,
        ];
        std::fs::write(&src, lines.join("\n")).unwrap();
        assert!(sandbox_fork(Some(cfg_s.clone()), orig.into(), "aaa".into(), work.into(), "bbb".into()).unwrap());
        let dst = crate::pty::transcript_path(Some(&cfg_s), work, "bbb").unwrap();
        let out = std::fs::read_to_string(dst).unwrap();
        assert!(!out.contains("\"aaa\"") && out.contains("\"bbb\""));
        assert!(out.contains(r"C:\\data\\sandboxes\\p\\1\\work\\src") && out.contains("/c/data/sandboxes/p/1/work"));
        assert!(out.contains(r"C:\\DEV\\proj-old stays") && out.contains("C:/data/sandboxes/p/1/work/x"));
        assert!(!sandbox_fork(Some(cfg_s), orig.into(), "missing".into(), work.into(), "ccc".into()).unwrap());
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn regen_folders_depend_on_the_project() {
        assert!(is_regen("node_modules/", Some("node")));
        assert!(is_regen("packages/app/node_modules/", Some("node")));
        assert!(!is_regen(".env", Some("node")));
        assert!(is_regen("target/", Some("rust")));
        assert!(!is_regen("target/", Some("node")));
        assert!(is_regen("debug.log", None));
    }

    #[test]
    fn git_sandbox_moves_changes_and_copies_picked_ignored_files() {
        if !git_available() {
            return;
        }
        let repo = tmp("repo");
        let sbx = tmp("store");
        let run = |args: &[&str]| git(&repo, args).unwrap();
        run(&["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        std::fs::write(repo.join(".gitignore"), ".env\nnode_modules/\n").unwrap();
        std::fs::write(repo.join("package.json"), "{}").unwrap();
        run(&["add", "-A"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        std::fs::write(repo.join(".env"), "KEY=1\n").unwrap();
        std::fs::create_dir_all(repo.join("node_modules/x")).unwrap();
        std::fs::write(repo.join("node_modules/x/i.js"), "").unwrap();

        let s = scan(&repo).unwrap();
        assert!(s.git && s.changes == 2 && s.project == Some("node"));
        let env = s.ignored.iter().find(|e| e.path == ".env").unwrap();
        assert!(env.preselected && !env.regen);
        assert!(s.ignored.iter().find(|e| e.path == "node_modules/").unwrap().regen);

        let req = CreateRequest { source: repo.to_string_lossy().into(), context_dir: "ctx".into(), id: "s1".into(), carry: true, copy: vec![".env".into()] };
        let c = create(&req, &sbx).unwrap();
        let root = Path::new(&c.root);
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap().trim(), "two");
        assert!(root.join("new.txt").exists() && root.join(".env").exists());
        assert!(!root.join("node_modules").exists());
        // The original is back to the last commit, its ignored files untouched.
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap().trim(), "one");
        assert!(!repo.join("new.txt").exists() && repo.join(".env").exists());
        assert_eq!(git(&repo, &["stash", "list"]).unwrap(), "");

        // The carried changes count as the sandbox's: a.txt modified, new.txt new.
        std::fs::remove_file(root.join("package.json")).unwrap();
        let ch = changes(root, c.base.as_deref().unwrap()).unwrap();
        let st: Vec<(&str, &str)> = ch.iter().map(|f| (f.path.as_str(), f.status)).collect();
        assert_eq!(st, [("a.txt", "M"), ("new.txt", "A"), ("package.json", "D")]);
        assert_eq!((ch[0].added, ch[0].removed), (Some(1), Some(1)));
        assert_eq!(ch[1].added, Some(1));

        // Apply: the changes land in the original, uncommitted; the sandbox starts over.
        std::fs::write(root.join("package.json"), "{}").unwrap(); // undo the deletion above
        let a = apply(&ApplyRequest {
            root: c.root.clone(), base: c.base.clone().unwrap(), meta: c.meta.clone(),
            target: c.repo.clone().unwrap(),
        }).unwrap();
        assert!(a.conflicts.is_empty());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap().trim(), "two");
        assert!(repo.join("new.txt").exists());
        assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]).unwrap(), "", "nothing staged in the original");
        assert!(changes(root, &a.base).unwrap().is_empty());

        // The same file changed on both sides: merged with conflict markers, still unstaged.
        run(&["add", "-A"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "applied"]);
        std::fs::write(repo.join("a.txt"), "three\n").unwrap();
        std::fs::write(root.join("a.txt"), "four\n").unwrap();
        let b = apply(&ApplyRequest { root: c.root.clone(), base: a.base.clone(), meta: c.meta.clone(), target: c.repo.clone().unwrap() }).unwrap();
        assert_eq!(b.conflicts, ["a.txt"]);
        let merged = std::fs::read_to_string(repo.join("a.txt")).unwrap();
        assert!(merged.contains("<<<<<<<") && merged.contains("three") && merged.contains("four"));
        assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]).unwrap(), "");

        // Branch: one commit with the sandbox's content on top of where it started;
        // the original folder and the sandbox stay as they are.
        let before = std::fs::read_to_string(repo.join("a.txt")).unwrap();
        let req = |existing: Option<String>, msg: &str| BranchRequest {
            root: c.root.clone(), repo: c.repo.clone().unwrap(), start: c.base.clone().unwrap(), existing,
            branch: "feature/sandbox-test".into(), message: msg.into(), author_name: "Someone".into(),
            author_email: "someone@example.com".into(), sign: false, push: None, pr_base: None,
        };
        let d = branch(&req(None, "Add things\n\nBody")).unwrap();
        assert_eq!(git(&repo, &["show", "-s", "--format=%an|%s", "feature/sandbox-test"]).unwrap(), "Someone|Add things");
        assert_eq!(git(&repo, &["show", "feature/sandbox-test:a.txt"]).unwrap().trim(), "four");
        assert_eq!(git(&repo, &["rev-parse", "feature/sandbox-test^"]).unwrap(), c.base.clone().unwrap());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), before);
        assert_eq!(git(&repo, &["config", "--local", "--get", "user.name"]).ok(), None, "no config written");
        assert!(branch(&req(None, "again")).is_err(), "the name is taken");
        assert!(branch(&req(Some("feature/sandbox-test".into()), "x")).is_err(), "nothing new");
        std::fs::write(root.join("b.txt"), "more\n").unwrap();
        let d2 = branch(&req(Some("feature/sandbox-test".into()), "More")).unwrap();
        assert_eq!(git(&repo, &["rev-parse", "--short=7", "feature/sandbox-test^"]).unwrap(), d.commit);
        assert_ne!(d2.commit, d.commit);

        let _ = git(&repo, &["worktree", "remove", "--force", &c.root]);
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&sbx);
    }

    #[test]
    fn plain_folder_is_copied_without_regenerated_folders() {
        let src = tmp("plain");
        let sbx = tmp("plain-store");
        std::fs::write(src.join("Cargo.toml"), "").unwrap();
        std::fs::create_dir_all(src.join("src")).unwrap();
        std::fs::write(src.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::create_dir_all(src.join("target/debug")).unwrap();
        std::fs::write(src.join("target/debug/x"), "bin").unwrap();

        let s = scan(&src).unwrap();
        if s.git {
            return; // temp folder inside some repo: nothing to test here
        }
        assert!(s.ignored.iter().any(|e| e.path == "target/" && e.regen));
        let req = CreateRequest { source: src.to_string_lossy().into(), context_dir: "ctx".into(), id: "p1".into(), carry: false, copy: vec![] };
        let c = create(&req, &sbx).unwrap();
        let root = Path::new(&c.root);
        assert!(root.join("src/main.rs").exists() && !root.join("target").exists());
        assert_eq!(c.kind, "copy");
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&sbx);
    }
}
