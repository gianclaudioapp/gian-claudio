import { useEffect, useMemo, useState } from "react";
import { AccountLimits, ContextLine, LimitWindow, api } from "./api";
import { Icon } from "./icons";
import { Account, Context, accVars, workingDir } from "./model";
import { SessionUsage, Tokens, addTokens, costByModel, emptyTokens, fmtTokens, fmtUsd, totalTokens } from "./pricing";
import { locale, t, tn } from "./i18n";

/** Context fill at or above this is "critical": time to start a new chat. */
export const CONTEXT_CRITICAL = 80;

function level(pct: number): "ok" | "warn" | "crit" {
  return pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok";
}

function resetLabel(w: LimitWindow | null | undefined): string {
  if (!w?.resetsAt) return "";
  const d = new Date(w.resetsAt * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? t("resets at {time}", { time })
    : t("resets {day} {time}", { day: d.toLocaleDateString(locale(), { weekday: "short" }), time });
}

function pctOf(v: number | null | undefined): number | null {
  return typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

/**
 * Usage donuts for the chat header: the account's 5-hour plan limit (when
 * Claude Code reports it) and how full the chat's context is. Hover either for
 * the details; a "!" appears when the context is close to full.
 */
export interface ChatRef { configDir: string | null; cwd: string; sessionId: string }

export function UsageDonut({ limits, line, chat, onOpenUsage }: { limits: AccountLimits | null; line: ContextLine | null; chat: ChatRef | null; onOpenUsage: () => void }) {
  const base = useContextBase(chat, line?.ts ?? 0);
  const five = pctOf(limits?.fiveHour?.pct);
  const week = pctOf(limits?.sevenDay?.pct);
  const ctx = pctOf(line?.contextPct);
  const critical = ctx !== null && ctx >= CONTEXT_CRITICAL;
  const updated = Math.max(limits?.ts ?? 0, line?.ts ?? 0);

  return (
    <div className="donut-wrap" tabIndex={0} aria-label={[
      five !== null ? `${t("5-hour limit")}: ${Math.round(five)}%` : "",
      ctx !== null ? `${t("Context")}: ${Math.round(ctx)}%` : t("Usage not available yet"),
    ].filter(Boolean).join(", ")}>
      {five !== null && <Ring label={t("Session")} value={five} />}
      {five !== null && <span className="donut-sep" aria-hidden="true" />}
      <Ring label={t("Chat")} value={ctx} />
      {critical && (
        <span className="ctx-alert" title={t("Context almost full ({pct}%): consider starting a new chat", { pct: Math.round(ctx!) })}>
          <Icon name="alert" size={16} />
        </span>
      )}
      <div className="donut-pop">
        {five !== null && <PopRow label={t("Session (5 hours)")} pct={five} note={resetLabel(limits?.fiveHour)} />}
        {week !== null && <PopRow label={t("Week")} pct={week} note={resetLabel(limits?.sevenDay)} />}
        {ctx !== null ? (
          <ContextRows pct={ctx} size={line?.contextSize ?? null} base={base} critical={critical} />
        ) : (
          <p className="pop-note">{t("Context fill shows up after Claude's first reply.")}</p>
        )}
        {five === null && <p className="pop-note">{t("Claude Code doesn't report usage limits for this account.")}</p>}
        <div className="pop-foot">
          <span className="pop-note">{updated > 0 ? t("Updated at {time}", { time: new Date(updated).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) }) : ""}</span>
          <button className="btn" onClick={onOpenUsage}><Icon name="chart" size={14} />{t("Usage")}</button>
        </div>
      </div>
    </div>
  );
}

/** The chat's context base (see `api.contextBase`), looked up until Claude has answered once. */
function useContextBase(chat: ChatRef | null, lineTs: number): number | null {
  const [base, setBase] = useState<{ sessionId: string; tokens: number } | null>(null);
  const known = !!chat && base?.sessionId === chat.sessionId;
  useEffect(() => {
    if (!chat || known) return;
    let alive = true;
    api.contextBase(chat).then((tokens) => alive && tokens && setBase({ sessionId: chat.sessionId, tokens }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.sessionId, chat?.configDir, chat?.cwd, known, lineTs]);
  return known ? base!.tokens : null;
}

/**
 * Chat context fill, split into the base every request carries (system prompt,
 * tools, memory: measured at the first request), the conversation and what's free.
 */
function ContextRows({ pct, size, base, critical }: { pct: number; size: number | null; base: number | null; critical: boolean }) {
  const note = size
    ? t("of {size} tokens", { size: fmtTokens(size) }) + (critical ? ` · ${t("almost full")}` : "")
    : critical ? t("almost full") : "";
  if (!size || base === null) return <PopRow label={t("Chat context")} pct={pct} note={note} />;
  const basePct = Math.min(pct, (base / size) * 100);
  const convPct = pct - basePct;
  const fmt = (v: number) => `${v < 1 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
  return (
    <>
      <div className="pop-row">
        <span className="pop-label">{t("Chat context")}</span>
        <span className="pop-meter stack">
          <span className="base" style={{ width: `${basePct}%` }} />
          <span className={level(pct)} style={{ width: `${convPct}%` }} />
        </span>
        <b>{Math.round(pct)}%</b>
        {note && <span className="pop-sub">{note}</span>}
      </div>
      <ul className="pop-split">
        <li><i className="base" />{t("Base")}<span className="pop-sub-inline">{t("instructions, tools, memory")}</span><b>{fmt(basePct)}</b></li>
        <li><i className={level(pct)} />{t("Conversation")}<b>{fmt(convPct)}</b></li>
        <li><i className="free" />{t("Free")}<b>{fmt(100 - pct)}</b></li>
      </ul>
    </>
  );
}

function Ring({ label, value }: { label: string; value: number | null }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <>
      <svg width="24" height="24" viewBox="0 0 24 24" className={`donut ${value === null ? "none" : level(value)}`} aria-hidden="true">
        <circle cx="12" cy="12" r={r} className="track" />
        {value !== null && (
          <circle cx="12" cy="12" r={r} className="arc" strokeDasharray={`${(value / 100) * c} ${c}`} transform="rotate(-90 12 12)" />
        )}
      </svg>
      <span className="donut-lbl">{label}</span>
      <span className="donut-val">{value === null ? "—" : `${Math.round(value)}%`}</span>
    </>
  );
}

function PopRow({ label, pct, note }: { label: string; pct: number; note: string }) {
  return (
    <div className="pop-row">
      <span className="pop-label">{label}</span>
      <span className="pop-meter"><span className={level(pct)} style={{ width: `${pct}%` }} /></span>
      <b>{Math.round(pct)}%</b>
      {note && <span className="pop-sub">{note}</span>}
    </div>
  );
}

// ---- Usage page -----------------------------------------------------------------

interface Props {
  account: Account;
  contexts: Context[];
  limits: AccountLimits | null;
}

interface CtxRow {
  ctx: Context;
  chats: number;
  month: Record<string, Tokens>;
}

function sumModels(list: Record<string, Tokens>[]): Record<string, Tokens> {
  const out: Record<string, Tokens> = {};
  for (const byModel of list) for (const [m, tok] of Object.entries(byModel)) out[m] = addTokens(out[m] ?? emptyTokens(), tok);
  return out;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function UsagePage({ account, contexts, limits }: Props) {
  const [rows, setRows] = useState<CtxRow[] | null>(null);
  const [days, setDays] = useState<{ key: string; total: number }[]>([]);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const from30 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      // Every chat of every context on this account: the current one and the past ones.
      const refs: { ctxIndex: number; ref: { configDir: string | null; cwd: string; sessionId: string } }[] = [];
      const chatCounts: number[] = [];
      for (const [i, c] of contexts.entries()) {
        const past = await api.historyList(c.dirName);
        chatCounts.push(past.length + (c.chat ? 1 : 0));
        if (c.chat) refs.push({ ctxIndex: i, ref: { configDir: account.configDir, cwd: workingDir(c), sessionId: c.chat.sessionId } });
        for (const e of past) {
          if (e.sessionId) refs.push({ ctxIndex: i, ref: { configDir: e.configDir ?? account.configDir, cwd: e.cwd, sessionId: e.sessionId } });
        }
      }
      const items = refs.map((r) => r.ref);
      const earliest = from30 < monthStart ? from30 : monthStart;
      const usage: SessionUsage[] = await api.usageSessions(items, earliest.toISOString());
      if (!alive) return;

      // This month's tokens per model, per context (the call above covers 30 days for the chart).
      const monthUsage: SessionUsage[] = await api.usageSessions(items, monthStart.toISOString());
      if (!alive) return;
      setRows(
        contexts.map((ctx, i) => ({
          ctx,
          chats: chatCounts[i],
          month: sumModels(monthUsage.filter((_, k) => refs[k].ctxIndex === i).map((u) => u.byModel)),
        })),
      );

      const perDay: Record<string, number> = {};
      for (const u of usage) for (const [d, n] of Object.entries(u.byDay)) perDay[d] = (perDay[d] ?? 0) + n;
      const list = Array.from({ length: 30 }, (_, k) => {
        const d = new Date(from30.getFullYear(), from30.getMonth(), from30.getDate() + k);
        const key = dayKey(d);
        return { key, total: perDay[key] ?? 0 };
      });
      setDays(list);
    })();
    return () => {
      alive = false;
    };
  }, [account.id, account.configDir, contexts]);

  const month = useMemo(() => sumModels((rows ?? []).map((r) => r.month)), [rows]);
  const monthTotal = Object.values(month).reduce((a, x) => addTokens(a, x), emptyTokens());
  const cost = costByModel(month);
  const maxDay = Math.max(1, ...days.map((d) => d.total));
  const five = pctOf(limits?.fiveHour?.pct);
  const week = pctOf(limits?.sevenDay?.pct);
  const monthName = new Date().toLocaleDateString(locale(), { month: "long", year: "numeric" });

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Usage")}</h1>
        <span className="tag acc-c" style={accVars(account.color)}>{account.name}</span>
      </div>
      <div className="page-body">
        <div className="usage">
          <section className="u-sec">
            <h2>{t("Plan limits")}</h2>
            {five !== null || week !== null ? (
              <div className="u-limits">
                {five !== null && <LimitCard label={t("Session (5 hours)")} pct={five} note={resetLabel(limits?.fiveHour)} />}
                {week !== null && <LimitCard label={t("Week")} pct={week} note={resetLabel(limits?.sevenDay)} />}
                {limits?.ts ? <p className="hint">{t("Updated at {time}, as of Claude's last reply.", { time: new Date(limits.ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) })}</p> : null}
              </div>
            ) : (
              <p className="hint">{t("No data. Claude Code reports plan limits for Pro, Max and Ultra subscriptions after a chat's first reply. Team plans and API keys usually don't have them.")}</p>
            )}
          </section>

          <section className="u-sec">
            <h2>{t("This month")} <span className="sub">· {monthName}</span></h2>
            {rows === null ? <p className="hint">{t("Calculating…")}</p> : (
              <>
                <div className="u-hero">
                  <span className="u-big">{fmtTokens(totalTokens(monthTotal))}</span>
                  <span className="u-big-label">{t("tokens processed")}</span>
                </div>
                <div className="u-break">
                  <span><b>{fmtTokens(monthTotal.input)}</b> {t("input")}</span>
                  <span><b>{fmtTokens(monthTotal.output)}</b> {t("output")}</span>
                  <span><b>{fmtTokens(monthTotal.cacheWrite5m + monthTotal.cacheWrite1h)}</b> {t("written to cache")}</span>
                  <span><b>{fmtTokens(monthTotal.cacheRead)}</b> {t("read from cache")}</span>
                  <span><b>{monthTotal.requests.toLocaleString(locale())}</b> {monthTotal.requests === 1 ? t("request") : t("requests")}</span>
                </div>
                <p className="u-cost">
                  {account.kind === "apikey"
                    ? tn("Estimated spend this month: {cost}", { cost: <b>{fmtUsd(cost.usd)}</b> })
                    : tn("Without a subscription, this month would have cost {cost} at API list prices", { cost: <b>{fmtUsd(cost.usd)}</b> })}
                  {cost.unpriced.length > 0 && <span className="hint"> · {t("no price: {models}", { models: cost.unpriced.join(", ") })}</span>}
                </p>
              </>
            )}
          </section>

          <section className="u-sec">
            <h2>{t("Last 30 days")}</h2>
            <div className="u-chart" onMouseLeave={() => setHover(null)}>
              <div className="u-grid"><span>{fmtTokens(maxDay)}</span><span>{fmtTokens(maxDay / 2)}</span><span>0</span></div>
              <div className="u-bars" role="list" aria-label={t("Tokens processed per day")}>
                {days.map((d, i) => (
                  <div key={d.key} className="u-col" role="listitem" aria-label={t("{date}: {tokens} tokens", { date: d.key, tokens: fmtTokens(d.total) })}
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
                    <div className={`u-bar${hover === i ? " on" : ""}`} style={{ height: d.total ? `max(2px, ${(d.total / maxDay) * 100}%)` : 0 }} />
                    {hover === i && (
                      <div className={`u-tip${i > 22 ? " left" : ""}`}>
                        {tn("{tokens} tokens", { tokens: <b>{fmtTokens(d.total)}</b> })}
                        <span>{new Date(d.key + "T12:00:00").toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" })}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="u-x">
                {days.map((d, i) => (
                  <span key={d.key}>{i % 7 === 0 || i === days.length - 1 ? new Date(d.key + "T12:00:00").toLocaleDateString(locale(), { day: "numeric", month: "short" }) : ""}</span>
                ))}
              </div>
            </div>
          </section>

          <section className="u-sec">
            <h2>{t("By context")} <span className="sub">· {t("this month")}</span></h2>
            {rows && rows.length === 0 && <p className="hint">{t("No context uses this account.")}</p>}
            {rows && rows.length > 0 && (
              <table className="u-table">
                <thead><tr><th>{t("Context")}</th><th className="num">{t("Chats")}</th><th className="num">{t("Tokens")}</th><th className="num">{account.kind === "apikey" ? t("Spend") : t("List price")}</th></tr></thead>
                <tbody>
                  {rows
                    .map((r) => ({ ...r, tok: Object.values(r.month).reduce((a, x) => addTokens(a, x), emptyTokens()) }))
                    .sort((a, b) => totalTokens(b.tok) - totalTokens(a.tok))
                    .map(({ tok, ...r }) => {
                    return (
                      <tr key={r.ctx.id}>
                        <td>{r.ctx.name}</td>
                        <td className="num">{r.chats}</td>
                        <td className="num">{fmtTokens(totalTokens(tok))}</td>
                        <td className="num">{fmtUsd(costByModel(r.month).usd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
          <p className="hint">{t("Only chats started from Gian Claudio. Amounts are estimated at API list prices, in US dollars.")}</p>
        </div>
      </div>
    </div>
  );
}

function LimitCard({ label, pct, note }: { label: string; pct: number; note: string }) {
  const lv = level(pct);
  return (
    <div className="u-limit">
      <div className="u-limit-top">
        <span>{label}</span>
        <b>{Math.round(pct)}%</b>
      </div>
      <div className="u-meter"><span className={lv} style={{ width: `${pct}%` }} /></div>
      <span className="hint">{lv === "crit" && <><Icon name="alert" size={13} /> {t("Almost used up")} · </>}{note}</span>
    </div>
  );
}
