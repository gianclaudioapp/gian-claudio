import { MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SearchPage } from "./SearchPage";
import { Rich } from "./ReadOnlyChat";
import { ChatRef, UsageDonut, UsagePage } from "./Usage";
import { AccountLimits, ContextLine, FileChange, HookStatus, SandboxSummary, ShellInfo, api } from "./api";
import { AccountsPage } from "./AccountsPage";
import { ContextForm, ContextInput } from "./ContextForm";
import { HistoryPage } from "./HistoryPage";
import { Icon, IconName } from "./icons";
import { Logo } from "./Logo";
import { AppMenu, AppMenuGroup } from "./AppMenu";
import { About } from "./About";
import { ContextShells, ShellPanel } from "./ShellPanel";
import { SandboxDialog, SandboxInput } from "./SandboxDialog";
import { SandboxPage } from "./SandboxPage";
import { ChangesPanel } from "./ChangesPanel";
import { BranchDialog, BranchInput } from "./BranchDialog";
import { Cooking, CookingItem } from "./Cooking";
import { terminalActions } from "./Terminal";
import { Account, AppState, Chat, Context, HistoryEntry, newId, timeAgo, accVars, uniqueDirName, workingDir, folderName, terminalFontSize, isNewerVersion, versionNumber, TERMINAL_SCALE_MAX, TERMINAL_SCALE_MIN, slug } from "./model";
import { ReadOnlyChat } from "./ReadOnlyChat";
import { SettingsPage } from "./SettingsPage";
import { LaunchSpec, Terminal } from "./Terminal";
import { Confirm, ContextMenu, Dialog, Menu } from "./ui";
import { AppUpdateState, appVersion, checkAppUpdate, installAppUpdate } from "./updates";
import { lang, resolveLang, setLang, t, tn } from "./i18n";

/*
 * Tab ids: "<contextId>" (its current chat), "new", "edit:<ctx>", "history:<ctx>",
 * "read:<ctx>:<sessionId>", "accounts", "settings", "aux:<id>" (login/install terminals).
 */
const NEW = "new";
const ACCOUNTS = "accounts";
const SETTINGS = "settings";
const SEARCH = "search";
type HookState = "working" | "waiting" | "idle";
/** Fallback when hooks report nothing: output within this window means Claude is working. */
const ACTIVE_MS = 1500;
const INSTALL_CMD = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"];

const ctxOfTab = (t: string | null) =>
  !t ? null : t.startsWith("edit:") || t.startsWith("history:") || t.startsWith("sandboxes:") || t.startsWith("read:") ? t.split(":")[1] : null;

