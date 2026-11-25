// Help ▸ About Gian Claudio: versions, update state and project links.
import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import { t } from "./i18n";
import { versionNumber } from "./model";
import type { AppUpdateState } from "./updates";

const REPO = "https://github.com/gianclaudioapp/gian-claudio";

interface Props {
  appVersion: string | null;
  /** undefined while checking, null when Claude Code isn't installed. */
  claudeVersion: string | null | undefined;
  appUpdate: AppUpdateState;
  onCheck: () => void;
  onInstall: () => void;
  onClose: () => void;
}

export function About({ appVersion, claudeVersion, appUpdate, onCheck, onInstall, onClose }: Props) {
  // Nothing checked yet (dev builds skip the startup check): check now.
  useEffect(() => {
    if (appUpdate.status === "idle") onCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const busy = appUpdate.status === "checking" || appUpdate.status === "installing";
  const link = (url: string) => () => openUrl(url).catch(() => {});

  return (
    <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg about" role="dialog" aria-modal="true" aria-label={t("About Gian Claudio")}>
        <button className="icon-btn about-x" title={t("Close")} onClick={onClose}><Icon name="x" /></button>
        <Logo height={56} />
        <h2>Gian Claudio</h2>
        <dl>
          <div><dt>{t("Version")}</dt><dd>{appVersion ?? "—"}</dd></div>
          <div>
            <dt>Claude Code</dt>
            <dd>{claudeVersion === undefined ? t("Checking…") : claudeVersion ? versionNumber(claudeVersion) : t("Not installed")}</dd>
          </div>
          <div><dt>{t("Updates")}</dt><dd className="about-st"><UpdateStatus state={appUpdate} /></dd></div>
        </dl>
        {appUpdate.status === "available"
          ? <button className="btn pri" onClick={onInstall}><Icon name="download" size={14} />{t("Update and restart")}</button>
          : <button className="btn" disabled={busy} onClick={onCheck}><Icon name="refresh" size={14} />{t("Check for updates")}</button>}
        <div className="about-links">
          <button onClick={link(REPO)}>GitHub<Icon name="arrowUpRight" size={12} /></button>
          <button onClick={link(`${REPO}/releases`)}>{t("Release notes")}<Icon name="arrowUpRight" size={12} /></button>
          <button onClick={link(`${REPO}/blob/main/LICENSE`)}>{t("MIT License")}</button>
        </div>
        <p className="about-copy">© 2026 DazornSama</p>
      </div>
    </div>
  );
}

function UpdateStatus({ state }: { state: AppUpdateState }) {
  switch (state.status) {
    case "checking": return <>{t("Checking…")}</>;
    case "none": return <span className="st ok"><span className="sdot" />{t("Up to date")}</span>;
    case "failed": return <>{t("Couldn't check")}</>;
    case "available": return <span className="st exp">{t("Version {version} is available.", { version: state.update.version })}</span>;
    case "installing":
      return <>{state.percent === null ? t("Downloading the update…") : t("Downloading the update… {n}%", { n: Math.round(state.percent) })}</>;
    default: return <>—</>;
  }
}
