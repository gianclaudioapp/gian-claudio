import { ReactNode, useEffect, useState } from "react";
import Markdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { Icon } from "./icons";
import { HistoryEntry, durationLabel, fmtTime } from "./model";
import { locale, t } from "./i18n";

/** A transcript reduced to what the read-only view shows. */
type Item =
  | { kind: "msg"; user: boolean; time: string; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; result: string | null; error: boolean };

function parse(raw: string): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let v: any;
    try { v = JSON.parse(line); } catch { continue; }
    if ((v.type !== "user" && v.type !== "assistant") || v.isMeta || v.isSidechain) continue;
    const user = v.type === "user";
    const content = v.message?.content;
    const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === "text") {
        const text = cleanText(b.text ?? "");
        if (text) items.push({ kind: "msg", user, time: v.timestamp ?? "", text });
      } else if (b.type === "tool_use") {
        const tool = { kind: "tool" as const, name: b.name ?? "?", input: b.input ?? {}, result: null, error: false };
        tools.set(b.id, tool);
        items.push(tool);
      } else if (b.type === "tool_result") {
        const tool = tools.get(b.tool_use_id);
        if (tool) {
          tool.result = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : "";
          tool.error = !!b.is_error;
        }
      }
    }
  }
  return items;
}

function cleanText(s: string): string {
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(s);
  if (cmd) return "`" + cmd[1].trim() + "`";
  if (s.includes("<local-command-stdout>") || s.includes("<local-command-caveat>") || s.startsWith("<system-reminder>")) return "";
  return s.trim();
}

/** Links open in the browser, never inside the app window. */
const mdComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} title={href} onClick={(e) => {
      e.preventDefault();
      if (href && /^(https?:|mailto:)/i.test(href)) openUrl(href).catch(() => {});
    }}>{children}</a>
  ),
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
};

/** Claude's Markdown (GitHub flavour: tables, task lists). Raw HTML is shown as text. */
export function Rich({ text }: { text: string }) {
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</Markdown></div>;
}

function toolSummary(tool: Extract<Item, { kind: "tool" }>): { target: string; stat: ReactNode } {
  const inp = tool.input as Record<string, string>;
  const target = inp.file_path ?? inp.command ?? inp.pattern ?? inp.path ?? inp.url ?? inp.description ?? "";
  let stat: ReactNode = null;
  if (tool.name === "Edit" && typeof inp.old_string === "string") {
    const minus = inp.old_string.split("\n").length;
    const plus = (inp.new_string ?? "").split("\n").length;
    stat = <span className="stat"><span className="plus">+{plus}</span> <span className="minus">−{minus}</span></span>;
  } else if (tool.name === "Read" && tool.result) {
    const n = tool.result.split("\n").length;
    stat = <span className="stat">{n === 1 ? t("1 line") : t("{n} lines", { n })}</span>;
  } else if (tool.error) {
    stat = <span className="stat minus">{t("error")}</span>;
  }
  return { target: String(target).split("\n")[0], stat };
}

