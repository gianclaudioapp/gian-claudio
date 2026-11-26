// "Cooking": every chat that is working or waiting for you, in all contexts
// (sandboxes too), one click away. The button in the title bar shows the counts.
import { useEffect, useRef } from "react";
import { HookStatus } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";
import { Account, accVars } from "./model";

export interface CookingItem {
  id: string;
  state: "working" | "waiting";
  context: string;
  chat: string;
  account: Account;
  sandbox: boolean;
  info: HookStatus | null;
}

interface Props {
  items: CookingItem[];
  open: boolean;
  now: number;
  shortcut: string;
  onToggle: () => void;
  onClose: () => void;
  onOpen: (id: string) => void;
}

function since(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return t("just now");
  if (m < 60) return t("for {n} min", { n: m });
  return t("for {h} h {m} min", { h: Math.floor(m / 60), m: m % 60 });
}

/** What Claude is doing, from the last tool it used. */
function doing(info: HookStatus | null): string {
  const d = info?.detail ?? "";
  switch (info?.tool) {
    case undefined: case null: return t("Thinking…");
    case "Bash": case "PowerShell": return t("Runs {what}", { what: d });
    case "Edit": case "MultiEdit": case "NotebookEdit": return t("Edits {what}", { what: d });
    case "Write": return t("Writes {what}", { what: d });
    case "Read": return t("Reads {what}", { what: d });
    case "Grep": case "Glob": return t("Searches {what}", { what: d });
    case "WebFetch": case "WebSearch": return t("Looks on the web: {what}", { what: d });
    case "Task": case "Agent": return t("Runs an agent: {what}", { what: d });
    default: return d ? `${info!.tool}: ${d}` : t("Uses {tool}", { tool: info!.tool! });
  }
}

/** What Claude asks: a permission (with the command or file) or an answer. */
function asks(info: HookStatus | null): { text: string; code: string | null } {
  const m = info?.message ?? "";
  if (/permission/i.test(m) && info?.tool) return { text: t("Asks permission to use {tool}:", { tool: info.tool }), code: info.detail };
  if (/permission/i.test(m)) return { text: t("Asks for a permission."), code: null };
  if (!m || /waiting for your input/i.test(m)) return { text: t("Is waiting for your answer."), code: null };
  return { text: m, code: null };
}

export function Cooking({ items, open, now, shortcut, onToggle, onClose, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key);
    };
  }, [open, onClose]);

  const waiting = items.filter((i) => i.state === "waiting");
  const working = items.filter((i) => i.state === "working");
  const row = (i: CookingItem) => {
    const ask = i.state === "waiting" ? asks(i.info) : null;
    return (
      <button key={i.id} className="ck-row" onClick={() => onOpen(i.id)}>
        <span className="ck-main">
          <span className="ck-t">
            {i.sandbox && <span className="ck-sbx" title={t("Sandbox")}><Icon name="box" size={12} /></span>}
            <b>{i.context}</b><span className="ck-chat">· {i.chat}</span>
            <span className="tag acc-c" style={accVars(i.account.color)}>{i.account.name}</span>
          </span>
          {ask ? (
            <span className="ck-ask">{ask.text}{ask.code && <> <code>{ask.code}</code></>}</span>
          ) : (
            <span className="ck-doing">{doing(i.info)}</span>
          )}
        </span>
        <time>{i.info ? since(i.info.since || i.info.ts, now) : ""}</time>
      </button>
    );
  };

  return (
    <div className="ck" ref={ref}>
      <button className={`ck-pill${open ? " on" : ""}`} onClick={onToggle} title={`${t("Cooking")} (${shortcut})`} aria-expanded={open}>
        <span>{t("Cooking")}</span>
        {working.length > 0 && <span className="ck-n"><span className="dot" />{working.length}</span>}
        {waiting.length > 0 && <span className="ck-n"><span className="dot waiting" />{waiting.length}</span>}
      </button>
      {open && (
        <div className="ck-pop" role="dialog" aria-label={t("Cooking")}>
          <div className="ck-h">
            <h3>{t("Cooking")}</h3>
            <span>{items.length === 0 ? t("nothing on the stove") : items.length === 1 ? t("1 active chat") : t("{n} active chats", { n: items.length })}</span>
          </div>
          {items.length === 0 && <p className="ck-empty">{t("When Claude works or waits for you in a chat, it shows up here.")}</p>}
          {waiting.length > 0 && (
            <>
              <div className="ck-sec ck-wait"><span className="dot waiting" />{t("Waiting for you · {n}", { n: waiting.length })}</div>
              {waiting.map(row)}
            </>
          )}
          {working.length > 0 && (
            <>
              <div className="ck-sec ck-work"><span className="dot" />{t("Working · {n}", { n: working.length })}</div>
              {working.map(row)}
            </>
          )}
          <div className="ck-f">{t("A click opens the chat")} · <kbd>{shortcut}</kbd> {t("from any tab")}</div>
        </div>
      )}
    </div>
  );
}
