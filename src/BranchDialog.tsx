// "Create a branch with git" from a sandbox: branch type and name, the commit
// message (proposed by Claude), git's configuration for this commit only, and
// whether to push and open a pull request.
import { useEffect, useState } from "react";
import { Dialog } from "./ui";
import { Icon } from "./icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BranchDone, GitInfo, api } from "./api";
import { t, tn } from "./i18n";

const TYPES = ["feature/", "fix/", "hotfix/", "refactor/", "chore/", "docs/", ""];

export interface BranchInput {
  branch: string;
  message: string;
  authorName: string;
  authorEmail: string;
  sign: boolean;
  push: string | null;
  prBase: string | null;
}

interface Props {
  repo: string;
  start: string;
  /** The branch made earlier from this sandbox: the new commit goes on top of it. */
  existing?: string;
  defaultName: string;
  /** Asks Claude for a commit message (null when summaries are off or it fails). */
  proposeMessage: () => Promise<string | null>;
  onCreate: (input: BranchInput) => Promise<BranchDone>;
  onClose: () => void;
}

export function BranchDialog({ repo, start, existing, defaultName, proposeMessage, onCreate, onClose }: Props) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [type, setType] = useState("feature/");
  const [name, setName] = useState(defaultName);
  const [message, setMessage] = useState("");
  const [writing, setWriting] = useState(true);
  const [author, setAuthor] = useState({ name: "", email: "" });
  const [editAuthor, setEditAuthor] = useState(false);
  const [remote, setRemote] = useState<string | null>(null);
  const [sign, setSign] = useState(false);
  const [push, setPush] = useState(true);
  const [pr, setPr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BranchDone | null>(null);

  useEffect(() => {
    api.sandboxGitInfo(repo, start).then((i) => {
      setInfo(i);
      setAuthor({ name: i.authorName, email: i.authorEmail });
      setRemote(i.remotes.find((r) => r.name === "origin")?.name ?? i.remotes[0]?.name ?? null);
      setSign(i.sign);
    }, (e) => setError(String(e)));
    proposeMessage().then((m) => { if (m) setMessage((cur) => cur || m); }).finally(() => setWriting(false));
  }, [repo, start]);

  const remoteUrl = info?.remotes.find((r) => r.name === remote)?.url ?? "";
  const canPush = !!remote;
  const canPr = canPush && push && !!info?.gh && !!info.currentBranch;
  const branch = existing ?? `${type}${name.trim()}`;
  const ready = !!info && !!message.trim() && !!author.name.trim() && !!author.email.trim() && (!!existing || !!name.trim());

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setDone(await onCreate({
        branch, message, authorName: author.name.trim(), authorEmail: author.email.trim(), sign,
        push: canPush && push ? remote : null, prBase: canPr && pr ? info!.currentBranch : null,
      }));
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  if (done) {
    return (
      <Dialog title={existing ? t("Commit added") : t("Branch created")} width={520} onClose={onClose}>
        <div className="dbody">
          <p>{tn("{branch} · commit {commit}", { branch: <b className="mono">{done.branch}</b>, commit: <span className="mono">{done.commit}</span> })}</p>
          {done.pushed && <p className="ok-line"><Icon name="check" size={14} />{t("Pushed to {remote}.", { remote: remote ?? "" })}</p>}
          {done.prUrl && (
            <p><button className="link-btn" onClick={() => openUrl(done.prUrl!).catch(() => {})}>{t("Open the pull request")}<Icon name="arrowUpRight" size={13} /></button></p>
          )}
          {done.warning && <p className="err">{done.warning}</p>}
        </div>
        <div className="dfoot"><div className="right"><button className="btn pri" autoFocus onClick={onClose}>{t("Close")}</button></div></div>
      </Dialog>
    );
  }

  return (
    <Dialog title={existing ? t("New commit on {branch}", { branch: existing }) : t("Create a branch and commit")} width={560} onClose={() => !busy && onClose()}
      lead={existing ? t("With the sandbox's changes since the last commit.") : t("In the context's repository, starting from where the sandbox began ({commit}).", { commit: info?.startShort ?? "…" })}>
      {!existing && (
        <div className="fld">
          <label className="lbl" htmlFor="br-name">{t("Branch")}</label>
          <div className="br-row">
            <select className="text select br-type" value={type} onChange={(e) => setType(e.target.value)} aria-label={t("Branch type")}>
              {TYPES.map((x) => <option key={x} value={x}>{x || t("no prefix")}</option>)}
            </select>
            <input id="br-name" className="text mono-in" value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))} />
          </div>
        </div>
      )}

      <div className="fld">
        <label className="lbl" htmlFor="br-msg">{t("Commit message")}</label>
        <textarea id="br-msg" className="text area" rows={4} value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder={writing ? t("Claude is writing the message…") : t("Subject, blank line, details")} />
      </div>

      <div className="fld">
        <span className="lbl">{t("Git configuration")}</span>
        <div className="git-cfg">
          <div className="gr">
            <span className="k">{t("Author")}</span>
            {editAuthor ? (
              <span className="v edit">
                <input className="text" value={author.name} placeholder={t("Name")} onChange={(e) => setAuthor({ ...author, name: e.target.value })} />
                <input className="text" value={author.email} placeholder="email" onChange={(e) => setAuthor({ ...author, email: e.target.value })} />
              </span>
            ) : (
              <span className="v">{author.name || author.email ? `${author.name} <${author.email}>` : t("not set")}</span>
            )}
            {!editAuthor && info?.authorSource && <span className="src">{info.authorSource === "local" ? t("this repo") : info.authorSource === "global" ? t("global") : info.authorSource}</span>}
            <button className="link-btn" onClick={() => setEditAuthor((v) => !v)}>{editAuthor ? t("Done") : t("Edit")}</button>
          </div>
          <div className="gr">
            <span className="k">{t("Remote")}</span>
            {info && info.remotes.length > 1 ? (
              <select className="text select v" value={remote ?? ""} onChange={(e) => setRemote(e.target.value)}>
                {info.remotes.map((r) => <option key={r.name} value={r.name}>{r.name} · {r.url}</option>)}
              </select>
            ) : (
              <span className="v mono">{remote ? `${remote} · ${remoteUrl}` : t("none")}</span>
            )}
          </div>
          <label className="gr">
            <span className="k">{t("Sign the commit")}</span>
            <span className="v">{sign ? t("Yes (GPG)") : t("No")}</span>
            <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} />
          </label>
        </div>
        <span className="hint">{t("Read from git. Changes apply to this commit only: the repo's and the global configuration don't change.")}</span>
      </div>

      <label className="check sbx-carry">
        <input type="checkbox" checked={canPush && push} disabled={!canPush} onChange={(e) => setPush(e.target.checked)} />
        <span><b>{remote ? t("Push to {remote}", { remote }) : t("Push")}</b>{!canPush && <span className="hint">{t("The repository has no remote.")}</span>}</span>
      </label>
      <label className="check sbx-carry">
        <input type="checkbox" checked={canPr && pr} disabled={!canPr} onChange={(e) => setPr(e.target.checked)} />
        <span>
          <b>{t("Open a pull request")}</b>
          <span className="hint">{!info?.gh ? t("Needs GitHub CLI (gh) installed and signed in.") : info.currentBranch ? t("With GitHub CLI, towards {branch}.", { branch: info.currentBranch }) : t("The repository isn't on a branch.")}</span>
        </span>
      </label>

      {error && <p className="err">{error}</p>}
      <div className="dfoot">
        <div className="right">
          <button className="btn ghost" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
          <button className="btn pri" disabled={!ready || busy} onClick={create}>
            <Icon name="detach" size={14} />{busy ? t("Working…") : existing ? t("Commit") : t("Create branch and commit")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
