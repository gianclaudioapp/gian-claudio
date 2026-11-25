import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SearchPage } from "./SearchPage";
import { UsageDonut, UsagePage } from "./Usage";
import { AccountLimits, ContextLine, api } from "./api";
import { AccountsPage } from "./AccountsPage";
import { ContextForm, ContextInput } from "./ContextForm";
import { HistoryPage } from "./HistoryPage";
import { Icon, IconName } from "./icons";
import { Logo } from "./Logo";
import { Account, AppState, Chat, Context, HistoryEntry, newId, timeAgo, accVars, uniqueDirName, workingDir, folderName, terminalFontSize, isNewerVersion, versionNumber } from "./model";
import { ReadOnlyChat } from "./ReadOnlyChat";
import { SettingsPage } from "./SettingsPage";
import { LaunchSpec, Terminal } from "./Terminal";
import { Confirm, ContextMenu, Menu } from "./ui";
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
  !t ? null : t.startsWith("edit:") || t.startsWith("history:") ? t.split(":")[1] : t.startsWith("read:") ? t.split(":")[1] : null;

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
  const [runs, setRuns] = useState<Record<string, LaunchSpec>>({});
  const [aux, setAux] = useState<Record<string, AuxTab>>({});
  const [readEntries, setReadEntries] = useState<Record<string, HistoryEntry>>({});
  const [historyCounts, setHistoryCounts] = useState<Record<string, number>>({});
  const [historyVersion, setHistoryVersion] = useState(0);
  const [accountsVersion, setAccountsVersion] = useState(0);
  const [archiving, setArchiving] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Context | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; ctx: Context } | null>(null);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [hook, setHook] = useState<Record<string, HookState>>({});
  const [lines, setLines] = useState<Record<string, ContextLine>>({});
  const [limits, setLimits] = useState<Record<string, AccountLimits>>({});
  const [dropping, setDropping] = useState(false);
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
    const resume = !fresh && (await api.sessionExists(acc.configDir, cwd, chat.sessionId));
    const args = resume ? ["--resume", chat.sessionId] : ["--session-id", chat.sessionId];
    ctx.folders.forEach((f, i) => {
      if (i !== ctx.workingIndex) args.push("--add-dir", f.path);
    });
    // Latest chat + important chats, summarized, plus where the history lives.
    // A file, not an argument: cmd.exe would cut long or multi-line text.
    const promptFile = await api.contextPromptFile(ctx.dirName);
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
      for (const [tabId, spec] of entries) {
        const st = read[spec.ptyId]?.state as HookState | undefined;
        if (st) next[tabId] = st;
      }
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
    patchContext(ctx.id, { name: input.name, folders: input.folders.map((path) => ({ path })), workingIndex: input.workingIndex });
    closeTab(`edit:${ctx.id}`);
    openTab(ctx.id);
    if (!runs[ctx.id] && ctx.chat) launch({ ...ctx, folders: input.folders.map((path) => ({ path })), workingIndex: input.workingIndex }, ctx.chat, false);
  }

  /** Remove a context and everything stored for it (its history). */
  function deleteContext(ctx: Context) {
    api.contextRemoveFiles(ctx.dirName).catch(() => {});
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
  const win = {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
  };

  function tabMeta(id: string): { label: string; icon?: IconName; dot?: boolean; waiting?: boolean; acc?: Account } | null {
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
    if (id.startsWith("read:")) return readEntries[id] ? { label: readEntries[id].name, icon: "lock", acc } : null;
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

  const activeRelCtx = ctxOfTab(active) ?? (activeCtx ? activeCtx.id : null);

  return (
    <div className="app">
      <aside>
        <div className="brand" data-tauri-drag-region>
          <Logo height={20} />
          Gian Claudio
          <button className="add" onClick={() => openTab(NEW)}><Icon name="plus" size={14} />{t("Context")}</button>
        </div>
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
                <div key={id} className={`tab${active === id ? " on" : ""}`} onClick={() => openTab(id)} title={m.label}
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
            <ContextForm accounts={state.accounts} contexts={state.contexts} historyRoot={historyRoot} onSubmit={createContext} onCancel={() => closeTab(NEW)} />
          )}
          {active?.startsWith("edit:") && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <ContextForm key={active} accounts={state.accounts} contexts={state.contexts} initial={c} historyRoot={historyRoot}
              onSubmit={(input) => saveContextEdit(c, input)} onCancel={() => closeTab(active)} />;
          })()}
          {active?.startsWith("history:") && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <HistoryPage ctx={c} account={accountOf(c.accountId)} historyRoot={historyRoot(c.dirName)} version={historyVersion}
              onToggleImportant={(e, on) => setImportant(c, e, on)}
              onOpen={(e) => openPast(c.id, e)} />;
          })()}
          {active === SEARCH && (
            <SearchPage initialQuery={searchQuery} contexts={state.contexts} accountOf={accountOf}
              onOpen={(ctxId, e) => openPast(ctxId, e)} />
          )}
          {active?.startsWith("read:") && readEntries[active] && ctxById(ctxOfTab(active)) && (() => {
            const c = ctxById(ctxOfTab(active))!;
            return <ReadOnlyChat entry={readEntries[active]} currentChatBusy={isWorking(c.id)} onResume={(p) => resumeInCurrent(c, p)}
              onToggleImportant={(on) => setImportant(c, readEntries[active], on)} />;
          })()}
          {active === ACCOUNTS && (
            <AccountsPage accounts={state.accounts} contexts={state.contexts} version={accountsVersion}
              onAdd={addAccount} onUpdate={updateAccount} onRemove={removeAccount} onLogin={login}
              onUsage={(a) => openTab(`usage:${a.id}`)} />
          )}
          {active?.startsWith("usage:") && (() => {
            const a = state.accounts.find((x) => x.id === active.slice(6));
            return a ? <UsagePage key={a.id} account={a} contexts={state.contexts.filter((c) => c.accountId === a.id)} limits={limits[a.id] ?? null} /> : null;
          })()}
          {active === SETTINGS && (
            <SettingsPage settings={state.settings} dataDir={paths.dataDir} claudeVersion={claudeVersion} claudeLatest={claudeLatest}
              onChange={(settings) => update((s) => ({ ...s, settings }))}
              onRecheck={() => checkClaude(false)}
              onInstall={installClaude} onUpdate={updateClaude} />
          )}

          {activeCtx && (
            <ChatHeader ctx={activeCtx} working={isWorking(activeCtx.id)} waiting={isWaiting(activeCtx.id)} archiving={!!archiving[activeCtx.id]}
              limits={limits[activeCtx.accountId] ?? null} line={lines[activeCtx.id] ?? null}
              onUsage={() => openTab(`usage:${activeCtx.accountId}`)}
              onRename={(name) => activeCtx.chat && patchContext(activeCtx.id, { chat: { ...activeCtx.chat, name, nameLocked: true } })}
              onNewChat={() => startNewChat(activeCtx)}
              onHistory={() => openTab(`history:${activeCtx.id}`)}
              onEdit={() => openTab(`edit:${activeCtx.id}`)}
              onDelete={() => setDeleting(activeCtx)} />
          )}
          {active?.startsWith("aux:") && aux[active] && (
            <div className="chat-head"><h1>{aux[active].label}</h1>
              {active.startsWith("aux:login:") && <span className="meta">{t("Follow Claude Code's instructions to sign in, then close the tab.")}</span>}
            </div>
          )}

          <div className="terms" style={{ display: showTerms ? "block" : "none" }}>
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
          { label: t("Edit context"), icon: "pen", onClick: () => openTab(`edit:${ctxMenu.ctx.id}`) },
          { label: t("Delete context"), icon: "trash", danger: true, onClick: () => setDeleting(ctxMenu.ctx) },
        ]} />
      )}
      {updateAsk && (
        <Confirm title={t("Update Claude Code?")} confirmLabel={t("Update")} cancelLabel={t("Not now")}
          onClose={() => setUpdateAsk(null)} onConfirm={updateClaude}
          text={<p>{tn("Claude Code {latest} is available (you have {installed}). The update opens in a tab; chats already open switch to the new version when you restart them.", { latest: <b>{versionNumber(updateAsk.latest)}</b>, installed: versionNumber(updateAsk.installed) })}</p>} />
      )}
      {deleting && (
        <Confirm title={t("Delete the context?")} danger confirmLabel={t("Delete context")} onClose={() => setDeleting(null)} onConfirm={() => deleteContext(deleting)}
          text={<p>{tn("The context {name} is deleted together with its past chats; the current chat is closed. The project folders are not touched. This cannot be undone.", { name: <b>{deleting.name}</b> })}</p>} />
      )}
    </div>
  );
}

