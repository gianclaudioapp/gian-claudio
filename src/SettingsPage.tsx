import { useEffect, useState } from "react";
import { api } from "./api";
import type { AppUpdateState } from "./updates";
import { Icon } from "./icons";
import { LANGUAGES, LangSetting, t, tn } from "./i18n";
import { ACCENTS, Settings, SummaryModel, TERMINAL_SCALE_MAX, TERMINAL_SCALE_MIN, isNewerVersion, terminalFontSize, versionNumber } from "./model";

interface Props {
  settings: Settings;
  dataDir: string;
  claudeVersion: string | null | undefined;
  claudeLatest: string | null | undefined;
  onChange: (s: Settings) => void;
  onRecheck: () => void;
  onInstall: () => void;
  onUpdate: () => void;
  /** Version of Gian Claudio, and the state of its own update check. */
  appVersion: string | null;
  appUpdate: AppUpdateState;
  onCheckAppUpdate: () => void;
  onInstallAppUpdate: () => void;
}

export function SettingsPage({ settings, dataDir, claudeVersion, claudeLatest, onChange, onRecheck, onInstall, onUpdate, appVersion, appUpdate, onCheckAppUpdate, onInstallAppUpdate }: Props) {
  const [checking, setChecking] = useState(false);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartErr, setAutostartErr] = useState<string | null>(null);
  useEffect(() => setChecking(false), [claudeVersion, claudeLatest]);
  const busy = claudeVersion === undefined || claudeLatest === undefined || checking;
  const outdated = !busy && isNewerVersion(claudeVersion, claudeLatest);
  useEffect(() => {
    api.autostartGet().then(setAutostart);
  }, []);

  // Built during render so the labels follow the current language.
  const models: { id: SummaryModel; label: string; desc: string }[] = [
    { id: "sonnet", label: "Sonnet", desc: t("Accurate summaries. Recommended.") },
    { id: "haiku", label: "Haiku", desc: t("Faster and cheaper, less precise.") },
    { id: "off", label: t("Off"), desc: t("Past chats are saved without a summary.") },
  ];
  const accentName = ACCENTS.find((a) => a.color === settings.accent)?.name;
  const languages: { id: LangSetting; name: string }[] = [{ id: "system", name: t("System") }, ...LANGUAGES];

  async function toggleAutostart(on: boolean) {
    setAutostartErr(null);
    try {
      await api.autostartSet(on);
      setAutostart(on);
    } catch (e) {
      setAutostartErr(String(e));
    }
  }

  return (
    <div className="page">
      <div className="page-head"><h1>{t("Settings")}</h1></div>
      <div className="page-body">
        <div className="settings">
          <section className="set-row">
            <div><h2>{t("Language")}</h2><p>{t("The interface language. System follows Windows, and falls back to English.")}</p></div>
            <div className="set-ctl col">
              <div className="seg" role="radiogroup" aria-label={t("Language")}>
                {languages.map((l) => (
                  <button key={l.id} role="radio" aria-checked={settings.language === l.id} className={settings.language === l.id ? "on" : ""}
                    onClick={() => onChange({ ...settings, language: l.id })}>{l.name}</button>
                ))}
              </div>
              {settings.language === "system" && <span className="hint">{t("Follows the Windows language.")}</span>}
            </div>
          </section>
          <section className="set-row">
            <div><h2>{t("Theme")}</h2><p>{t("You can also switch it from the button next to Settings, bottom left.")}</p></div>
            <div className="set-ctl">
              <div className="seg" role="radiogroup" aria-label={t("Theme")}>
                <button role="radio" aria-checked={settings.theme === "light"} className={settings.theme === "light" ? "on" : ""} onClick={() => onChange({ ...settings, theme: "light" })}><Icon name="sun" size={14} />{t("Light")}</button>
                <button role="radio" aria-checked={settings.theme === "dark"} className={settings.theme === "dark" ? "on" : ""} onClick={() => onChange({ ...settings, theme: "dark" })}><Icon name="moon" size={14} />{t("Dark")}</button>
              </div>
            </div>
          </section>
          <section className="set-row">
            <div><h2>{t("Accent color")}</h2><p>{t("Used for the logo, the main buttons and the active tab.")}</p></div>
            <div className="set-ctl col">
              <div className="swatches" role="radiogroup" aria-label={t("Accent color")}>
                {ACCENTS.map((a) => (
                  <button key={a.color} role="radio" aria-checked={settings.accent === a.color} title={t(a.name)}
                    className={`sw${settings.accent === a.color ? " on" : ""}`} style={{ background: a.color }}
                    onClick={() => onChange({ ...settings, accent: a.color })}>
                    {settings.accent === a.color && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
              <span className="hint">{accentName ? t(accentName) : settings.accent}</span>
            </div>
          </section>
          <section className="set-row">
            <div><h2>{t("Terminal text size")}</h2><p>{t("Applies to every chat, straight away.")}</p></div>
            <div className="set-ctl col">
              <div className="scale-row">
                <span className="scale-a small" aria-hidden="true">A</span>
                <input type="range" className="scale" min={TERMINAL_SCALE_MIN} max={TERMINAL_SCALE_MAX} step={5}
                  value={settings.terminalScale} aria-label={t("Terminal text size")}
                  aria-valuetext={`${settings.terminalScale}%`}
                  onChange={(e) => onChange({ ...settings, terminalScale: Number(e.target.value) })} />
                <span className="scale-a big" aria-hidden="true">A</span>
                <output className="scale-val">{settings.terminalScale}%</output>
                {settings.terminalScale !== 100 && (
                  <button className="btn ghost" onClick={() => onChange({ ...settings, terminalScale: 100 })}>{t("Reset")}</button>
                )}
              </div>
              <span className="scale-preview" style={{ fontSize: terminalFontSize(settings.terminalScale) }}>
                {t("● Claude: done, the tests pass (7/7).")}
              </span>
            </div>
          </section>
          <section className="set-row">
            <div><h2>{t("Window")}</h2><p>{import.meta.env.DEV
              ? tn("Development build: {keys} and starting with Windows stay with the installed app.", { keys: <><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd></> })
              : tn("Press {keys} to bring up the app from any program.", { keys: <><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd></> })}</p></div>
            <div className="set-ctl col">
              <label className="check">
                <input type="checkbox" checked={settings.closeToTray && !import.meta.env.DEV} disabled={import.meta.env.DEV} onChange={(e) => onChange({ ...settings, closeToTray: e.target.checked })} />
                <span><b>{t("Minimize to the system tray when closed")}</b><span className="rad-p">{t("Chats in progress keep running. To quit for real, use “Quit” from the icon near the clock.")}</span></span>
              </label>
              <label className="check">
                <input type="checkbox" checked={!!autostart} disabled={autostart === null || import.meta.env.DEV} onChange={(e) => toggleAutostart(e.target.checked)} />
                <span><b>{t("Start with Windows")}</b><span className="rad-p">{t("Starts minimized in the system tray.")}</span></span>
              </label>
              {autostartErr && <span className="err">{autostartErr}</span>}
              <button className="btn" onClick={() => api.quit()}><Icon name="x" size={14} />{t("Quit the app")}</button>
            </div>
          </section>
          <section className="set-row">
            <div><h2>Gian Claudio</h2><p>{t("The app checks for new versions when it starts. Updating restarts it; open chats resume afterwards.")}</p></div>
            <div className="set-ctl col">
              <div className="set-line">
                <span className="st ok"><span className="sdot" />{appVersion ? t("Version {version}", { version: appVersion }) : "—"}</span>
                <button className="btn" disabled={appUpdate.status === "checking" || appUpdate.status === "installing"} onClick={onCheckAppUpdate}>
                  <Icon name="refresh" size={14} />{t("Check for updates")}
                </button>
              </div>
              {appUpdate.status === "checking" && <span className="hint">{t("Checking…")}</span>}
              {appUpdate.status === "none" && <span className="hint">{t("This is the latest version.")}</span>}
              {appUpdate.status === "failed" && <span className="hint">{t("Couldn't check for updates (are you offline?).")}</span>}
              {appUpdate.status === "available" && (
                <div className="set-line">
                  <span className="hint">{t("Version {version} is available.", { version: appUpdate.update.version })}</span>
                  <button className="btn pri" onClick={onInstallAppUpdate}><Icon name="download" size={14} />{t("Update and restart")}</button>
                </div>
              )}
              {appUpdate.status === "installing" && (
                <span className="hint">{appUpdate.percent === null ? t("Downloading the update…") : t("Downloading the update… {n}%", { n: Math.round(appUpdate.percent) })}</span>
              )}
            </div>
          </section>
          <section className="set-row">
            <div><h2>Claude Code</h2><p>{tn("The {cli} CLI that the app starts in every chat. The app checks for updates when it starts.", { cli: <code>claude</code> })}</p></div>
            <div className="set-ctl col">
              <div className="set-line">
                {busy ? <span className="st">{t("Checking…")}</span>
                  : claudeVersion ? <span className="st ok"><span className="sdot" />{t("Version {version}", { version: versionNumber(claudeVersion) })}</span>
                  : <span className="st exp"><Icon name="alert" size={14} />{t("Not found")}</span>}
                <button className="btn" disabled={busy} onClick={() => { setChecking(true); onRecheck(); }}><Icon name="refresh" size={14} />{t("Check for updates")}</button>
                {claudeVersion === null && !busy && <button className="btn pri" onClick={onInstall}><Icon name="download" size={14} />{t("Install")}</button>}
              </div>
              {!busy && claudeVersion && (
                outdated ? (
                  <div className="set-line">
                    <span className="hint">{t("Version {version} is available.", { version: versionNumber(claudeLatest!) })}</span>
                    <button className="btn pri" onClick={onUpdate}><Icon name="download" size={14} />{t("Update")}</button>
                  </div>
                ) : (
                  <span className="hint">{claudeLatest ? t("This is the latest version.") : t("Couldn't check for updates (are you offline?).")}</span>
                )
              )}
            </div>
          </section>
          <section className="set-row">
            <div><h2>{t("Summaries of past chats")}</h2><p>{t("When you start a new chat, Claude summarizes the previous one before saving it to history.")}</p></div>
            <div className="set-ctl col" role="radiogroup" aria-label={t("Summary model")}>
              {models.map((m) => (
                <button key={m.id} className="rad" role="radio" aria-checked={settings.summaryModel === m.id} onClick={() => onChange({ ...settings, summaryModel: m.id })}>
                  <span className={`radio${settings.summaryModel === m.id ? " on" : ""}`} />
                  <span><b>{m.label}</b><span className="rad-p">{m.desc}</span></span>
                </button>
              ))}
            </div>
          </section>
          <section className="set-row">
            <div><h2>{t("Data folder")}</h2><p>{t("App state, accounts and context history.")}</p></div>
            <div className="set-ctl">
              <code className="path">{dataDir}</code>
              <button className="btn" onClick={() => api.openFolder(dataDir)}><Icon name="folder" size={14} />{t("Open folder")}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
