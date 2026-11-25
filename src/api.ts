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

export const api = {
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
  usageSessions: (items: { configDir: string | null; cwd: string; sessionId: string }[], since: string | null) =>
    invoke<SessionUsage[]>("usage_sessions", { items, since }).catch(() => [] as SessionUsage[]),
  statusRead: (ids: string[]) => invoke<Record<string, { state: string; ts: number }>>("status_read", { ids }).catch(() => ({}) as Record<string, { state: string; ts: number }>),
  notify: (title: string, body: string) => invoke("notify", { title, body }).catch(() => {}),
  setCloseToTray: (enabled: boolean) => invoke("set_close_to_tray", { enabled }).catch(() => {}),
  autostartGet: () => invoke<boolean>("autostart_get").catch(() => false),
  autostartSet: (enabled: boolean) => invoke("autostart_set", { enabled }),
  quit: () => invoke("quit_app").catch(() => {}),
};