function ToolRow({ tool }: { tool: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const { target, stat } = toolSummary(tool);
  const inp = tool.input as Record<string, string>;
  return (
    <div className={`tool${open ? " open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <b>{tool.name}</b>{target && <span className="tool-target"> · {target}</span>}
        {stat}
      </button>
      {open && (
        tool.name === "Edit" && typeof inp.old_string === "string" ? (
          <div className="diff">
            {inp.old_string.split("\n").map((l, i) => <div key={"d" + i} className="d">- {l}</div>)}
            {(inp.new_string ?? "").split("\n").map((l, i) => <div key={"a" + i} className="a">+ {l}</div>)}
          </div>
        ) : tool.name === "Write" && typeof inp.content === "string" ? (
          <pre className="tool-out">{inp.content.slice(0, 4000)}</pre>
        ) : (
          <pre className="tool-out">{(tool.result ?? t("(no output)")).slice(0, 4000)}</pre>
        )
      )}
    </div>
  );
}

interface Props {
  entry: HistoryEntry;
  currentChatBusy: boolean;
  onResume: (prompt: string) => void;
  onToggleImportant: (important: boolean) => Promise<HistoryEntry>;
}

export function ReadOnlyChat({ entry, currentChatBusy, onResume, onToggleImportant }: Props) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  async function toggleImportant() {
    setMarking(true);
    try {
      await onToggleImportant(!entry.important);
    } finally {
      setMarking(false);
    }
  }

  useEffect(() => {
    setItems(null);
    setFallback(null);
    api.transcriptRead(entry.configDir, entry.cwd, entry.sessionId).then((raw) => {
      if (raw) setItems(parse(raw));
      else api.historyReadFile(entry.path).then(setFallback).catch(() => setFallback(""));
    });
  }, [entry.path]);

  const day = new Date(entry.start).toLocaleDateString(locale(), { day: "numeric", month: "short" });
  const rel = entry.path.replace(/^.*[\\/]history[\\/]/, "history/").replace(/\\/g, "/");
  const prompt = entry.summary
    ? t('Continue the work from the chat "{name}" ({path}): {summary}. ', { name: entry.name, path: rel, summary: entry.summary })
    : t('Continue the work from the chat "{name}" ({path}). ', { name: entry.name, path: rel });
  const lastTime = entry.end;

  return (
    <div className="view">
      <div className="chat-head">
        <h1>{entry.name}</h1>
        <span className="pill"><Icon name="lock" size={13} />{t("Read-only")}</span>
        <span className="meta">{day} · {fmtTime(entry.start)}–{fmtTime(entry.end)} · {durationLabel(entry.start, entry.end)}</span>
        <div className="right">
          {marking && !entry.important && <span className="why">{t("Claude is writing the detailed summary…")}</span>}
          <button className={`btn${entry.important ? " on-filter" : ""}`} disabled={marking} aria-pressed={entry.important}
            title={t("Important chats are summarized in detail and passed to every new chat in the context")} onClick={toggleImportant}>
            <Icon name="star" size={14} />{entry.important ? t("Important") : t("Mark as important")}
          </button>
          <button className="btn" onClick={() => api.revealFile(entry.path).catch(() => api.openFolder(entry.path.replace(/[\\/][^\\/]+$/, "")))}><Icon name="file" size={14} />{t("Open .md file")}</button>
        </div>
      </div>
      <div className="conv">
        <div className="col">
          {items === null && fallback === null && <p className="page-note">{t("Loading…")}</p>}
          {fallback !== null && (
            <>
              <p className="page-note">{t("The original transcript is no longer available, so the history file is shown instead.")}</p>
              <Rich text={fallback.replace(/^---[\s\S]*?---\n/, "")} />
            </>
          )}
          {items?.map((it, i) =>
            it.kind === "tool" ? <ToolRow key={i} tool={it} /> : (
              <div key={i} className={`msg ${it.user ? "user" : "claude"}`}>
                <div className="who">
                  {!it.user && <svg className="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" /></svg>}
                  {it.user ? t("You") : "Claude"} <span>{fmtTime(it.time)}</span>
                </div>
                <div className="body"><Rich text={it.text} /></div>
              </div>
            ),
          )}
          {items && <div className="end-mark"><span>{t("End of chat · {day}, {time}", { day, time: fmtTime(lastTime) })}</span></div>}
        </div>
      </div>
      <div className="resume-bar">
        <span className="txt"><Icon name="info" size={14} />{t("To continue this work, use the context's current chat")}</span>
        <span className="prompt-preview" title={prompt}>{prompt}</span>
        <button className="btn pri" disabled={currentChatBusy} title={currentChatBusy ? t("Available when Claude has finished") : undefined} onClick={() => onResume(prompt)}>
          {t("Continue in the current chat")}<Icon name="arrowUpRight" size={14} />
        </button>
      </div>
    </div>
  );
}
