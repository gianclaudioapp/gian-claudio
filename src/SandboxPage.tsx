// A context's sandboxes, listed like its past chats: name, the chat it was
// detached from, state, files changed since then. A click opens it.
import { useEffect, useState } from "react";
import { FileChange, api } from "./api";
import { Icon } from "./icons";
import { Menu } from "./ui";
import { t } from "./i18n";
import { Account, Context, accVars, timeAgo } from "./model";

interface Props {
  ctx: Context;
  account: Account;
  sandboxes: Context[];
  stateOf: (id: string) => "working" | "waiting" | "idle";
  now: number;
  onOpen: (sb: Context) => void;
  onDiscard: (sb: Context) => void;
}

function fmtCreated(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? t("today {time}", { time })
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function SandboxPage({ ctx, account, sandboxes, stateOf, now, onOpen, onDiscard }: Props) {
  const [changes, setChanges] = useState<Record<string, FileChange[]>>({});

  // Files changed, refreshed while the page is open (Claude may be working in them).
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all(sandboxes.map(async (sb) => [sb.id, await api.sandboxChanges(sb.sandbox!.root, sb.sandbox!.base)] as const))
        .then((list) => alive && setChanges(Object.fromEntries(list)));
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [sandboxes.map((s) => s.id).join(",")]);

  const sorted = [...sandboxes].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Sandboxes")}</h1>
        <span className="sub">{ctx.name}</span>
        <span className="tag acc-c" style={accVars(account.color)}>{account.name}</span>
      </div>
      <p className="page-hint">{t("Working copies detached from this context's chats. Their changes stay here until you apply them to the context's folder or throw them away.")}</p>
      <div className="page-body flush">
        {sorted.length === 0 && (
          <p className="page-note">{t("No sandboxes yet. Detach one from a chat with the branch icon in its header.")}</p>
        )}
        {sorted.map((sb) => {
          const st = stateOf(sb.id);
          const files = changes[sb.id];
          const count = (s: FileChange["status"]) => files?.filter((f) => f.status === s).length ?? 0;
          return (
            <div key={sb.id} className="hrow srow" role="button" tabIndex={0} onClick={() => onOpen(sb)} onKeyDown={(e) => e.key === "Enter" && onOpen(sb)}>
              <span className="sb-ic"><Icon name="box" size={16} /></span>
              <span className="hmain">
                <span className="hr1"><b>{sb.chat?.name ?? sb.name}</b>{sb.sandbox!.branch && <span className="sb-branch"><Icon name="detach" size={12} />{sb.sandbox!.branch}</span>}</span>
                <span className="hsum">{t("from «{chat}» · {when}", { chat: sb.sandbox!.origin, when: fmtCreated(sb.sandbox!.createdAt) })}</span>
              </span>
              <span className={`sb-state ${st}`}>
                {st === "working" ? <><span className="dot" />{t("Claude is working")}</>
                  : st === "waiting" ? <><span className="dot waiting" />{t("Waiting for you")}</>
                  : <><span className="idle-dot" />{t("Stopped")}</>}
              </span>
              <span className="sb-files" title={files ? t("New, modified and deleted files since it was detached") : undefined}>
                {files === undefined ? "" : files.length === 0 ? <span className="none">{t("no changes")}</span> : (
                  <>
                    {count("A") > 0 && <span className="a">+{count("A")}</span>}
                    {count("M") > 0 && <span className="m">~{count("M")}</span>}
                    {count("D") > 0 && <span className="r">−{count("D")}</span>}
                  </>
                )}
              </span>
              <time>{timeAgo(sb.lastUsed, now)}</time>
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <Menu items={[
                  { label: t("Open"), icon: "box", onClick: () => onOpen(sb) },
                  { label: t("Open folder"), icon: "folder", onClick: () => api.openFolder(sb.sandbox!.root) },
                  { label: t("Throw away the sandbox…"), icon: "trash", danger: true, onClick: () => onDiscard(sb) },
                ]} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
