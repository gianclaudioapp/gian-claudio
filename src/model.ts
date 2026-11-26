// Data model, persisted as state.json in %APPDATA%\GianClaudio (see api.ts).
import type { CSSProperties } from "react";
import { LangSetting, locale, t } from "./i18n";

export type AccountKind = "default" | "subscription" | "apikey";

export interface Account {
  id: string;
  name: string;
  /** Hex color used for the tag and the tab initial. */
  color: string;
  kind: AccountKind;
  /** Isolated CLAUDE_CONFIG_DIR; null = Claude Code's default (~/.claude). */
  configDir: string | null;
}

export interface Folder {
  path: string;
}

export interface Chat {
  /** UUID passed to `claude --session-id`, reused with `--resume`. */
  sessionId: string;
  name: string;
  startedAt: number;
  /** Set when the user renamed it: the automatic title no longer overrides it. */
  nameLocked?: boolean;
}

export interface SandboxInfo {
  parentId: string;
  /** Name of the chat it was detached from. */
  origin: string;
  createdAt: number;
  /** "git": worktree of `repo` on a detached HEAD; "copy": copy of a plain folder. */
  kind: "git" | "copy";
  /** The sandbox folder (worktree or copy). */
  root: string;
  /** Its own files (prompt.md); parent of `root`. */
  meta: string;
  repo: string | null;
  /** Commit the changes are measured against (moves on after "apply"). */
  base: string | null;
  /** Commit the sandbox started from (git): where its branch starts. */
  start?: string | null;
  /** Branch created from it (git); later commits go on top of it. */
  branch?: string;
  /** Session it was forked from: used until the forked chat exists. */
  forkFrom: string;
}

export interface Context {
  id: string;
  name: string;
  /** Folder name under contexts\ holding this context's history. */
  dirName: string;
  accountId: string;
  folders: Folder[];
  /** Index into `folders` of the working folder (cwd). */
  workingIndex: number;
  /** The one current chat; null until the first one is started. */
  chat: Chat | null;
  lastUsed: number | null;
  /** Shell of the terminal panel (a `ShellInfo.id`); PowerShell when unset. */
  shell?: string;
  /** Ignored files last picked when detaching a sandbox (remembered per context). */
  sandboxCopy?: string[];
  /**
   * Set on a sandbox: a chat detached into its own folder (see sandbox.rs). It is
   * stored as a context so it runs like one, but it's hidden from the sidebar and
   * has a single chat. It shares its parent's account and history folder.
   */
  sandbox?: SandboxInfo;
}

export type SummaryModel = "haiku" | "sonnet" | "off";
export type Theme = "light" | "dark";

export interface Settings {
  summaryModel: SummaryModel;
  theme: Theme;
  /** Accent color of the UI and the logo. */
  accent: string;
  /** The close button hides to the tray, so running chats keep going. */
  closeToTray: boolean;
  /** Terminal text size in percent of the base size (50–150). */
  terminalScale: number;
  /** Terminal panel next to Claude: where it sits and its height (bottom) or width (right) in px. */
  shellPanel?: { side: "bottom" | "right"; size: number };
  /** Interface language; "system" follows Windows (English when not Italian). */
  language: LangSetting;
  /** Bumped when a default changes, to migrate older state files. */
  version: number;
}

/** Accent colors; names are English source text, shown through t(). */
export const ACCENTS = [
  { name: "Gian Claudio orange", color: "#F45A1F" },
  { name: "Terracotta", color: "#D97757" },
  { name: "Blue", color: "#2457C5" },
  { name: "Green", color: "#17774F" },
  { name: "Purple", color: "#6D3FD9" },
  { name: "Raspberry", color: "#C2185B" },
  { name: "Graphite", color: "#52525B" },
];

const SETTINGS_VERSION = 2;

function defaultSettings(): Settings {
  const dark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  return { summaryModel: "sonnet", theme: dark ? "dark" : "light", accent: ACCENTS[0].color, closeToTray: true, terminalScale: 100, language: "system", version: SETTINGS_VERSION };
}

/** Terminal font size at 100%, in pixels. */
export const TERMINAL_BASE_FONT = 13;
export const TERMINAL_SCALE_MIN = 50;
export const TERMINAL_SCALE_MAX = 150;

export function terminalFontSize(scale: number): number {
  const s = Math.min(TERMINAL_SCALE_MAX, Math.max(TERMINAL_SCALE_MIN, scale || 100));
  return Math.round(TERMINAL_BASE_FONT * s) / 100;
}

