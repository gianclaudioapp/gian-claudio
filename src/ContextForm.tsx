import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "./icons";
import { Account, Context, folderName, accVars } from "./model";
import { t, tn } from "./i18n";
import type { ShellInfo } from "./api";
import { shellName } from "./ShellPanel";

export interface ContextInput {
  name: string;
  folders: string[];
  workingIndex: number;
  accountId: string;
  shell?: string;
}

interface Props {
  accounts: Account[];
  contexts: Context[];
  /** Present when editing an existing context. */
  initial?: Context;
  historyRoot: (dirName: string) => string;
  /** Shells found on this PC, for the terminal panel. */
  shells: ShellInfo[];
  onSubmit: (c: ContextInput) => void;
  onCancel: () => void;
}

export function ContextForm({ accounts, contexts, initial, historyRoot, shells, onSubmit, onCancel }: Props) {
  const editing = !!initial;
  const [folders, setFolders] = useState<string[]>(initial?.folders.map((f) => f.path) ?? []);
  const [workingIndex, setWorkingIndex] = useState(initial?.workingIndex ?? 0);
  const [name, setName] = useState(initial?.name ?? "");
  const [nameTouched, setNameTouched] = useState(editing);
  const [shell, setShell] = useState(initial?.shell ?? "powershell");
  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id ?? "");

  const suggested = folders[workingIndex] ? folderName(folders[workingIndex]) : "";
  const shownName = nameTouched ? name : suggested;

  async function addFolders() {
    const picked = await open({ directory: true, multiple: true, title: t("Choose the context's folders") });
    if (!picked) return;
    const list = (Array.isArray(picked) ? picked : [picked]).filter((p) => !folders.includes(p));
    setFolders((f) => [...f, ...list]);
  }

  function remove(i: number) {
    setFolders((f) => f.filter((_, j) => j !== i));
    setWorkingIndex((w) => (i < w ? w - 1 : i === w ? 0 : w));
  }

  const canSubmit = folders.length > 0 && shownName.trim() !== "" && accountId !== "";

  return (
    <div className="form">
      <div className="col">
        <div>
          <h2>{editing ? t("Edit context") : t("New context")}</h2>
          <p className="lead">{editing ? t("Folder changes apply from the next chat.") : t("Choose the folders and the account. You can change the name at any time.")}</p>
        </div>

        <div className="fld">
          <span className="lbl">{t("Folders")}</span>
          <span className="hint">{t("Choose the working folder: Claude starts there. The others add extra context.")}</span>
          {folders.length > 0 && (
            <div className="list" role="radiogroup" aria-label={t("Working folder")}>
              {folders.map((f, i) => (
                <div key={f} className="frow" role="radio" aria-checked={i === workingIndex} tabIndex={0}
                  onClick={() => setWorkingIndex(i)} onKeyDown={(e) => e.key === " " && setWorkingIndex(i)}>
                  <span className={`radio${i === workingIndex ? " on" : ""}`} />
                  <Icon name="folder" />
                  <span className="p" title={f}>{f}</span>
                  {i === workingIndex ? <span className="wd-tag">{t("Working folder")}</span> : <span className="set-wd">{t("Set as working folder")}</span>}
                  <button className="rm" title={t("Remove folder")} onClick={(e) => { e.stopPropagation(); remove(i); }}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="acts">
            <button className="btn" onClick={addFolders}><Icon name="folderPlus" size={15} />{t("Add folder…")}</button>
          </div>
        </div>

        <div className="fld">
          <label className="lbl" htmlFor="ctx-name">{t("Name")}</label>
          <input id="ctx-name" className="text" value={shownName} placeholder={t("e.g. billing-api")}
            onChange={(e) => { setNameTouched(true); setName(e.target.value); }} />
          {!nameTouched && suggested && <span className="hint">{t("Suggested from the working folder")}</span>}
        </div>

        <div className="fld">
          <label className="lbl" htmlFor="ctx-shell">{t("Terminal shell")}</label>
          <span className="hint">{t("The one that opens in the terminal next to Claude, in the working folder.")}</span>
          <select id="ctx-shell" className="text select" value={shell} onChange={(e) => setShell(e.target.value)}>
            {(shells.length ? shells : [{ id: "powershell", available: true }]).map((s) => (
              <option key={s.id} value={s.id} disabled={!s.available}>
                {shellName(s.id)}{s.id === "powershell" ? ` · ${t("default")}` : !s.available ? ` · ${t("not installed")}` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="fld">
          <span className="lbl">{t("Account")}</span>
          {accounts.length === 0 && <span className="hint">{t("No accounts yet: add one from the Accounts page.")}</span>}
          {editing && <span className="hint">{t("The account can't be changed: the context's chats are saved in its profile.")}</span>}
          {accounts.map((a) => {
            const used = contexts.filter((c) => c.accountId === a.id).length;
            const on = a.id === accountId;
            if (editing && !on) return null;
            return (
              <button key={a.id} className={`acc${on ? " on" : ""}`} role="radio" aria-checked={on} disabled={editing} onClick={() => setAccountId(a.id)}>
                <span className={`radio${on ? " on" : ""}`} />
                <span className="sq acc-c" style={accVars(a.color)}>{a.name[0]?.toUpperCase()}</span>
                <span>
                  <div>{a.name}</div>
                  <div className="ty">{a.kind === "apikey" ? t("API key") : a.kind === "subscription" ? t("Claude subscription") : t("Standard Claude Code configuration")}</div>
                </span>
                <span className="cnt">{used === 1 ? t("1 context") : t("{n} contexts", { n: used })}</span>
              </button>
            );
          })}
        </div>

        {!editing && shownName && (
          <p className="info-line"><Icon name="clock" size={14} /><span>{tn("Past chats for this context will be saved in {path}", { path: <code>{historyRoot(shownName)}</code> })}</span></p>
        )}

        <div className="form-foot">
          <button className="btn ghost" onClick={onCancel}>{t("Cancel")}</button>
          <button className="btn pri" disabled={!canSubmit} onClick={() => onSubmit({ name: shownName.trim(), folders, workingIndex, accountId, shell })}>
            {editing ? t("Save") : t("Create and start chat")}
          </button>
        </div>
      </div>
    </div>
  );
}
