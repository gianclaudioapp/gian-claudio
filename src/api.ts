// Typed wrappers around the Rust commands (src-tauri/src).
import { invoke } from "@tauri-apps/api/core";
import { AppState, HistoryEntry, normalize, seedState } from "./model";
import type { SessionUsage } from "./pricing";

export interface ContextLine {
  contextPct: number | null;
  contextSize: number | null;
  model: string | null;
  ts: number;
}

export interface LimitWindow {
  pct: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface AccountLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  ts: number;
}

/** A shell for the terminal panel (see shells.rs). */
export interface ShellInfo {
  id: string;
  available: boolean;
  argv: string[];
  env: Record<string, string>;
}

export interface IgnoredEntry { path: string; isDir: boolean; size: number | null; regen: boolean; preselected: boolean }
export interface SandboxScan { git: boolean; gitInstalled: boolean; changes: number; project: string | null; ignored: IgnoredEntry[]; untrusted: string | null }
export interface SandboxCreated { work: string; root: string; meta: string; kind: "git" | "copy"; repo: string | null; base: string | null }

export interface GitInfo {
  authorName: string; authorEmail: string; authorSource: string | null;
  remotes: { name: string; url: string }[]; sign: boolean; currentBranch: string | null; gh: boolean; startShort: string;
}
export interface BranchDone { branch: string; commit: string; pushed: boolean; prUrl: string | null; warning: string | null }
/** What a chat's hooks last reported (see status.rs). */
export interface HookStatus {
  state: string;
  ts: number;
  /** When the state began. */
  since: number;
  tool: string | null;
  detail: string | null;
  message: string | null;
}
export interface SandboxSummary { text: string; at: number; base: string }
export interface FileChange { path: string; status: "A" | "M" | "D"; added: number | null; removed: number | null }