interface AuxTab {
  label: string;
  icon: IconName;
  onExit?: () => void;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [paths, setPaths] = useState({ dataDir: "", homeDir: "" });
  const [claudeVersion, setClaudeVersion] = useState<string | null | undefined>(undefined);
  /** Latest published Claude Code: undefined = not checked yet, null = unknown (offline). */
  const [claudeLatest, setClaudeLatest] = useState<string | null | undefined>(undefined);
  const [updateAsk, setUpdateAsk] = useState<{ installed: string; latest: string } | null>(null);
  /** Gian Claudio's own version and update (separate from Claude Code's). */
  const [appVer, setAppVer] = useState<string | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ status: "idle" });
  const [appUpdateAsk, setAppUpdateAsk] = useState(false);
  const [about, setAbout] = useState(false);
  const [runs, setRuns] = useState<Record<string, LaunchSpec>>({});
  const [aux, setAux] = useState<Record<string, AuxTab>>({});
  const [readEntries, setReadEntries] = useState<Record<string, HistoryEntry>>({});
  const [historyCounts, setHistoryCounts] = useState<Record<string, number>>({});
  const [historyVersion, setHistoryVersion] = useState(0);
  const [accountsVersion, setAccountsVersion] = useState(0);
  const [archiving, setArchiving] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Context | null>(null);
  /** Each sandbox's changed files, its summary, and whether its "what was done" panel is open. */
  const [sbxFiles, setSbxFiles] = useState<Record<string, FileChange[]>>({});
  const [sbxSummary, setSbxSummary] = useState<Record<string, SandboxSummary | null>>({});
  const [summarizing, setSummarizing] = useState<Record<string, boolean>>({});
  const [changesOpen, setChangesOpen] = useState<Record<string, boolean>>({});
  /** Sandbox whose "create a branch" dialog is open. */
  const [branching, setBranching] = useState<Context | null>(null);
  /** Context whose chat is being detached into a sandbox (the dialog is open). */
  const [detaching, setDetaching] = useState<Context | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; ctx: Context } | null>(null);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [hook, setHook] = useState<Record<string, HookState>>({});
  /** What each chat's hooks last said (tool, question, since when), for "Cooking". */
  const [hookInfo, setHookInfo] = useState<Record<string, HookStatus>>({});
  const [cookingOpen, setCookingOpen] = useState(false);
  const [lines, setLines] = useState<Record<string, ContextLine>>({});
  const [limits, setLimits] = useState<Record<string, AccountLimits>>({});
  const [dropping, setDropping] = useState(false);
  const [shells, setShells] = useState<Record<string, ContextShells>>({});
  const [shellList, setShellList] = useState<ShellInfo[]>([]);
  /** The key above Tab as this keyboard labels it, for the terminal shortcut hint. */
  const [shellKey, setShellKey] = useState("`");
  const workRef = useRef<HTMLDivElement>(null);
  const toggleShellRef = useRef<() => void>(() => {});
  /** The shell to focus when it appears (just opened or picked), not on a context switch. */
  const shellFocus = useRef<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const lastOutput = useRef<Record<string, number>>({});
  const spawnedAt = useRef<Record<string, number>>({});
  const pendingPrefill = useRef<Record<string, string>>({});
  const stateRef = useRef<AppState | null>(null);
  stateRef.current = state;

  // ---- load, persist, clock -------------------------------------------------
  useEffect(() => {
    (async () => {
      const [s, p] = await Promise.all([api.loadState(), api.paths()]);
      setPaths(p);
      setState(s);
      checkClaude(true);
      appVersion().then(setAppVer);
      api.shellsList().then(setShellList);
      (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard?.getLayoutMap?.()
        .then((m) => { const k = m.get("Backquote"); if (k) setShellKey(k); }).catch(() => {});
      // Development builds are not installed: no update prompt there.
      if (!import.meta.env.DEV) checkApp(true);
      const counts = await Promise.all(s.contexts.map(async (c) => [c.id, (await api.historyList(c.dirName)).length] as const));
      setHistoryCounts(Object.fromEntries(counts));
    })();
    const clock = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!state) return;
    const save = setTimeout(() => api.saveState(state).catch(() => {}), 300);
    return () => clearTimeout(save);
  }, [state]);

  // Theme and accent live on <html> so every token in styles.css follows them.
  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme;
    root.style.setProperty("--accent", state.settings.accent);
  }, [state?.settings.theme, state?.settings.accent]);

  // Ctrl + the key above Tab shows or hides the terminal panel (captured first,
  // so the terminal doesn't get it). Ctrl+J would be VS Code's, but Claude Code
  // uses it for a new line.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Backquote" || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      toggleShellRef.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  // The open sandbox's changed files, refreshed while Claude may be working in it.
  const openSbx = state?.contexts.find((c) => c.id === state.activeTab && c.sandbox);
  useEffect(() => {
    const sb = openSbx?.sandbox;
    if (!openSbx || !sb) return;
    const id = openSbx.id;
    let alive = true;
    const load = () => api.sandboxChanges(sb.root, sb.base).then((f) => alive && setSbxFiles((x) => ({ ...x, [id]: f })));
    load();
    const timer = setInterval(load, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [openSbx?.id, openSbx?.sandbox?.base]);

  // Its summary: the saved one when it still matches, else written once when the panel opens.
  const autoSummary = useRef(new Set<string>());
  const openSbxId = openSbx?.id ?? "";
  useEffect(() => {
    const sb = openSbx;
    if (!sb?.sandbox || !changesOpen[sb.id] || sbxSummary[sb.id] !== undefined) return;
    api.sandboxSummaryRead(sb.sandbox.meta).then((s) => {
      const fresh = s && s.base === sb.sandbox!.base ? s : null;
      setSbxSummary((x) => ({ ...x, [sb.id]: fresh }));
      if (!fresh && !autoSummary.current.has(sb.id) && (sbxFiles[sb.id]?.length ?? 0) > 0) {
        autoSummary.current.add(sb.id);
        summarizeSandbox(sb);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSbxId, changesOpen[openSbxId], sbxSummary[openSbxId], sbxFiles[openSbxId]?.length]);

  // Ctrl+Shift+Space opens "Cooking" from anywhere (captured before the terminal).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      setCookingOpen((o) => !o);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  // F11 toggles full screen (captured first, so the terminal doesn't get it).
  useEffect(() => {
    const key = async (e: KeyboardEvent) => {
      if (e.key !== "F11" || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const historyRoot = useCallback((dirName: string) => `${paths.dataDir}\\contexts\\${dirName}\\history`, [paths.dataDir]);

  /** Installed and latest Claude Code; at startup, offer the update when there is one. */
  async function checkClaude(ask: boolean) {
    setClaudeVersion(undefined);
    setClaudeLatest(undefined);
    const [installed, latest] = await Promise.all([api.claudeCheck(), api.claudeLatest()]);
    setClaudeVersion(installed);
    setClaudeLatest(latest);
    if (ask && installed && latest && isNewerVersion(installed, latest)) setUpdateAsk({ installed, latest });
  }

  /** Look for a new Gian Claudio release; at startup, offer it when there is one. */
  async function checkApp(ask: boolean) {
    setAppUpdate({ status: "checking" });
    const r = await checkAppUpdate();
    setAppUpdate(r);
    if (ask && r.status === "available") setAppUpdateAsk(true);
  }

  /** Download, install and restart. Chats resume when the app starts again. */
  async function installApp() {
    if (appUpdate.status !== "available") return;
    const update = appUpdate.update;
    setAppUpdate({ status: "installing", update, percent: null });
    try {
      await installAppUpdate(update, (percent) => setAppUpdate({ status: "installing", update, percent }));
    } catch {
      setAppUpdate({ status: "failed" });
    }
  }

  // ---- helpers ----------------------------------------------------------------
  const update = (fn: (s: AppState) => AppState) => setState((s) => (s ? fn(s) : s));
  const accountOf = (id: string): Account => {
    const s = stateRef.current!;
    return s.accounts.find((a) => a.id === id) ?? s.accounts[0];
  };
  const ctxById = (id: string | null) => (id ? stateRef.current?.contexts.find((c) => c.id === id) : undefined);
  // Hooks give the exact state; output activity is the fallback until they report.
  const isWorking = (id: string) =>
    !!runs[id] && (hook[id] ? hook[id] === "working" : now - (lastOutput.current[id] ?? 0) < ACTIVE_MS);
  const isWaiting = (id: string) => !!runs[id] && hook[id] === "waiting";

  function patchContext(id: string, patch: Partial<Context>) {
    update((s) => ({ ...s, contexts: s.contexts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }

  function openTab(id: string) {
    update((s) => ({ ...s, openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id], activeTab: id }));
  }

  function closeTab(id: string) {
    setRuns((r) => {
      if (!(id in r)) return r;
      const next = { ...r };
      delete next[id];
      return next;
    });
    if (aux[id]) {
      aux[id].onExit?.();
      setAux((a) => {
        const next = { ...a };
        delete next[id];
        return next;
      });
    }
    update((s) => {
      const tabs = s.openTabs.filter((t) => t !== id);
      const i = s.openTabs.indexOf(id);
      const active = s.activeTab === id ? tabs[Math.min(i, tabs.length - 1)] ?? null : s.activeTab;
      return { ...s, openTabs: tabs, activeTab: active };
    });
  }

  // ---- chats ------------------------------------------------------------------
  /** Start `claude` for the context's chat: resume it when Claude Code has a transcript. */
  async function launch(ctx: Context, chat: Chat, fresh: boolean) {
    const acc = accountOf(ctx.accountId);
    const cwd = workingDir(ctx);
    let resume = !fresh && (await api.sessionExists(acc.configDir, cwd, chat.sessionId));
    // A sandbox's first start: its own copy of the chat it was detached from, written
    // as if it had always been in the sandbox folder (so Claude sees no move).
    let fork = false;
    if (!resume && ctx.sandbox) {
      const parent = ctxById(ctx.sandbox.parentId);
      resume = !!parent && (await api.sandboxFork(acc.configDir, workingDir(parent), ctx.sandbox.forkFrom, cwd, chat.sessionId));
      fork = !resume;
    }
    const args = resume ? ["--resume", chat.sessionId] : ["--session-id", chat.sessionId];
    if (fork) args.unshift("--resume", ctx.sandbox!.forkFrom, "--fork-session");
    ctx.folders.forEach((f, i) => {
      if (i !== ctx.workingIndex) args.push("--add-dir", f.path);
    });
    // Latest chat + important chats, summarized, plus where the history lives.
    // A file, not an argument: cmd.exe would cut long or multi-line text.
    let promptFile = await api.contextPromptFile(ctx.dirName);
    if (ctx.sandbox) {
      const parent = ctxById(ctx.sandbox.parentId);
      promptFile = await api.sandboxPromptFile(ctx.sandbox.meta, promptFile, parent ? workingDir(parent) : ctx.sandbox.root, cwd);
    }
    if (promptFile) args.push("--append-system-prompt-file", promptFile);
    // Hooks that report working / waiting / idle back to the app.
    const ptyId = newId();
    const statusFile = await api.statusSettingsFile(ptyId, acc.id);
    if (statusFile) args.push("--settings", statusFile);
    const env: Record<string, string> = acc.configDir ? { CLAUDE_CONFIG_DIR: acc.configDir } : {};
    spawnedAt.current[ctx.id] = Date.now();
    delete lastOutput.current[ctx.id];
    setHook((h) => {
      const next = { ...h };
      delete next[ctx.id];
      return next;
    });
    setRuns((r) => ({ ...r, [ctx.id]: { ptyId, cwd, args, env, apiKeyAccount: acc.kind === "apikey" ? acc.id : null } }));
  }

  /** Sessions whose title came from the transcript: it wins over the terminal title. */
  const transcriptTitled = useRef(new Set<string>());

  /**
   * Use Claude Code's title for the chat until the user renames it. It comes from
   * the transcript (reliable) or, before that, from the terminal title.
   */
  function onTitle(tabId: string, raw: string, fromTranscript = false) {
    const ctx = ctxById(tabId);
    if (!ctx?.chat || ctx.chat.nameLocked) return;
    if (fromTranscript) transcriptTitled.current.add(ctx.chat.sessionId);
    else if (transcriptTitled.current.has(ctx.chat.sessionId)) return;
    const title = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (!title || /^claude( code)?$/i.test(title) || /^[a-z]:[\\/]/i.test(title) || title === ctx.chat.name) return;
    patchContext(tabId, { chat: { ...ctx.chat, name: title.slice(0, 80) } });
  }

  function openContext(ctx: Context) {
    openTab(ctx.id);
    if (runs[ctx.id]) return;
    if (ctx.chat) launch(ctx, ctx.chat, false);
    else startNewChat(ctx);
  }

  /**
   * Replace the context's chat with a new one. The old chat is stopped and
   * archived (with its summary) first, so the new chat starts knowing about it.
   */
  async function startNewChat(ctx: Context) {
    const old = ctx.chat;
    const chat: Chat = { sessionId: newId(), name: t("New chat"), startedAt: Date.now() };
    const next = { ...ctx, chat, lastUsed: Date.now() };
    patchContext(ctx.id, { chat, lastUsed: next.lastUsed });
    if (old) {
      const acc = accountOf(ctx.accountId);
      setRuns((r) => {
        const rest = { ...r };
        delete rest[ctx.id];
        return rest;
      });
      setArchiving((a) => ({ ...a, [ctx.id]: true }));
      await api
        .historySave({
          contextDir: ctx.dirName,
          sessionId: old.sessionId,
          name: old.name,
          cwd: workingDir(ctx),
          configDir: acc.configDir,
          apiKeyAccount: acc.kind === "apikey" ? acc.id : null,
          summaryModel: stateRef.current?.settings.summaryModel ?? "sonnet",
          language: lang(),
        })
        .catch(() => null);
      setArchiving((a) => ({ ...a, [ctx.id]: false }));
      setHistoryVersion((v) => v + 1);
      const n = (await api.historyList(ctx.dirName)).length;
      setHistoryCounts((c) => ({ ...c, [ctx.id]: n }));
      // The context may have been deleted meanwhile.
      if (!stateRef.current?.contexts.some((c) => c.id === ctx.id)) return;
    }
    await launch(next, chat, true);
  }

  /** Mark a past chat as important; the first time, Claude writes a detailed summary. */
  async function setImportant(ctx: Context, e: HistoryEntry, important: boolean): Promise<HistoryEntry> {
    const acc = accountOf(ctx.accountId);
    const updated = await api.historySetImportant({
      path: e.path,
      important,
      apiKeyAccount: acc.kind === "apikey" ? acc.id : null,
      model: stateRef.current?.settings.summaryModel ?? "sonnet",
      language: lang(),
    });
    setReadEntries((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.path === e.path ? updated : v])));
    setHistoryVersion((v) => v + 1);
    return updated;
  }

  function onActivity(tabId: string) {
    lastOutput.current[tabId] = Date.now();
    const text = pendingPrefill.current[tabId];
    if (text && Date.now() - (spawnedAt.current[tabId] ?? 0) > 2500 && runs[tabId]) {
      delete pendingPrefill.current[tabId];
      invoke("pty_write", { id: runs[tabId].ptyId, data: text }).catch(() => {});
    }
    const ctx = ctxById(tabId);
    if (ctx && Date.now() - (ctx.lastUsed ?? 0) > 60000) patchContext(tabId, { lastUsed: Date.now() });
  }

  /** "Continue in the current chat": pre-fill the prompt in the context's chat. */
  function resumeInCurrent(ctx: Context, prompt: string) {
    const run = runs[ctx.id];
    if (run && Date.now() - (spawnedAt.current[ctx.id] ?? 0) > 2500) {
      invoke("pty_write", { id: run.ptyId, data: prompt }).catch(() => {});
      openTab(ctx.id);
    } else {
      pendingPrefill.current[ctx.id] = prompt;
      openContext(ctx);
    }
  }

  // ---- hook status, notifications ----------------------------------------------
  // Context fill per chat and plan limits per account, from Claude Code's status line.
  useEffect(() => {
    const tick = async () => {
      const entries = Object.entries(runsRef.current).filter(([id]) => !id.startsWith("aux:"));
      const [l, lim] = await Promise.all([
        api.statusLineRead(entries.map(([, s]) => s.ptyId)),
        api.accountLimitsRead((stateRef.current?.accounts ?? []).map((a) => a.id)),
      ]);
      const byTab: Record<string, ContextLine> = {};
      for (const [tabId, spec] of entries) if (l[spec.ptyId]) byTab[tabId] = l[spec.ptyId];
      setLines((old) => (JSON.stringify(old) === JSON.stringify(byTab) ? old : byTab));
      setLimits((old) => (JSON.stringify(old) === JSON.stringify(lim) ? old : lim));
      // Chat titles Claude Code writes in the transcript (generated, or set with /rename).
      const naming = (stateRef.current?.contexts ?? []).filter((c) => runsRef.current[c.id] && c.chat && !c.chat.nameLocked);
      const titles = await api.sessionTitles(naming.map((c) => ({
        configDir: accountOf(c.accountId).configDir, cwd: workingDir(c), sessionId: c.chat!.sessionId,
      })));
      for (const c of naming) {
        const title = titles[c.chat!.sessionId];
        if (title) onTitle(c.id, title, true);
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, []);

  const prevHook = useRef<Record<string, HookState>>({});
  useEffect(() => {
    const timer = setInterval(async () => {
      const entries = Object.entries(runs).filter(([id]) => !id.startsWith("aux:"));
      if (entries.length === 0) return;
      const read = await api.statusRead(entries.map(([, s]) => s.ptyId));
      const next: Record<string, HookState> = {};
      const info: Record<string, HookStatus> = {};
      for (const [tabId, spec] of entries) {
        const st = read[spec.ptyId]?.state as HookState | undefined;
        if (st) next[tabId] = st;
        if (read[spec.ptyId]) info[tabId] = read[spec.ptyId];
      }
      setHookInfo((h) => (JSON.stringify(h) === JSON.stringify(info) ? h : info));
      // Notify when a chat stops working while the user is looking elsewhere.
      for (const [tabId, st] of Object.entries(next)) {
        const before = prevHook.current[tabId];
        if (before === st || (st !== "idle" && st !== "waiting") || (before !== "working" && st === "idle")) continue;
        const looking = document.hasFocus() && stateRef.current?.activeTab === tabId;
        const ctx = ctxById(tabId);
        if (!looking && ctx) {
          api.notify(
            st === "waiting" ? t("{context}: Claude is waiting for you", { context: ctx.name }) : t("{context}: Claude is done", { context: ctx.name }),
            ctx.chat?.name ?? "",
          );
        }
      }
      prevHook.current = next;
      setHook((h) => (JSON.stringify(h) === JSON.stringify(next) ? h : next));
    }, 700);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  // Files dropped on the window go to the active chat as quoted paths.
  const activeRef = useRef<string | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const tab = activeRef.current;
        const run = tab ? runsRef.current[tab] : undefined;
        if (e.payload.type === "over" || e.payload.type === "enter") setDropping(!!run);
        else if (e.payload.type === "leave") setDropping(false);
        else if (e.payload.type === "drop") {
          setDropping(false);
          if (run && e.payload.paths.length) {
            const text = e.payload.paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ";
            invoke("pty_write", { id: run.ptyId, data: text }).catch(() => {});
          }
        }
      })
      .then((u) => (off = u))
      .catch(() => {});
    return () => off?.();
  }, []);
  const runsRef = useRef(runs);
  runsRef.current = runs;

  // The tray menu is built in Rust: send it the labels in the interface language.
  const uiLang = state ? resolveLang(state.settings.language) : null;
  useEffect(() => {
    if (!uiLang) return;
    setLang(uiLang);
    invoke("tray_set_labels", { open: t("Open Gian Claudio"), quit: t("Quit") }).catch(() => {});
  }, [uiLang]);

  // Close button behavior lives in Rust; keep it in sync with the setting.
  useEffect(() => {
    if (state) api.setCloseToTray(state.settings.closeToTray);
  }, [state?.settings.closeToTray]);

  // ---- contexts -----------------------------------------------------------------
  function createContext(input: ContextInput) {
    const s = stateRef.current!;
    const ctx: Context = {
      id: newId(),
      name: input.name,
      dirName: uniqueDirName(input.name, s.contexts.map((c) => c.dirName)),
      accountId: input.accountId,
      folders: input.folders.map((path) => ({ path })),
      workingIndex: input.workingIndex,
      chat: null,
      lastUsed: Date.now(),
      shell: input.shell,
    };
    update((st) => ({
      ...st,
      contexts: [ctx, ...st.contexts],
      openTabs: [...st.openTabs.filter((t) => t !== NEW), ctx.id],
      activeTab: ctx.id,
    }));
    startNewChat(ctx);
  }

  function saveContextEdit(ctx: Context, input: ContextInput) {
    patchContext(ctx.id, { name: input.name, folders: input.folders.map((path) => ({ path })), workingIndex: input.workingIndex, shell: input.shell });
    closeTab(`edit:${ctx.id}`);
    openTab(ctx.id);
    if (!runs[ctx.id] && ctx.chat) launch({ ...ctx, folders: input.folders.map((path) => ({ path })), workingIndex: input.workingIndex }, ctx.chat, false);
  }

  /** Remove a context and everything stored for it (its history). */
  function deleteContext(ctx: Context) {
    if (ctx.sandbox) {
      // After its terminals have closed: Windows won't delete a folder a process still uses.
      const sb = ctx.sandbox;
      const work = workingDir(ctx);
      const configDir = accountOf(ctx.accountId).configDir;
      setTimeout(() => api.sandboxRemove(sb.meta, sb.root, sb.repo, work, configDir).catch(() => {}), 800);
    } else {
      api.contextRemoveFiles(ctx.dirName).catch(() => {});
      stateRef.current?.contexts.filter((c) => c.sandbox?.parentId === ctx.id).forEach(deleteContext);
    }
    setShells((all) => {
      const next = { ...all };
      delete next[ctx.id]; // unmounting its terminals ends the shells
      return next;
    });
    const related = (t: string) => t === ctx.id || ctxOfTab(t) === ctx.id;
    setRuns((r) => {
      const next = { ...r };
      delete next[ctx.id];
      return next;
    });
    update((s) => {
      const tabs = s.openTabs.filter((t) => !related(t));
      return { ...s, contexts: s.contexts.filter((c) => c.id !== ctx.id), openTabs: tabs, activeTab: s.activeTab && related(s.activeTab) ? tabs[tabs.length - 1] ?? null : s.activeTab };
    });
  }

  // ---- sandboxes -----------------------------------------------------------------

  /** Detach the context's chat into a sandbox: its own folder, a copy of the chat, opened as a tab. */
  async function createSandbox(parent: Context, input: SandboxInput) {
    if (!parent.chat) return;
    const id = newId();
    const made = await api.sandboxCreate({ source: workingDir(parent), contextDir: parent.dirName, id, carry: input.carry, copy: input.copy });
    const now = Date.now();
    const sb: Context = {
      id,
      name: parent.name,
      dirName: parent.dirName,
      accountId: parent.accountId,
      // The sandbox is the working folder; the context's other folders stay as they are.
      folders: [{ path: made.work }, ...parent.folders.filter((_, i) => i !== parent.workingIndex)],
      workingIndex: 0,
      chat: { sessionId: newId(), name: input.name, startedAt: now, nameLocked: true },
      lastUsed: now,
      shell: parent.shell,
      sandbox: {
        parentId: parent.id, origin: parent.chat.name, createdAt: now, kind: made.kind,
        root: made.root, meta: made.meta, repo: made.repo, base: made.base, start: made.base, forkFrom: parent.chat.sessionId,
      },
    };
    update((s) => ({
      ...s,
      contexts: [...s.contexts.map((c) => (c.id === parent.id ? { ...c, sandboxCopy: input.copy } : c)), sb],
    }));
    setDetaching(null);
    openTab(id);
    launch(sb, sb.chat!, false);
  }

  /** Ask Claude for a short summary of the sandbox's changes (in a throwaway copy of its chat). */
  async function summarizeSandbox(sb: Context) {
    const s = stateRef.current;
    if (!sb.sandbox?.base || !sb.chat || !s || s.settings.summaryModel === "off") return;
    const acc = accountOf(sb.accountId);
    setSummarizing((x) => ({ ...x, [sb.id]: true }));
    try {
      const sum = await api.sandboxSummary({
        root: sb.sandbox.root, base: sb.sandbox.base, meta: sb.sandbox.meta, sessionId: sb.chat.sessionId, cwd: workingDir(sb),
        configDir: acc.configDir, apiKeyAccount: acc.kind === "apikey" ? acc.id : null,
        model: s.settings.summaryModel, language: lang() === "it" ? "Italian" : "English",
      });
      if (sum) setSbxSummary((x) => ({ ...x, [sb.id]: sum }));
    } catch {
      // No summary: the panel keeps offering to write it.
    }
    setSummarizing((x) => ({ ...x, [sb.id]: false }));
  }

  /** Bring the sandbox's changes into the context's folder; resolves with the files to fix by hand. */
  async function applySandbox(sb: Context): Promise<string[]> {
    const info = sb.sandbox!;
    const parent = ctxById(info.parentId);
    const target = info.repo ?? (parent ? workingDir(parent) : null);
    if (!info.base || !target) throw new Error(t("The context's folder isn't available."));
    const res = await api.sandboxApply({ root: info.root, base: info.base, meta: info.meta, target });
    patchContext(sb.id, { sandbox: { ...info, base: res.base } });
    setSbxSummary((x) => ({ ...x, [sb.id]: null }));
    setSbxFiles((x) => ({ ...x, [sb.id]: [] }));
    return res.conflicts;
  }

  /** Claude's proposal for the commit message of a sandbox's branch. */
  async function proposeCommitMessage(sb: Context): Promise<string | null> {
    const s = stateRef.current;
    const info = sb.sandbox;
    if (!info?.repo || !sb.chat || !s || s.settings.summaryModel === "off") return null;
    const acc = accountOf(sb.accountId);
    return api.sandboxCommitMessage({
      root: info.root, start: info.start ?? info.base ?? "", repo: info.repo, sessionId: sb.chat.sessionId, cwd: workingDir(sb),
      configDir: acc.configDir, apiKeyAccount: acc.kind === "apikey" ? acc.id : null, model: s.settings.summaryModel,
    });
  }

  async function branchSandbox(sb: Context, input: BranchInput) {
    const info = sb.sandbox!;
    const done = await api.sandboxBranch({
      root: info.root, repo: info.repo!, start: info.start ?? info.base ?? "", existing: info.branch ?? null, ...input,
    });
    patchContext(sb.id, { sandbox: { ...info, branch: done.branch } });
    return done;
  }

  // ---- terminal panel (shells next to Claude) -------------------------------------

  /** Open one more shell for the context, in its working folder, and show the panel. */
  function addShell(ctx: Context) {
    const info = shellList.find((s) => s.id === (ctx.shell ?? "powershell") && s.available)
      ?? shellList.find((s) => s.id === "powershell");
    const ptyId = `shell-${newId()}`;
    shellFocus.current = ptyId;
    const tab = {
      ptyId, shellId: info?.id ?? "powershell", title: null,
      spec: { ptyId, cwd: workingDir(ctx), args: [], env: info?.env ?? {}, program: info?.argv.length ? info.argv : ["powershell.exe", "-NoLogo"] },
    };
    setShells((all) => {
      const cs = all[ctx.id] ?? { tabs: [], active: null, open: true };
      return { ...all, [ctx.id]: { tabs: [...cs.tabs, tab], active: ptyId, open: true } };
    });
  }

  function patchShells(ctxId: string, fn: (cs: ContextShells) => ContextShells) {
    setShells((all) => (all[ctxId] ? { ...all, [ctxId]: fn(all[ctxId]) } : all));
  }

  /** Back to Claude's terminal when the panel goes away. */
  function focusClaude(ctxId: string) {
    const ptyId = runs[ctxId]?.ptyId;
    if (ptyId) setTimeout(() => terminalActions.get(ptyId)?.focus(), 0);
  }

  /** Show or hide the panel; the first time it starts a shell. */
  function toggleShell(ctx: Context) {
    const cs = shells[ctx.id];
    if (!cs || cs.tabs.length === 0) addShell(ctx);
    else {
      if (!cs.open) shellFocus.current = cs.active;
      else focusClaude(ctx.id);
      patchShells(ctx.id, (c) => ({ ...c, open: !c.open }));
    }
  }

  function closeShell(ctxId: string, ptyId: string) {
    if (shells[ctxId]?.tabs.length === 1 && ctxId === activeRef.current) focusClaude(ctxId);
    patchShells(ctxId, (cs) => {
      const tabs = cs.tabs.filter((x) => x.ptyId !== ptyId);
      const i = cs.tabs.findIndex((x) => x.ptyId === ptyId);
      const active = cs.active === ptyId ? (tabs[Math.min(i, tabs.length - 1)]?.ptyId ?? null) : cs.active;
      return { tabs, active, open: cs.open && tabs.length > 0 };
    });
  }

  /** Drag the handle between Claude and the panel. */
  function resizeShell(e: ReactMouseEvent) {
    e.preventDefault();
    const box = workRef.current?.getBoundingClientRect();
    if (!box) return;
    const side = state!.settings.shellPanel?.side ?? "bottom";
    const move = (ev: MouseEvent) => {
      const size = side === "bottom"
        ? Math.min(box.height - 150, Math.max(120, box.bottom - ev.clientY - 4))
        : Math.min(box.width - 320, Math.max(260, box.right - ev.clientX - 4));
      update((s) => ({ ...s, settings: { ...s.settings, shellPanel: { side, size: Math.round(size) } } }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove(side === "bottom" ? "resizing-row" : "resizing-col");
    };
    document.body.classList.add(side === "bottom" ? "resizing-row" : "resizing-col");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ---- accounts & aux terminals -----------------------------------------------
  function openAux(id: string, tab: AuxTab, spec: Omit<LaunchSpec, "ptyId">) {
    setAux((a) => ({ ...a, [id]: tab }));
    setRuns((r) => ({ ...r, [id]: { ...spec, ptyId: newId() } }));
    openTab(id);
  }

  function login(a: Account) {
    openAux(`aux:login:${a.id}`, { label: t("Sign in · {account}", { account: a.name }), icon: "login", onExit: () => setAccountsVersion((v) => v + 1) }, {
      cwd: paths.homeDir,
      args: [],
      env: a.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {},
    });
  }

  /** `claude update` in its own tab; versions are checked again when it closes. */
  function updateClaude() {
    openAux("aux:update", { label: t("Updating Claude Code"), icon: "download", onExit: () => checkClaude(false) }, {
      cwd: paths.homeDir,
      args: ["update"],
      env: {},
    });
  }

  function installClaude() {
    openAux("aux:install", { label: t("Installing Claude Code"), icon: "download", onExit: () => checkClaude(false) }, {
      cwd: paths.homeDir,
      args: [],
      env: {},
      program: INSTALL_CMD,
    });
  }

  async function addAccount(a: Account, key: string | null) {
    const dir = await api.accountDir(a.id);
    const acc = { ...a, configDir: dir };
    if (acc.kind === "apikey" && key) await api.apiKeySet(acc.id, key);
    update((s) => ({ ...s, accounts: [...s.accounts, acc] }));
    if (acc.kind === "subscription") login(acc);
    else setAccountsVersion((v) => v + 1);
  }

  async function updateAccount(a: Account, key: string | null) {
    if (a.kind === "apikey" && key) await api.apiKeySet(a.id, key);
    update((s) => ({ ...s, accounts: s.accounts.map((x) => (x.id === a.id ? a : x)) }));
    setAccountsVersion((v) => v + 1);
  }

  /** Remove an account together with its contexts (their chats are stopped first). */
  async function removeAccount(a: Account) {
    stateRef.current?.contexts.filter((c) => c.accountId === a.id).forEach(deleteContext);
    // Let the terminals close before deleting the config folder they use.
    await new Promise((r) => setTimeout(r, 400));
    await api.accountRemove(a.id, a.configDir).catch(() => {});
    update((s) => ({ ...s, accounts: s.accounts.filter((x) => x.id !== a.id) }));
  }

  // ---- restore tabs left open last time -------------------------------------
  const restored = useRef(false);
  useEffect(() => {
    if (!state || restored.current) return;
    restored.current = true;
    state.openTabs.forEach((id) => {
      const ctx = state.contexts.find((c) => c.id === id);
      if (ctx?.chat) launch(ctx, ctx.chat, false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...(state?.contexts ?? [])]
      .filter((c) => !c.sandbox)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.chat?.name ?? "").toLowerCase().includes(q))
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  }, [state?.contexts, query]);

  if (!state) return <div className="boot"><Logo height={56} /></div>;
  setLang(resolveLang(state.settings.language));

  // A stale active id (tab closed, context gone) falls back to the empty state.
  const active = state.activeTab && state.openTabs.includes(state.activeTab) && tabMeta(state.activeTab) ? state.activeTab : null;
  const dark = state.settings.theme === "dark";
  const activeCtx = active ? state.contexts.find((c) => c.id === active) : undefined;
  const showTerms = !!active && (!!activeCtx || active.startsWith("aux:"));
  activeRef.current = active;
  // Chats working or waiting for you, waiting ones first, the longest-running first.
  const cooking: CookingItem[] = Object.keys(runs)
    .filter((id) => !id.startsWith("aux:") && (isWaiting(id) || isWorking(id)))
    .flatMap((id) => {
      const c = ctxById(id);
      if (!c) return [];
      const parent = c.sandbox ? ctxById(c.sandbox.parentId) : undefined;
      return [{
        id, state: isWaiting(id) ? "waiting" as const : "working" as const,
        context: parent?.name ?? c.name, chat: c.chat?.name ?? c.name,
        account: accountOf(c.accountId), sandbox: !!c.sandbox, info: hookInfo[id] ?? null,
      }];
    })
    .sort((a, b) => (a.state === b.state ? (a.info?.since ?? 0) - (b.info?.since ?? 0) : a.state === "waiting" ? -1 : 1));
  const shellPanel = state.settings.shellPanel ?? { side: "bottom" as const, size: 260 };
  const shellOpen = !!activeCtx && !!shells[activeCtx.id]?.open;
  const shellHint = `Ctrl+${shellKey}`;
  toggleShellRef.current = () => activeCtx && toggleShell(activeCtx);
  const win = {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    toggleFullscreen: async () => {
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
    },
  };

  /** The hamburger menu; read when it opens, so the Edit items see the current selection. */
  function menuGroups(): AppMenuGroup[] {
    const s = state!;
    const term = active && runs[active] ? terminalActions.get(runs[active].ptyId) : undefined;
    const setScale = (d: number) => update((x) => ({
      ...x, settings: { ...x.settings, terminalScale: Math.min(TERMINAL_SCALE_MAX, Math.max(TERMINAL_SCALE_MIN, x.settings.terminalScale + d)) },
    }));
    return [
      { label: t("File"), items: [
        { label: t("New context"), onClick: () => openTab(NEW) },
        { label: t("Accounts"), onClick: () => openTab(ACCOUNTS) },
        { label: t("Settings"), onClick: () => openTab(SETTINGS) },
        { label: t("Quit"), separator: true, onClick: () => api.quit() },
      ] },
      { label: t("Edit"), items: [
        { label: t("Copy"), hint: "Ctrl+C", disabled: !term?.hasSelection(), onClick: () => term?.copy() },
        { label: t("Paste"), hint: "Ctrl+V", disabled: !term, onClick: () => term?.paste() },
        { label: t("Select all"), disabled: !term, onClick: () => term?.selectAll() },
      ] },
      { label: t("View"), items: [
        { label: dark ? t("Light theme") : t("Dark theme"), onClick: () => update((x) => ({ ...x, settings: { ...x.settings, theme: dark ? "light" : "dark" } })) },
        { label: t("Larger terminal text"), disabled: s.settings.terminalScale >= TERMINAL_SCALE_MAX, onClick: () => setScale(10) },
        { label: t("Smaller terminal text"), disabled: s.settings.terminalScale <= TERMINAL_SCALE_MIN, onClick: () => setScale(-10) },
        { label: t("Full screen"), hint: "F11", separator: true, onClick: win.toggleFullscreen },
      ] },
      { label: t("Window"), items: [
        { label: t("Minimize"), onClick: win.minimize },
        { label: t("Maximize"), onClick: win.toggleMaximize },
        { label: s.settings.closeToTray && !import.meta.env.DEV ? t("Close to tray") : t("Close"), onClick: win.close },
      ] },
      { label: t("Help"), separator: true, items: [
        { label: t("About Gian Claudio"), onClick: () => setAbout(true) },
      ] },
    ];
  }

  function tabMeta(id: string): { label: string; icon?: IconName; dot?: boolean; waiting?: boolean; acc?: Account; sandbox?: boolean } | null {
    if (id === NEW) return { label: t("New context"), icon: "plus" };
    if (id === SEARCH) return { label: t("Search across past chats"), icon: "search" };
    if (id.startsWith("usage:")) {
      const a = stateRef.current?.accounts.find((x) => x.id === id.slice(6));
      return a ? { label: t("Usage · {account}", { account: a.name }), icon: "chart", acc: a } : null;
    }
    if (id === ACCOUNTS) return { label: t("Accounts"), icon: "user" };
    if (id === SETTINGS) return { label: t("Settings"), icon: "settings" };
    if (id.startsWith("aux:")) return aux[id] ? { label: aux[id].label, icon: aux[id].icon, dot: isWorking(id) } : null;
    const c = ctxById(ctxOfTab(id) ?? id);
    if (!c) return null;
    const acc = accountOf(c.accountId);
    if (id.startsWith("edit:")) return { label: t("Edit · {context}", { context: c.name }), icon: "pen" };
    if (id.startsWith("history:")) return { label: t("Past chats · {context}", { context: c.name }), icon: "clock", acc };
    if (id.startsWith("sandboxes:")) return { label: c.name, icon: "box", sandbox: true, acc };
    if (id.startsWith("read:")) return readEntries[id] ? { label: readEntries[id].name, icon: "lock", acc } : null;
    if (c.sandbox) return { label: c.chat?.name ?? c.name, icon: "box", sandbox: true, dot: isWorking(id), waiting: isWaiting(id), acc };
    return { label: c.chat?.name ?? c.name, dot: isWorking(id), waiting: isWaiting(id), acc };
  }

  function openSearch(q: string) {
    setSearchQuery(q);
    openTab(SEARCH);
  }

  /** Open a past chat (from history or search) read-only. */
  function openPast(ctxId: string, e: HistoryEntry) {
    const id = `read:${ctxId}:${e.sessionId || e.file}`;
    setReadEntries((r) => ({ ...r, [id]: e }));
    openTab(id);
  }

  const activeRelCtx = ctxOfTab(active) ?? (activeCtx ? activeCtx.sandbox?.parentId ?? activeCtx.id : null);
  const sandboxesOf = (ctxId: string) => state.contexts.filter((c) => c.sandbox?.parentId === ctxId);

  return (
    <div className="app">
      <aside>
        <div className="brand" data-tauri-drag-region>
          <AppMenu groups={menuGroups} />
          <Logo height={20} />
          Gian Claudio
        </div>
        <button className="new-ctx" onClick={() => openTab(NEW)}><Icon name="plus" size={14} />{t("New context")}</button>
        <label className="search">
          <Icon name="search" />
          <input placeholder={t("Search")} value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && query.trim().length >= 2 && openSearch(query.trim())} />
        </label>
        <div className="sb-list">
          {query.trim().length >= 2 && (
            <button className="sb-search" onClick={() => openSearch(query.trim())}>
              <Icon name="search" size={14} /><span>Cerca «{query.trim()}» nelle chat passate</span>
            </button>
          )}
          {sorted.length === 0 && <p className="sb-empty">{query ? t("No context with this name.") : t("No contexts yet. Create one to get started.")}</p>}
          {sorted.map((c) => {
            const acc = accountOf(c.accountId);
            const working = isWorking(c.id);
            const waiting = isWaiting(c.id);
            const histOn = !!active && (active === `history:${c.id}` || active.startsWith(`read:${c.id}:`));
            return (
              <div key={c.id} className={`sb-item${activeRelCtx === c.id ? " sel" : ""}`} role="button" tabIndex={0}
                onClick={() => openContext(c)} onKeyDown={(e) => e.key === "Enter" && openContext(c)}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, ctx: c }); }}>
                <div className="sb-main">
                  <div className="sb-r1">
                    <span className="sb-name">{c.name}</span>
                    <span className="tag acc-c" style={accVars(acc.color)}>{acc.name}</span>
                  </div>
                  <div className="sb-r2">
                    {working && <span className="dot" />}
                    {waiting && <span className="dot waiting" />}
                    <span className="sb-chat">{c.chat?.name ?? t("No chat")}</span>
                    {waiting ? <time className="waiting-label">{t("waiting for you")}</time> : <time>{working ? t("now") : timeAgo(c.lastUsed, now)}</time>}
                  </div>
                </div>
                {histOn && <span className="sb-mark" title={t("Past chats open")}><Icon name="clock" size={14} /></span>}
              </div>
            );
          })}
        </div>
        <div className="sb-foot">
          <button className={`nav${active === ACCOUNTS ? " sel" : ""}`} onClick={() => openTab(ACCOUNTS)}><Icon name="user" />{t("Accounts")}<span className="tag">{state.accounts.length}</span></button>
          <div className="sb-foot-row">
            <button className={`nav${active === SETTINGS ? " sel" : ""}`} onClick={() => openTab(SETTINGS)}><Icon name="settings" />{t("Settings")}</button>
            <button className="theme-toggle" title={dark ? t("Switch to light theme") : t("Switch to dark theme")}
              onClick={() => update((s) => ({ ...s, settings: { ...s.settings, theme: dark ? "light" : "dark" } }))}>
              <Icon name={dark ? "sun" : "moon"} />
            </button>
          </div>
        </div>
      </aside>

      <div className="wrap">
        <div className="titlebar" data-tauri-drag-region>
          <Cooking items={cooking} open={cookingOpen} now={now} shortcut="Ctrl+Shift+Space"
            onToggle={() => setCookingOpen((o) => !o)} onClose={() => setCookingOpen(false)}
            onOpen={(id) => { setCookingOpen(false); const c = ctxById(id); if (c) openContext(c); }} />
          {import.meta.env.DEV && (
            <span className="dev-badge" data-tauri-drag-region title={t("Development build")}>
              <Icon name="wrench" size={13} /><span>DEV</span>
            </span>
          )}
          <div className="win">
            <button title={t("Minimize")} onClick={win.minimize}><Icon name="min" /></button>
            <button title={t("Maximize")} onClick={win.toggleMaximize}><Icon name="max" /></button>
            <button className="close" title={t("Close")} onClick={win.close}><Icon name="x" /></button>
          </div>
        </div>
        <main>
          <div className="tabs">
            {state.openTabs.map((id) => {
              const m = tabMeta(id);
              if (!m) return null;
              return (
                <div key={id} className={`tab${active === id ? " on" : ""}${m.sandbox ? " sbx" : ""}`} onClick={() => openTab(id)} title={m.label}
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } }}>
                  {m.waiting ? <span className="dot waiting" /> : m.dot ? <span className="dot" /> : m.icon && <Icon name={m.icon} size={14} />}
                  <span className="label">{m.label}</span>
                  {m.acc && <span className="ini acc-c" style={accVars(m.acc.color)}>{m.acc.name[0]?.toUpperCase()}</span>}
                  <button className="close" title={t("Close")} onClick={(e) => { e.stopPropagation(); closeTab(id); }}><Icon name="x" size={14} /></button>
                </div>
              );
            })}
          </div>

          {claudeVersion === null && (
            <div className="banner">
              <Icon name="alert" size={16} />
              <span>{t("Claude Code is not installed or cannot be reached: chats cannot start.")}</span>
              <div className="right">
                <button className="btn" onClick={() => checkClaude(false)}><Icon name="refresh" size={14} />{t("Check again")}</button>
                <button className="btn pri" onClick={installClaude}><Icon name="download" size={14} />{t("Install Claude Code")}</button>
              </div>
            </div>
          )}

          {active === NEW && (
            <ContextForm accounts={state.accounts} contexts={state.contexts} historyRoot={historyRoot} shells={shellList} onSubmit={createContext} onCancel={() => closeTab(NEW)} />
          )}
          {active?.startsWith("edit:") && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <ContextForm key={active} accounts={state.accounts} contexts={state.contexts} initial={c} historyRoot={historyRoot} shells={shellList}
              onSubmit={(input) => saveContextEdit(c, input)} onCancel={() => closeTab(active)} />;
          })()}
          {active?.startsWith("sandboxes:") && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <SandboxPage ctx={c} account={accountOf(c.accountId)} sandboxes={sandboxesOf(c.id)} now={now}
              stateOf={(id) => (isWaiting(id) ? "waiting" : isWorking(id) ? "working" : "idle")}
              onOpen={openContext} onDiscard={setDeleting} />;
          })()}
          {active?.startsWith("history:") && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <HistoryPage ctx={c} account={accountOf(c.accountId)} historyRoot={historyRoot(c.dirName)} version={historyVersion}
              onToggleImportant={(e, on) => setImportant(c, e, on)}
              onOpen={(e) => openPast(c.id, e)} />;
          })()}
          {active === SEARCH && (
            <SearchPage initialQuery={searchQuery} contexts={state.contexts.filter((c) => !c.sandbox)} accountOf={accountOf}
              onOpen={(ctxId, e) => openPast(ctxId, e)} />
          )}
          {active?.startsWith("read:") && readEntries[active] && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <ReadOnlyChat entry={readEntries[active]} currentChatBusy={isWorking(c.id)} onResume={(p) => resumeInCurrent(c, p)}
              onToggleImportant={(on) => setImportant(c, readEntries[active], on)} />;
          })()}
          {active === ACCOUNTS && (
            <AccountsPage accounts={state.accounts} contexts={state.contexts.filter((c) => !c.sandbox)} version={accountsVersion}
              onAdd={addAccount} onUpdate={updateAccount} onRemove={removeAccount} onLogin={login}
              onUsage={(a) => openTab(`usage:${a.id}`)} />
          )}
          {active?.startsWith("usage:") && (() => {
            const a = state.accounts.find((x) => x.id === active.slice(6));
            return a ? <UsagePage key={a.id} account={a} contexts={state.contexts.filter((c) => c.accountId === a.id && !c.sandbox)} limits={limits[a.id] ?? null} /> : null;
          })()}
          {active === SETTINGS && (
            <SettingsPage settings={state.settings} dataDir={paths.dataDir} claudeVersion={claudeVersion} claudeLatest={claudeLatest}
              onChange={(settings) => update((s) => ({ ...s, settings }))}
              onRecheck={() => checkClaude(false)}
              onInstall={installClaude} onUpdate={updateClaude}
              appVersion={appVer} appUpdate={appUpdate} onCheckAppUpdate={() => checkApp(false)} onInstallAppUpdate={installApp} />
          )}

          {activeCtx && (
            <ChatHeader ctx={activeCtx} working={isWorking(activeCtx.id)} waiting={isWaiting(activeCtx.id)} archiving={!!archiving[activeCtx.id]}
              limits={limits[activeCtx.accountId] ?? null} line={lines[activeCtx.id] ?? null}
              chatRef={activeCtx.chat ? { configDir: accountOf(activeCtx.accountId).configDir, cwd: workingDir(activeCtx), sessionId: activeCtx.chat.sessionId } : null}
              onUsage={() => openTab(`usage:${activeCtx.accountId}`)}
              onRename={(name) => activeCtx.chat && patchContext(activeCtx.id, { chat: { ...activeCtx.chat, name, nameLocked: true } })}
              onNewChat={() => startNewChat(activeCtx)}
              onHistory={() => openTab(`history:${activeCtx.id}`)}
              onEdit={() => openTab(`edit:${activeCtx.id}`)}
              onDelete={() => setDeleting(activeCtx)}
              shellOpen={shellOpen} shellHint={shellHint} onToggleShell={() => toggleShell(activeCtx)}
              sandboxCount={sandboxesOf(activeCtx.id).length} onSandboxes={() => openTab(`sandboxes:${activeCtx.id}`)}
              changesCount={sbxFiles[activeCtx.id]?.length ?? 0} changesOpen={!!changesOpen[activeCtx.id]}
              onToggleChanges={() => setChangesOpen((x) => ({ ...x, [activeCtx.id]: !x[activeCtx.id] }))}
              onDetach={() => setDetaching(activeCtx)} onOpenFolder={() => activeCtx.sandbox && api.openFolder(activeCtx.sandbox.root)} />
          )}
          {active?.startsWith("aux:") && aux[active] && (
            <div className="chat-head"><h1>{aux[active].label}</h1>
              {active.startsWith("aux:login:") && <span className="meta">{t("Follow Claude Code's instructions to sign in, then close the tab.")}</span>}
            </div>
          )}

          <div className="work-row" style={{ display: showTerms ? "flex" : "none" }}>
          <div ref={workRef} className={`work work-${shellPanel.side}`}>
          <div className="terms">
            {activeCtx && archiving[activeCtx.id] && !runs[activeCtx.id] && (
              <div className="term-wait">
                <span className="dot" />
                <div>
                  <b>{t("Saving and summarizing the previous chat…")}</b>
                  <p>{t("The new chat starts as soon as the summary is ready, so it knows what was done before.")}</p>
                </div>
              </div>
            )}
            {Object.entries(runs).map(([id, spec]) => (
              <Terminal key={spec.ptyId} spec={spec} visible={id === active}
                onActivity={() => onActivity(id)}
                onTitle={(t) => onTitle(id, t)}
                fontSize={terminalFontSize(state.settings.terminalScale)}
                onExit={() => { delete lastOutput.current[id]; aux[id]?.onExit?.(); }} />
            ))}
            {dropping && showTerms && (
              <div className="drop-hint"><Icon name="file" size={18} />{t("Drop to insert the path into the chat")}</div>
            )}
          </div>
          {shellOpen && <div className="shell-grip" role="separator" aria-orientation={shellPanel.side === "bottom" ? "horizontal" : "vertical"} onMouseDown={resizeShell}><i /></div>}
          <ShellPanel shells={shells} activeCtx={activeCtx?.id ?? null} side={shellPanel.side}
            style={shellPanel.side === "bottom" ? { height: shellPanel.size } : { width: shellPanel.size }}
            folder={activeCtx ? workingDir(activeCtx) : ""} fontSize={terminalFontSize(state.settings.terminalScale)}
            onAdd={() => activeCtx && addShell(activeCtx)}
            onSelect={(ptyId) => { shellFocus.current = ptyId; if (activeCtx) patchShells(activeCtx.id, (cs) => ({ ...cs, active: ptyId })); }}
            claimFocus={(ptyId) => { const mine = shellFocus.current === ptyId; if (mine) shellFocus.current = null; return mine; }}
            onClose={closeShell}
            onTitle={(ctxId, ptyId, title) => patchShells(ctxId, (cs) => ({ ...cs, tabs: cs.tabs.map((x) => (x.ptyId === ptyId ? { ...x, title } : x)) }))}
            onToggleSide={() => update((s) => ({ ...s, settings: { ...s.settings, shellPanel: { side: shellPanel.side === "bottom" ? "right" : "bottom", size: shellPanel.side === "bottom" ? 480 : 260 } } }))}
            onHide={() => { if (activeCtx) { patchShells(activeCtx.id, (cs) => ({ ...cs, open: false })); focusClaude(activeCtx.id); } }} />
          </div>
          {activeCtx?.sandbox && changesOpen[activeCtx.id] && (
            <ChangesPanel files={sbxFiles[activeCtx.id]} root={activeCtx.sandbox.root} base={activeCtx.sandbox.base}
              summary={sbxSummary[activeCtx.id] ?? null} summarizing={!!summarizing[activeCtx.id]} summaryOff={state.settings.summaryModel === "off"}
              onSummarize={() => summarizeSandbox(activeCtx)} onApply={() => applySandbox(activeCtx)}
              onOpenFolder={() => api.openFolder(activeCtx.sandbox!.root)} onDiscard={() => setDeleting(activeCtx)}
              onClose={() => setChangesOpen((x) => ({ ...x, [activeCtx.id]: false }))}
              branch={activeCtx.sandbox.branch}
              onBranch={activeCtx.sandbox.kind === "git" && activeCtx.sandbox.repo ? () => setBranching(activeCtx) : undefined} />
          )}
          </div>

          {!active && (
            <div className="empty">
              <div className="box">
                <Logo height={72} />
                <h2>{t("No chat open")}</h2>
                <p>{t("Open a context from the sidebar, or create a new one by choosing folders and an account.")}</p>
                <button className="btn pri" onClick={() => openTab(NEW)}><Icon name="plus" size={14} />{t("New context")}</button>
              </div>
            </div>
          )}
        </main>
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} items={[
          { label: t("Past chats ({n})", { n: historyCounts[ctxMenu.ctx.id] ?? 0 }), icon: "clock", onClick: () => openTab(`history:${ctxMenu.ctx.id}`) },
          { label: t("Sandboxes ({n})", { n: sandboxesOf(ctxMenu.ctx.id).length }), icon: "box", onClick: () => openTab(`sandboxes:${ctxMenu.ctx.id}`) },
          { label: t("Edit context"), icon: "pen", onClick: () => openTab(`edit:${ctxMenu.ctx.id}`) },
          { label: t("Delete context"), icon: "trash", danger: true, onClick: () => setDeleting(ctxMenu.ctx) },
        ]} />
      )}
      {about && (
        <About appVersion={appVer} claudeVersion={claudeVersion} appUpdate={appUpdate}
          onCheck={() => checkApp(false)} onInstall={() => { setAbout(false); installApp(); }} onClose={() => setAbout(false)} />
      )}
      {appUpdateAsk && (appUpdate.status === "available" || appUpdate.status === "installing") && (
        <Dialog title={t("Update Gian Claudio?")} width={480} onClose={() => appUpdate.status !== "installing" && setAppUpdateAsk(false)}>
          <div className="dbody">
            <p>{tn("Gian Claudio {latest} is available (you have {current}). The app restarts to install it; open chats resume afterwards.", {
              latest: <b>{appUpdate.update.version}</b>, current: appUpdate.update.currentVersion,
            })}</p>
            {appUpdate.update.body && <div className="update-notes"><Rich text={appUpdate.update.body} /></div>}
          </div>
          <div className="dfoot">
            {appUpdate.status === "installing" && (
              <span className="info">{appUpdate.percent === null ? t("Downloading the update…") : t("Downloading the update… {n}%", { n: Math.round(appUpdate.percent) })}</span>
            )}
            <div className="right">
              <button className="btn ghost" disabled={appUpdate.status === "installing"} onClick={() => setAppUpdateAsk(false)}>{t("Not now")}</button>
              <button className="btn pri" autoFocus disabled={appUpdate.status === "installing"} onClick={installApp}>{t("Update and restart")}</button>
            </div>
          </div>
        </Dialog>
      )}
      {updateAsk && !appUpdateAsk && (
        <Confirm title={t("Update Claude Code?")} confirmLabel={t("Update")} cancelLabel={t("Not now")}
          onClose={() => setUpdateAsk(null)} onConfirm={updateClaude}
          text={<p>{tn("Claude Code {latest} is available (you have {installed}). The update opens in a tab; chats already open switch to the new version when you restart them.", { latest: <b>{versionNumber(updateAsk.latest)}</b>, installed: versionNumber(updateAsk.installed) })}</p>} />
      )}
      {deleting?.sandbox && (
        <Confirm title={t("Throw away the sandbox?")} danger confirmLabel={t("Throw away")} onClose={() => setDeleting(null)} onConfirm={() => deleteContext(deleting)}
          text={<p>{tn("The sandbox {name} is deleted with its folder and all the changes made in it; its chat is closed. The context's folder is not touched. This cannot be undone.", { name: <b>{deleting.chat?.name ?? deleting.name}</b> })}</p>} />
      )}
      {branching?.sandbox?.repo && (
        <BranchDialog repo={branching.sandbox.repo} start={branching.sandbox.start ?? branching.sandbox.base ?? "HEAD"} existing={branching.sandbox.branch}
          defaultName={slug(branching.chat?.name ?? "") || "sandbox"} proposeMessage={() => proposeCommitMessage(branching)}
          onCreate={(input) => branchSandbox(branching, input)} onClose={() => setBranching(null)} />
      )}
      {detaching?.chat && (
        <SandboxDialog dir={workingDir(detaching)} defaultName={slug(detaching.chat.name) || "sandbox"} remembered={detaching.sandboxCopy}
          onCancel={() => setDetaching(null)} onCreate={(input) => createSandbox(detaching, input)} />
      )}
      {deleting && !deleting.sandbox && (
        <Confirm title={t("Delete the context?")} danger confirmLabel={t("Delete context")} onClose={() => setDeleting(null)} onConfirm={() => deleteContext(deleting)}
          text={<p>{tn("The context {name} is deleted together with its past chats; the current chat is closed. The project folders are not touched. This cannot be undone.", { name: <b>{deleting.name}</b> })}</p>} />
      )}
    </div>
  );
}

