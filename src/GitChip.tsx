import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";
import { api, type RepoStatus } from "./api";
import { timeAgo } from "./model";

interface Props {
  status: RepoStatus;
  /** The repo folder: file paths are relative to it. */
  dir: string;
  /** Asked when the popup opens, so it shows the current state. */
  onRefresh: () => void;
}

/** A popup under a chip: closes on a click outside or Escape. */
function usePopup() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/**
 * The working folder is a repo git refuses to read (owned by another Windows
 * user). Shown when the chat opens, so git can be unblocked here once, for the
 * chip and for sandboxes alike.
 */
export function GitUntrustedChip({ path, onTrusted }: { path: string; onTrusted: () => void }) {
  const { open, setOpen, ref } = usePopup();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function trust() {
    setBusy(true);
    setError(null);
    try {
      await api.gitTrust(path);
      setOpen(false);
      onTrusted();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="git" ref={ref}>
      <button className={`chip git-chip git-warn${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}
        title={t("Git doesn't trust this folder")}>
        <Icon name="alert" size={13} /><span>{t("Git: folder not trusted")}</span>
      </button>
      {open && (
        <div className="git-pop" role="dialog" aria-label={t("Git doesn't trust this folder")}>
          <div className="git-trust">
            <p>{t("Git refuses to read this repository because it belongs to another Windows user (\"dubious ownership\"). Until it is marked as safe, the branch and the changes can't be shown, and sandboxes can't use git.")}</p>
            <code>{path}</code>
            {error && <p className="git-err">{error}</p>}
            <div className="git-trust-a">
              <button className="btn" disabled={busy} onClick={trust}>{busy ? t("Working…") : t("Mark this folder as safe")}</button>
              <span className="hint">{t("Adds it to git's safe.directory list, as git itself suggests.")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Branch and unstaged lines of the working folder; a click lists the files. Read only. */
export function GitChip({ status, dir, onRefresh }: Props) {
  const { open, setOpen, ref } = usePopup();

  const added = status.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = status.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const name = status.branch ?? status.head ?? t("no commits");
  const clean = status.files.length === 0;
  const tip = clean
    ? t("{branch} · no unstaged changes", { branch: name })
    : status.files.length === 1 ? t("{branch} · 1 file not staged", { branch: name }) : t("{branch} · {n} files not staged", { branch: name, n: status.files.length });

  return (
    <div className="git" ref={ref}>
      <button className={`chip git-chip${open ? " on" : ""}`} title={tip} aria-expanded={open}
        onClick={() => { if (!open) onRefresh(); setOpen(!open); }}>
        <Icon name="branch" size={13} />
        <span className="git-name">{name}</span>
        {!status.branch && status.head && <span className="git-faint">{t("detached")}</span>}
        {clean ? <span className="git-faint git-ok"><Icon name="check" size={13} /></span> : (
          <><span className="git-sep" /><span className="git-plus">+{added}</span><span className="git-minus">−{removed}</span></>
        )}
      </button>
      {open && (
        <div className="git-pop" role="dialog" aria-label={t("Git status")}>
          <div className="git-h">
            <Icon name="branch" size={14} />
            <b>{name}</b>
            {!status.branch && status.head && <span className="git-faint">{t("detached HEAD")}</span>}
            {status.upstream && (
              <span className="git-sync">
                <span title={t("Commits to push")}><Icon name="arrowUp" size={12} />{status.ahead}</span>
                <span title={t("Commits to pull")}><Icon name="arrowDown" size={12} />{status.behind}</span>
              </span>
            )}
          </div>
          {clean ? (
            <div className="git-empty"><Icon name="check" size={14} />{t("No unstaged changes.")}</div>
          ) : (
            <>
              <div className="git-sec"><b>{t("Not staged")}</b>· {status.files.length === 1 ? t("1 file") : t("{n} files", { n: status.files.length })}</div>
              <div className="git-rows">
                {status.files.map((f) => {
                  const slash = f.path.lastIndexOf("/");
                  const body = (
                    <>
                      <span className={`chg-k ${f.status}`}>{f.status}</span>
                      <span className="git-fn"><i>{f.path.slice(0, slash + 1)}</i>{f.path.slice(slash + 1)}</span>
                      <span className="git-ln">
                        {!!f.added && <span className="git-plus">+{f.added}</span>}
                        {!!f.removed && <span className="git-minus">−{f.removed}</span>}
                      </span>
                      {f.status !== "D" && <span className="git-open"><Icon name="arrowUpRight" size={14} /></span>}
                    </>
                  );
                  return f.status === "D"
                    ? <div key={f.path} className="git-row" title={t("Deleted file")}>{body}</div>
                    : <button key={f.path} className="git-row" title={t("Open {file}", { file: f.path })}
                        onClick={() => api.openPath(`${dir.replace(/[\\/]+$/, "")}\\${f.path.replace(/\//g, "\\")}`).catch(() => {})}>{body}</button>;
                })}
              </div>
            </>
          )}
          <div className="git-f">
            <span className="git-last">{status.lastSubject ? t("Last commit: «{s}» · {when}", { s: status.lastSubject, when: timeAgo(status.lastTime ? status.lastTime * 1000 : null) }) : t("No commits yet")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