/** CSS variables carrying an account color (see .acc-c in styles.css). */
export function accVars(color: string): CSSProperties {
  return { "--c": color } as CSSProperties;
}

export interface AppState {
  accounts: Account[];
  contexts: Context[];
  /** Tab ids in order (see tabs.ts). */
  openTabs: string[];
  activeTab: string | null;
  settings: Settings;
}

export interface HistoryEntry {
  path: string;
  file: string;
  name: string;
  sessionId: string;
  cwd: string;
  configDir: string | null;
  start: string;
  end: string;
  summary: string;
  /** Its (detailed) summary is handed to every new chat of the context. */
  important: boolean;
  detailed: boolean;
}

export const ACCOUNT_COLORS = [
  "#2457C5", "#17774F", "#6D3FD9", "#B4461A", "#B42358",
  "#A16207", "#4D7C0F", "#0369A1", "#9D174D", "#334155",
];

export function seedState(): AppState {
  return {
    accounts: [{ id: "default", name: "Default", color: "#2457C5", kind: "default", configDir: null }],
    contexts: [],
    openTabs: [],
    activeTab: null,
    settings: defaultSettings(),
  };
}

/** Fill fields added after a state file was written. */
export function normalize(s: Partial<AppState>): AppState {
  const base = seedState();
  const accounts = (s.accounts ?? base.accounts).map((a) => ({
    ...a,
    kind: a.kind ?? (a.configDir ? "subscription" : "default"),
  })) as Account[];
  const contexts = (s.contexts ?? []).map((c) => ({ ...c, dirName: c.dirName ?? slug(c.name) + "-" + c.id.slice(0, 4) }));
  return {
    accounts,
    contexts,
    // Terminals of logins/installs and read-only views are not restored.
    openTabs: (s.openTabs ?? []).filter((t) => !t.startsWith("aux:") && !t.startsWith("read:")),
    activeTab: s.activeTab && !s.activeTab.startsWith("aux:") && !s.activeTab.startsWith("read:") ? s.activeTab : null,
    settings: migrateSettings({ ...base.settings, version: 1, ...(s.settings ?? {}) }),
  };
}

function migrateSettings(st: Settings): Settings {
  // v2: summaries default to Sonnet (v1 saved Haiku as an implicit default).
  if (st.version < 2 && st.summaryModel === "haiku") st = { ...st, summaryModel: "sonnet" };
  return { ...st, version: SETTINGS_VERSION };
}

export function newId(): string {
  return crypto.randomUUID();
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return out || "context";
}

export function uniqueDirName(name: string, taken: string[]): string {
  const base = slug(name);
  let n = base;
  for (let i = 2; taken.includes(n); i++) n = `${base}-${i}`;
  return n;
}

export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function workingDir(c: Context): string {
  return c.folders[c.workingIndex]?.path ?? c.folders[0]?.path ?? "";
}

/** Light tint of an account color, for tag backgrounds. */
export function tint(hex: string, alpha = 0.12): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function timeAgo(ts: number | null, now = Date.now()): string {
  if (!ts) return "";
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return t("now");
  if (m < 60) return t("{n} min ago", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{n} h ago", { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? t("yesterday") : t("{n} d ago", { n: d });
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(+d) ? "" : d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

export function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const label = d.toLocaleDateString(locale(), { day: "numeric", month: "long" });
  if (d.toDateString() === today.toDateString()) return t("Today — {date}", { date: label });
  if (d.toDateString() === yest.toDateString()) return t("Yesterday — {date}", { date: label });
  return d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
}

export function durationLabel(startIso: string, endIso: string): string {
  const min = Math.round((+new Date(endIso) - +new Date(startIso)) / 60000);
  if (!isFinite(min) || min < 0) return "";
  if (min < 60) return t("{n} min", { n: min });
  return t("{h} h {m} min", { h: Math.floor(min / 60), m: min % 60 });
}

/** "2.1.330 (Claude Code)" → [2, 1, 330]. */
function versionParts(v: string): number[] | null {
  const m = /\d+(?:\.\d+)+/.exec(v);
  return m ? m[0].split(".").map(Number) : null;
}

/** Whether `latest` is a newer version than the installed one (`claude --version` output). */
export function isNewerVersion(installed: string | null | undefined, latest: string | null | undefined): boolean {
  const a = installed ? versionParts(installed) : null;
  const b = latest ? versionParts(latest) : null;
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Bare version number for display ("2.1.330"). */
export function versionNumber(v: string): string {
  return /\d+(?:\.\d+)+/.exec(v)?.[0] ?? v;
}
