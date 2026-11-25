import { ReactNode, useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";
import { Account, Context, HistoryEntry, accVars, fmtDay, fmtTime } from "./model";

type Hit = { contextDir: string; entry: HistoryEntry; snippet: string };

interface Props {
  initialQuery: string;
  contexts: Context[];
  accountOf: (id: string) => Account;
  onOpen: (contextId: string, e: HistoryEntry) => void;
}

/** Full-text search in the past chats of every context. */
export function SearchPage({ initialQuery, contexts, accountOf, onOpen }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => setQ(initialQuery), [initialQuery]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => api.historySearch(term).then((r) => alive && setHits(r)), 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const byDir = new Map(contexts.map((c) => [c.dirName, c]));
  const term = q.trim().toLowerCase();

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Search across past chats")}</h1>
        <span className="sub">{hits ? t(hits.length === 1 ? "{count} result" : "{count} results", { count: `${hits.length}${hits.length === 200 ? "+" : ""}` }) : ""}</span>
        <div className="right">
          <label className="search wide">
            <Icon name="search" />
            <input autoFocus placeholder={t("Words, files, commands…")} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="page-body flush">
        {q.trim().length < 2 && <p className="page-note">{t("Type at least two characters to search names, summaries and conversations in every context.")}</p>}
        {hits?.length === 0 && <p className="page-note">{t("No past chat contains “{query}”.", { query: q.trim() })}</p>}
        {hits?.map((h) => {
          const ctx = byDir.get(h.contextDir);
          const acc = ctx ? accountOf(ctx.accountId) : null;
          return (
            <div key={h.entry.path} className={`hrow${ctx ? "" : " orphan"}`} role="button" tabIndex={0}
              onClick={() => ctx && onOpen(ctx.id, h.entry)} onKeyDown={(e) => e.key === "Enter" && ctx && onOpen(ctx.id, h.entry)}>
              <span className="hmain">
                <span className="hr1">
                  <b>{h.entry.name}</b>
                  <span className="hr-time">{fmtDay(h.entry.start)} · {fmtTime(h.entry.start)}</span>
                  {ctx && acc && <span className="tag acc-c" style={accVars(acc.color)}>{ctx.name}</span>}
                  {!ctx && <span className="tag">{t("deleted context")}</span>}
                  {h.entry.important && <span className="imp" title={t("Important")}><Icon name="star" size={13} /></span>}
                </span>
                <span className="snippet"><Highlight text={h.snippet} term={term} /></span>
              </span>
              <Icon name="chevronRight" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let k = 0;
  while (true) {
    const j = lower.indexOf(term, i);
    if (j < 0) break;
    parts.push(text.slice(i, j), <mark key={k++}>{text.slice(j, j + term.length)}</mark>);
    i = j + term.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}
