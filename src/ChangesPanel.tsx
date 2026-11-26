// "What was done here": a sandbox's changes since it was detached (or last
// applied), Claude's summary of them, the diff of the picked file, and the way
// back to the context's folder.
import { useEffect, useMemo, useState } from "react";
import { FileChange, api } from "./api";
import { Icon } from "./icons";
import { Menu } from "./ui";
import { t } from "./i18n";

interface Props {
  files: FileChange[] | undefined;
  root: string;
  base: string | null;
  summary: { text: string; at: number } | null;
  /** Claude is writing the summary. */
  summarizing: boolean;
  /** Summaries are turned off in Settings. */
  summaryOff: boolean;
  onSummarize: () => void;
  /** Resolves with the files left to fix by hand. */
  onApply: () => Promise<string[]>;
  onOpenFolder: () => void;
  onDiscard: () => void;
  onClose: () => void;
  /** Git sandbox: open the "create a branch" dialog. */
  onBranch?: () => void;
  /** The branch made earlier from this sandbox. */
  branch?: string;
}

const GROUPS: { status: FileChange["status"]; label: () => string }[] = [
  { status: "A", label: () => t("New") },
  { status: "M", label: () => t("Modified") },
  { status: "D", label: () => t("Deleted") },
];

function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

export function ChangesPanel({ files, root, base, summary, summarizing, summaryOff, onSummarize, onApply, onOpenFolder, onDiscard, onClose, onBranch, branch }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const shown = picked && files?.some((f) => f.path === picked) ? picked : files?.[0]?.path ?? null;
  const filesKey = files?.map((f) => `${f.path}:${f.added}:${f.removed}`).join("|") ?? "";

  // The diff of the shown file, refreshed when the files change.
  useEffect(() => {
    if (!shown || !base) return setDiff(null);
    let alive = true;
    api.sandboxDiff(root, base, shown).then((d) => alive && setDiff(d));
    return () => { alive = false; };
  }, [shown, base, root, filesKey]);

  const diffLines = useMemo(
    () => (diff ?? "").split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|\\ No newline)/.test(l)).slice(0, 800),
    [diff],
  );

  async function apply() {
    setApplying(true);
    setResult(null);
    try {
      const conflicts = await onApply();
      setResult(conflicts.length === 0
        ? { ok: true, text: t("Applied to the context's folder.") }
        : { ok: false, text: t("Applied. To fix by hand (both sides changed them): {files}", { files: conflicts.join(", ") }) });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    }
    setApplying(false);
  }

  const count = files?.length ?? 0;
  return (
    <aside className="chg" aria-label={t("What was done here")}>
      <div className="chg-h">
        <h3>{t("What was done here")}</h3>
        {files && <span className="pill">{count === 1 ? t("1 file") : t("{n} files", { n: count })}</span>}
        <span className="chg-sp" />
        <Menu items={[
          { label: t("Open folder"), icon: "folder", onClick: onOpenFolder },
          { label: t("Throw away the sandbox…"), icon: "trash", danger: true, onClick: onDiscard },
        ]} />
        <button className="icon-btn" title={t("Close")} onClick={onClose}><Icon name="x" /></button>
      </div>

      {files === undefined && <p className="chg-note">{t("Loading…")}</p>}
      {files && count === 0 && <p className="chg-note">{t("No changes yet: what Claude changes in the sandbox shows up here.")}</p>}

      {count > 0 && (
        <div className="chg-sum">
          <div className="chg-meta">
            <Icon name="sparkle" size={13} />
            {summarizing ? t("Claude is writing the summary…")
              : summary ? t("Claude's summary · {time}", { time: new Date(summary.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) })
              : summaryOff ? t("Summaries are off in Settings") : t("No summary yet")}
            {!summaryOff && (
              <button className="chg-link" disabled={summarizing} onClick={onSummarize}>
                <Icon name="refresh" size={13} />{summary ? t("Update") : t("Write it")}
              </button>
            )}
          </div>
          {summary && <p>{summary.text}</p>}
        </div>
      )}

      {count > 0 && (
        <div className="chg-files">
          {GROUPS.map(({ status, label }) => {
            const list = files!.filter((f) => f.status === status);
            if (!list.length) return null;
            return (
              <div key={status}>
                <div className="chg-grp">{label()} · {list.length}</div>
                {list.map((f) => {
                  const [dir, name] = splitPath(f.path);
                  return (
                    <button key={f.path} className={`chg-file${f.path === shown ? " on" : ""}`} onClick={() => setPicked(f.path)} title={f.path}>
                      <span className={`chg-k ${status}`}>{status}</span>
                      <span className="chg-path"><i>{dir}</i>{name}</span>
                      <span className="chg-n">
                        {f.added ? <span className="a">+{f.added}</span> : null}
                        {f.removed ? <span className="r">−{f.removed}</span> : null}
                        {f.added === null && <span>{t("binary")}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {count > 0 && (
        <div className="chg-diff">
          {shown && diff === "" && <p className="chg-note">{t("No preview for this file.")}</p>}
          {diffLines.map((l, i) => (
            <div key={i} className={l.startsWith("@@") ? "hh" : l.startsWith("+") ? "ad" : l.startsWith("-") ? "rm" : ""}>{l || " "}</div>
          ))}
        </div>
      )}

      {count > 0 && (
        <div className="chg-opts">
          <div className="chg-opt">
            <span className="chg-oi"><Icon name="download" /></span>
            <span className="chg-ot">
              <b>{t("Apply to the context's folder")}</b>
              <span>{t("Brings the changes into the context's folder as modified files, without a commit.")}</span>
            </span>
            <button className="btn pri" disabled={applying || !base} onClick={apply}>{applying ? t("Applying…") : t("Apply")}</button>
          </div>
          {onBranch && (
            <div className="chg-opt">
              <span className="chg-oi"><Icon name="detach" /></span>
              <span className="chg-ot">
                <b>{branch ? t("New commit on {branch}", { branch }) : t("Create a branch with git")}</b>
                <span>{branch ? t("Adds a commit with the changes made since the last one.") : t("Creates a branch with a commit of these changes.")}</span>
              </span>
              <button className="btn" onClick={onBranch}>{branch ? t("Commit…") : t("Create…")}</button>
            </div>
          )}
          {result && <p className={result.ok ? "chg-ok" : "chg-warn"}>{result.text}</p>}
        </div>
      )}
    </aside>
  );
}
