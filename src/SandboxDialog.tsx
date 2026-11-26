// "Detach into a Sandbox": name, whether to move the uncommitted changes, and
// which files ignored by git to copy. Folders that get regenerated (node_modules,
// target, .venv…) are left out unless picked.
import { useEffect, useState } from "react";
import { Dialog } from "./ui";
import { Icon } from "./icons";
import { IgnoredEntry, SandboxScan, api } from "./api";
import { t } from "./i18n";

export interface SandboxInput {
  name: string;
  carry: boolean;
  copy: string[];
}

interface Props {
  /** The context's working folder. */
  dir: string;
  defaultName: string;
  /** Ignored files picked last time for this context. */
  remembered?: string[];
  onCancel: () => void;
  /** Rejects with the error to show. */
  onCreate: (input: SandboxInput) => Promise<void>;
}

function fmtSize(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** After detaching, what to run to get the regenerated folders back. */
function reinstallHint(project: string | null): string | null {
  switch (project) {
    case "node": return t("Node project: after detaching, run {cmd} in the sandbox terminal.", { cmd: "npm install" });
    case "python": return t("Python project: recreate the virtual environment in the sandbox if you need it.");
    case "php": return t("PHP project: after detaching, run {cmd} in the sandbox terminal.", { cmd: "composer install" });
    default: return null;
  }
}

export function SandboxDialog({ dir, defaultName, remembered, onCancel, onCreate }: Props) {
  const [scan, setScan] = useState<SandboxScan | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [name, setName] = useState(defaultName);
  const [carry, setCarry] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showRegen, setShowRegen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rescan, setRescan] = useState(0);
  const [trusting, setTrusting] = useState(false);
  useEffect(() => {
    api.sandboxScan(dir).then((s) => {
      setScan(s);
      const known = new Set(s.ignored.map((e) => e.path));
      const fromMemory = (remembered ?? []).filter((p) => known.has(p));
      setPicked(new Set(remembered ? fromMemory : s.ignored.filter((e) => e.preselected).map((e) => e.path)));
    }, (e) => setScanError(String(e)));
  }, [dir, rescan]);

  async function trust(path: string) {
    setTrusting(true);
    try {
      await api.gitTrust(path);
      setScan(null);
      setRescan((n) => n + 1);
    } catch (e) {
      setScanError(String(e));
    }
    setTrusting(false);
  }

  const toggle = (p: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  });

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), carry: !!scan?.git && carry && scan.changes > 0, copy: [...picked] });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const normal = scan?.ignored.filter((e) => !e.regen) ?? [];
  const regen = scan?.ignored.filter((e) => e.regen) ?? [];
  const regenSize = regen.reduce<number | null>((sum, e) => (sum === null || e.size === null ? null : sum + e.size), 0);
  const row = (e: IgnoredEntry) => (
    <label key={e.path} className="ig">
      <input type="checkbox" checked={picked.has(e.path)} onChange={() => toggle(e.path)} />
      <span className="ig-name" title={e.path}>{e.path}</span>
      <span className="ig-size">{fmtSize(e.size)}</span>
    </label>
  );

  return (
    <Dialog title={t("Detach into a Sandbox")} width={520} onClose={() => !busy && onCancel()}
      lead={t("The chat continues in a separate folder, with all its history. This chat stays here and you can keep using it.")}>
      <div className="fld">
        <label className="lbl" htmlFor="sbx-name">{t("Name")}</label>
        <input id="sbx-name" className="text" autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && scan && !busy && create()} />
      </div>

      {!scan && !scanError && <p className="hint">{t("Looking at the folder…")}</p>}
      {scanError && <p className="err">{scanError}</p>}

      {scan?.git && scan.changes > 0 && (
        <label className="check sbx-carry">
          <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
          <span>
            <b>{scan.changes === 1 ? t("Move the uncommitted changes (1 file)") : t("Move the uncommitted changes ({n} files)", { n: scan.changes })}</b>
            <span className="hint">{t("They move into the sandbox and this folder goes back to the last commit. Otherwise the sandbox starts from the last commit.")}</span>
          </span>
        </label>
      )}

      {scan?.untrusted && (
        <div className="sbx-trust">
          <p className="info-line"><Icon name="alert" size={14} /><span>{t("This is a git repository, but git doesn't trust it because another user owns the folder (for example, it was created as administrator). Until you mark it as safe, the sandbox gets a plain copy and git can't be used there.")}</span></p>
          <button className="btn" disabled={trusting} onClick={() => trust(scan.untrusted!)}>{trusting ? t("Working…") : t("Mark this folder as safe")}</button>
          <span className="hint">{t("Adds it to git's safe.directory list, as git itself suggests.")}</span>
        </div>
      )}
      {scan && !scan.git && !scan.untrusted && (
        <p className="info-line"><Icon name="info" size={14} /><span>{t("This folder isn't a git repository: it gets copied, without the folders that are regenerated.")}</span></p>
      )}

      {scan && (normal.length > 0 || regen.length > 0) && (
        <div className="fld">
          <span className="lbl">{scan.git ? t("Files ignored by git to copy") : t("Not copied")}</span>
          <div className="ign">
            {normal.map(row)}
            {regen.length > 0 && (
              <button className="ig regen" onClick={() => setShowRegen((v) => !v)} aria-expanded={showRegen}>
                <Icon name={showRegen ? "chevronDown" : "chevronRight"} size={14} />
                <span className="ig-name" title={regen.map((e) => e.path).join("\n")}>{t("To regenerate, not copied")} · <span className="mono">{regen.slice(0, 3).map((e) => e.path).join(", ")}{regen.length > 3 ? "…" : ""}</span></span>
                <span className="ig-size">{fmtSize(regenSize)}</span>
              </button>
            )}
            {showRegen && regen.map(row)}
          </div>
          {reinstallHint(scan.project) && <span className="hint">{reinstallHint(scan.project)}</span>}
        </div>
      )}

      {scan && !scan.gitInstalled && (
        <p className="info-line"><Icon name="alert" size={14} /><span>{t("Git isn't installed: the sandbox works, but its list of changes won't be available.")}</span></p>
      )}

      {error && <p className="err">{error}</p>}
      <div className="dfoot">
        <div className="right">
          <button className="btn ghost" disabled={busy} onClick={onCancel}>{t("Cancel")}</button>
          <button className="btn pri" disabled={!scan || !name.trim() || busy} onClick={create}>
            <Icon name="box" size={14} />{busy ? t("Creating…") : t("Create sandbox")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