export const api = {
  sandboxDiff: (root: string, base: string, path: string) => invoke<string>("sandbox_diff", { root, base, path }).catch(() => ""),
  sandboxSummaryRead: (meta: string) => invoke<SandboxSummary | null>("sandbox_summary_read", { meta }).catch(() => null),
  sandboxSummary: (req: { root: string; base: string; meta: string; sessionId: string; cwd: string; configDir: string | null; apiKeyAccount: string | null; model: string; language: string }) =>
    invoke<SandboxSummary | null>("sandbox_summary", { req }),
  sandboxApply: (req: { root: string; base: string; meta: string; target: string }) => invoke<{ base: string; conflicts: string[] }>("sandbox_apply", { req }),
  sandboxFork: (configDir: string | null, original: string, parentSession: string, work: string, session: string) =>
    invoke<boolean>("sandbox_fork", { configDir, original, parentSession, work, session }).catch(() => false),
  sandboxGitInfo: (repo: string, start: string) => invoke<GitInfo>("sandbox_git_info", { repo, start }),
  sandboxCommitMessage: (req: { root: string; start: string; repo: string; sessionId: string; cwd: string; configDir: string | null; apiKeyAccount: string | null; model: string }) =>
    invoke<string | null>("sandbox_commit_message", { req }).catch(() => null),
  sandboxBranch: (req: {
    root: string; repo: string; start: string; existing: string | null; branch: string; message: string;
    authorName: string; authorEmail: string; sign: boolean; push: string | null; prBase: string | null;
  }) => invoke<BranchDone>("sandbox_branch", { req }),
  sandboxChanges: (root: string, base: string | null) => invoke<FileChange[]>("sandbox_changes", { root, base }).catch(() => [] as FileChange[]),
  sandboxScan: (dir: string) => invoke<SandboxScan>("sandbox_scan", { dir }),
  gitTrust: (path: string) => invoke("sandbox_git_trust", { path }),
  sandboxCreate: (req: { source: string; contextDir: string; id: string; carry: boolean; copy: string[] }) =>
    invoke<SandboxCreated>("sandbox_create", { req }),
  sandboxRemove: (meta: string, root: string, repo: string | null, work: string, configDir: string | null) =>
    invoke("sandbox_remove", { meta, root, repo, work, configDir }),
  sandboxPromptFile: (meta: string, basePrompt: string | null, original: string, work: string) =>
    invoke<string>("sandbox_prompt_file", { meta, basePrompt, original, work }).catch(() => null),
  shellsList: () => invoke<ShellInfo[]>("shells_list").catch(() => [] as ShellInfo[]),
  paths: () => invoke<{ dataDir: string; homeDir: string }>("app_paths").catch(() => ({ dataDir: "", homeDir: "" })),

  async loadState(): Promise<AppState> {
    const raw = await invoke<string | null>("state_load").catch(() => null);
    if (raw) {
      try {
        return normalize(JSON.parse(raw));
      } catch {
        /* fall through */
      }
    }
    // First run of this version: take over the state the first prototype kept in localStorage.
    try {
      const legacy = localStorage.getItem("gian-claudio/state/v1");
      if (legacy) return normalize(JSON.parse(legacy));
    } catch {
      /* ignore */
    }
    return seedState();
  },
  saveState: (s: AppState) => invoke("state_save", { json: JSON.stringify(s, null, 2) }),

  sessionExists: (configDir: string | null, cwd: string, sessionId: string) =>
    invoke<boolean>("session_exists", { configDir, cwd, sessionId }).catch(() => false),

  accountDir: (id: string) => invoke<string>("account_dir", { id }),
  accountStatus: (id: string, kind: string, configDir: string | null) =>
    invoke<boolean>("account_status", { id, kind, configDir }).catch(() => false),
  apiKeySet: (id: string, key: string) => invoke("apikey_set", { id, key }),
  accountRemove: (id: string, configDir: string | null) => invoke("account_remove", { id, configDir }),

  contextRemoveFiles: (dirName: string) => invoke("context_remove_files", { dirName }),
  openFolder: (path: string) => invoke("open_folder", { path }),
  revealFile: (path: string) => invoke("reveal_file", { path }),
  claudeCheck: () => invoke<string | null>("claude_check").catch(() => null),
  /** Latest published Claude Code version, or null when offline. */
  claudeLatest: () => invoke<string | null>("claude_latest").catch(() => null),
  /** Titles Claude Code wrote in the transcripts, by session id. */
  sessionTitles: (items: { configDir: string | null; cwd: string; sessionId: string }[]) =>
    items.length ? invoke<Record<string, string>>("session_titles", { items }).catch((): Record<string, string> => ({})) : Promise.resolve({} as Record<string, string>),

  historySave: (req: {
    contextDir: string; sessionId: string; name: string; cwd: string;
    configDir: string | null; apiKeyAccount: string | null; summaryModel: string;
    /** Language the summary is written in: "en" or "it". */
    language: string;
  }) => invoke<string | null>("history_save", { req }),
  historyList: (contextDir: string) => invoke<HistoryEntry[]>("history_list", { contextDir }).catch(() => []),
  transcriptRead: (configDir: string | null, cwd: string, sessionId: string) =>
    invoke<string | null>("transcript_read", { configDir, cwd, sessionId }).catch(() => null),
  historyReadFile: (path: string) => invoke<string>("history_read_file", { path }),
  historySetImportant: (req: { path: string; important: boolean; apiKeyAccount: string | null; model: string; language: string }) =>
    invoke<HistoryEntry>("history_set_important", { req }),
  /** Writes the summaries handed to a new chat; returns the file path. */
  contextPromptFile: (contextDir: string) => invoke<string>("context_prompt_file", { contextDir }).catch(() => null),
  historySearch: (query: string) =>
    invoke<{ contextDir: string; entry: HistoryEntry; snippet: string }[]>("history_search", { query, limit: 200 }).catch(() => []),

  /** Hooks settings for a session (passed as `claude --settings`). */
  statusSettingsFile: (ptyId: string, accountId: string) =>
    invoke<string>("status_settings_file", { ptyId, accountId }).catch(() => null),
  /** Context fill per session, from Claude Code's status line. */
  statusLineRead: (ids: string[]) =>
    invoke<Record<string, ContextLine>>("status_line_read", { ids }).catch(() => ({}) as Record<string, ContextLine>),
  /** Plan usage limits per account (Pro/Max/Ultra), last reported by Claude Code. */
  accountLimitsRead: (ids: string[]) =>
    invoke<Record<string, AccountLimits>>("account_limits_read", { ids }).catch(() => ({}) as Record<string, AccountLimits>),
  /** Tokens the chat's context held at its first request (system prompt, tools, memory). */
  contextBase: (item: { configDir: string | null; cwd: string; sessionId: string }) =>
    invoke<number | null>("context_base", { item }).catch(() => null),
  usageSessions: (items: { configDir: string | null; cwd: string; sessionId: string }[], since: string | null) =>
    invoke<SessionUsage[]>("usage_sessions", { items, since }).catch(() => [] as SessionUsage[]),
  statusRead: (ids: string[]) => invoke<Record<string, HookStatus>>("status_read", { ids }).catch(() => ({}) as Record<string, HookStatus>),
  notify: (title: string, body: string) => invoke("notify", { title, body }).catch(() => {}),
  setCloseToTray: (enabled: boolean) => invoke("set_close_to_tray", { enabled }).catch(() => {}),
  autostartGet: () => invoke<boolean>("autostart_get").catch(() => false),
  autostartSet: (enabled: boolean) => invoke("autostart_set", { enabled }),
  quit: () => invoke("quit_app").catch(() => {}),
};