function ChatHeader({ ctx, working, waiting, archiving, limits, line, chatRef, onUsage, onRename, onNewChat, onHistory, onEdit, onDelete, shellOpen, shellHint, onToggleShell, onDetach, onOpenFolder, sandboxCount, onSandboxes, changesCount, changesOpen, onToggleChanges }: {
  ctx: Context; working: boolean; waiting: boolean; archiving: boolean; limits: AccountLimits | null; line: ContextLine | null; chatRef: ChatRef | null; onUsage: () => void;
  onRename: (name: string) => void; onNewChat: () => void; onHistory: () => void; onEdit: () => void; onDelete: () => void;
  shellOpen: boolean; shellHint: string; onToggleShell: () => void;
  onDetach: () => void; onOpenFolder: () => void; sandboxCount: number; onSandboxes: () => void;
  changesCount: number; changesOpen: boolean; onToggleChanges: () => void;
}) {
  const sbx = ctx.sandbox;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = ctx.chat?.name ?? ctx.name;

  function commit() {
    if (draft.trim()) onRename(draft.trim());
    setEditing(false);
  }

  return (
    <div className="chat-head">
      {editing ? (
        <input className="name-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />
      ) : (
        <>
          <h1>{title}</h1>
          <button className="icon-btn" title={t("Rename chat")} onClick={() => { setDraft(title); setEditing(true); }}><Icon name="pen" size={14} /></button>
        </>
      )}
      {sbx && (
        <button className="chip sbx" title={t("Open the folder: {path}", { path: sbx.root })} onClick={() => api.openFolder(sbx.root)}>
          <Icon name="box" size={13} />{t("Sandbox · from {chat}", { chat: sbx.origin })}
        </button>
      )}
      {!sbx && ctx.folders.map((f, i) => (
        <button key={f.path} className={`chip${i === ctx.workingIndex ? " wd" : ""}`} onClick={() => api.openFolder(f.path)}
          title={i === ctx.workingIndex ? t("Working folder: {path} · click to open it", { path: f.path }) : t("Open the folder: {path}", { path: f.path })}>
          <Icon name="folder" size={13} />{folderName(f.path)}
        </button>
      ))}
      <div className="right">
        {archiving && <span className="why">{t("Saving the previous chat to the history…")}</span>}
        {waiting && <span className="why waiting-label"><span className="dot waiting" />{t("Claude is waiting for your answer")}</span>}
        <UsageDonut limits={limits} line={line} chat={chatRef} onOpenUsage={onUsage} />
        {!sbx && (
          <button className="btn icon" disabled={!ctx.chat} title={t("Detach into a Sandbox")} aria-label={t("Detach into a Sandbox")} onClick={onDetach}><Icon name="detach" /></button>
        )}
        {sbx && (
          <button className={`btn icon has-badge${changesOpen ? " on" : ""}`} title={t("What was done here")} aria-pressed={changesOpen} onClick={onToggleChanges}>
            <Icon name="changes" />{changesCount > 0 && <span className="badge">{changesCount}</span>}
          </button>
        )}
        <button className={`btn icon${shellOpen ? " on" : ""}`} title={`${t("Terminal")} (${shellHint})`} aria-pressed={shellOpen} onClick={onToggleShell}><Icon name="terminal" /></button>
        {!sbx && (
          <button className="btn pri icon" disabled={working} title={working ? t("Available when Claude is done") : t("New chat")} aria-label={t("New chat")} onClick={onNewChat}><Icon name="plus" /></button>
        )}
        <Menu items={sbx ? [
          { label: t("Open folder"), icon: "folder", onClick: onOpenFolder },
          { label: t("Throw away the sandbox…"), icon: "trash", danger: true, onClick: onDelete },
        ] : [
          { label: t("Past chats"), icon: "clock", onClick: onHistory },
          { label: t("Sandboxes ({n})", { n: sandboxCount }), icon: "box", onClick: onSandboxes },
          { label: t("Edit context"), icon: "pen", onClick: onEdit },
          { label: t("Delete context"), icon: "trash", danger: true, onClick: onDelete },
        ]} />
      </div>
    </div>
  );
}
