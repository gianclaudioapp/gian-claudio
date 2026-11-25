import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { t, tn } from "./i18n";
import { Account, Context, HistoryEntry, fmtDay, fmtTime, accVars } from "./model";

interface Props {
  ctx: Context;
  account: Account;
  historyRoot: string;
  /** Changes when a chat has just been archived, to reload the list. */
  version: number;
  onOpen: (e: HistoryEntry) => void;
  onToggleImportant: (e: HistoryEntry, important: boolean) => Promise<HistoryEntry>;
}

export function HistoryPage({ ctx, account, historyRoot, version, onOpen, onToggleImportant }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [q, setQ] = useState("");
  const [onlyImportant, setOnlyImportant] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.historyList(ctx.dirName).then(setEntries);
  }, [ctx.dirName, version]);

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (entries ?? []).filter(
      (e) => (!onlyImportant || e.important) && (!term || e.name.toLowerCase().includes(term) || e.summary.toLowerCase().includes(term)),
    );
    const map = new Map<string, HistoryEntry[]>();
    for (const e of list) {
      const day = fmtDay(e.start); // "" when missing: labelled at render time
      map.set(day, [...(map.get(day) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries, q, onlyImportant]);

  async function toggle(e: HistoryEntry) {
    setPending((p) => ({ ...p, [e.path]: true }));
    try {
      const updated = await onToggleImportant(e, !e.important);
      setEntries((list) => list?.map((x) => (x.path === e.path ? updated : x)) ?? null);
    } finally {
      setPending((p) => ({ ...p, [e.path]: false }));
    }
  }

  const count = entries?.length ?? 0;
  const importantCount = entries?.filter((e) => e.important).length ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Past chats")}</h1>
        <span className="sub">{ctx.name} · {t(count === 1 ? "{count} chat" : "{count} chats", { count })}</span>
        <span className="tag acc-c" style={accVars(account.color)}>{account.name}</span>
        <div className="right">
          <button className={`btn${onlyImportant ? " on-filter" : ""}`} onClick={() => setOnlyImportant((v) => !v)} aria-pressed={onlyImportant}>
            <Icon name="star" size={14} />{t("Important{count}", { count: importantCount ? ` (${importantCount})` : "" })}
          </button>
          <label className="search small">
            <Icon name="search" />
            <input placeholder={t("Search past chats")} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button className="btn" onClick={() => api.openFolder(historyRoot)}><Icon name="folder" size={15} />{t("Open folder")}</button>
        </div>
      </div>
      <p className="page-hint">
        {tn("Each new chat gets the summary of the last chat and of those marked as {important}, for which Claude writes a detailed summary.", { important: <b>{t("important")}</b> })}
      </p>
      <div className="page-body flush">
        {entries === null && <p className="page-note">{t("Loading…")}</p>}
        {entries?.length === 0 && (
          <p className="page-note">{t("No past chats yet. When you start a new chat, the previous one is saved here with a summary.")}</p>
        )}
        {entries && entries.length > 0 && groups.length === 0 && <p className="page-note">{t("No chats match.")}</p>}
        {groups.map(([day, list]) => (
          <section key={day}>
            <h3 className="day">{day || t("No date")}</h3>
            {list.map((e) => (
              <div key={e.path} className="hrow" role="button" tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(ev) => ev.key === "Enter" && onOpen(e)}>
                <button className={`star${e.important ? " on" : ""}`} disabled={pending[e.path]}
                  title={e.important ? t("Remove from important") : t("Mark as important")} aria-pressed={e.important}
                  onClick={(ev) => { ev.stopPropagation(); toggle(e); }}>
                  <Icon name="star" size={16} />
                </button>
                <span className="hmain">
                  <span className="hr1"><b>{e.name}</b><span className="hr-time">{fmtTime(e.start)} – {fmtTime(e.end)}</span></span>
                  <span className="hsum">
                    {pending[e.path] && !e.important ? t("Claude is writing the detailed summary…") : e.summary || t("Summary not available")}
                  </span>
                </span>
                <span className="hfile">{e.file}</span>
                <Icon name="chevronRight" />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