function ChatHeader({ ctx, working, waiting, archiving, limits, line, onUsage, onRename, onNewChat, onHistory, onEdit, onDelete }: {
  ctx: Context; working: boolean; waiting: boolean; archiving: boolean; limits: AccountLimits | null; line: ContextLine | null; onUsage: () => void;
  onRename: (name: string) => void; onNewChat: () => void; onHistory: () => void; onEdit: () => void; onDelete: () => void;
}) {
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
      {ctx.folders.map((f, i) => (
        <span key={f.path} className={`chip${i === ctx.workingIndex ? " wd" : ""}`} title={i === ctx.workingIndex ? t("Working folder: {path}", { path: f.path }) : f.path}>
          <Icon name="folder" size={13} />{folderName(f.path)}
        </span>
      ))}
      <div className="right">
        {archiving && <span className="why">{t("Saving the previous chat to the history…")}</span>}
        {waiting && <span className="why waiting-label"><span className="dot waiting" />{t("Claude is waiting for your answer")}</span>}
        {working && !archiving && <span className="why">{t("Available when Claude is done")}</span>}
        <UsageDonut limits={limits} line={line} onOpenUsage={onUsage} />
        <button className="btn" disabled={working} onClick={onNewChat}><Icon name="plus" size={14} />{t("New chat")}</button>
        <Menu items={[
          { label: t("Past chats"), icon: "clock", onClick: onHistory },
          { label: t("Edit context"), icon: "pen", onClick: onEdit },
          { label: t("Delete context"), icon: "trash", danger: true, onClick: onDelete },
        ]} />
      </div>
    </div>
  );
}
