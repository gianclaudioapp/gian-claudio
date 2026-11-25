import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { ACCOUNT_COLORS, Account, AccountKind, Context, newId, accVars } from "./model";
import { Confirm, Dialog, Menu } from "./ui";
import { t, tn } from "./i18n";

interface Props {
  accounts: Account[];
  contexts: Context[];
  /** Bumped when a login tab closes, to refresh statuses. */
  version: number;
  onAdd: (a: Account, apiKey: string | null) => Promise<void>;
  onUpdate: (a: Account, apiKey: string | null) => Promise<void>;
  onRemove: (a: Account) => void;
  onLogin: (a: Account) => void;
  onUsage: (a: Account) => void;
}

/** Label for an account kind (a function, so it follows the current language). */
function kindLabel(kind: AccountKind): string {
  switch (kind) {
    case "default": return t("Standard configuration");
    case "subscription": return t("Claude subscription");
    case "apikey": return t("API key");
  }
}

export function AccountsPage({ accounts, contexts, version, onAdd, onUpdate, onRemove, onLogin, onUsage }: Props) {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(accounts.map(async (a) => [a.id, await api.accountStatus(a.id, a.kind, a.configDir)] as const)).then((r) => {
      if (alive) setStatus(Object.fromEntries(r));
    });
    return () => { alive = false; };
  }, [accounts, version]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Accounts")}</h1>
        <div className="right">
          <button className="btn pri" onClick={() => setEditing("new")}><Icon name="plus" size={14} />{t("Add account")}</button>
        </div>
      </div>
      <div className="page-body">
        <div className="atable">
          <div className="thead"><span /><span>{t("Name and type")}</span><span>{t("Configuration")}</span><span>{t("Status")}</span><span>{t("Used in")}</span><span /></div>
          {accounts.map((a) => {
            const used = contexts.filter((c) => c.accountId === a.id).length;
            const ok = status[a.id];
            return (
              <div key={a.id} className="arow">
                <div><span className="av acc-c" style={accVars(a.color)}>{a.name[0]?.toUpperCase()}</span></div>
                <div className="cell-col"><div className="nm">{a.name}</div><div className="typ">{kindLabel(a.kind)}</div></div>
                <div title={a.configDir ?? "~\\.claude"}><span className="idn">{a.kind === "apikey" ? t("Key in Windows Credential Manager") : a.configDir ?? "~\\.claude"}</span></div>
                <div>
                  {ok === undefined ? <span className="st">…</span> : ok
                    ? <span className="st ok"><span className="sdot" />{t("Connected")}</span>
                    : <span className="st exp"><Icon name="alert" size={14} />{a.kind === "apikey" ? t("Key missing") : t("Sign-in required")}</span>}
                </div>
                <div className="hc"><Icon name="folder" size={14} />{used === 1 ? t("1 context") : t("{n} contexts", { n: used })}</div>
                <div className="act">
                  {ok === false && a.kind !== "apikey" && <button className="btn warn" onClick={() => onLogin(a)}><Icon name="login" size={14} />{t("Sign in")}</button>}
                  <button className="btn" onClick={() => setEditing(a)}>{t("Edit")}</button>
                  <Menu items={[
                    { label: t("Usage"), icon: "chart", onClick: () => onUsage(a) },
                    { label: t("Sign in again"), icon: "login", disabled: a.kind === "apikey", onClick: () => onLogin(a) },
                    { label: t("Delete account"), icon: "trash", danger: true, onClick: () => setRemoving(a) },
                  ]} />
                </div>
              </div>
            );
          })}
        </div>
        <p className="page-note"><Icon name="layers" size={14} />{t("Each account uses a separate configuration folder, so sessions don't interfere and can run at the same time.")}</p>
      </div>

      {editing && (
        <AccountDialog account={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (a, key) => { editing === "new" ? await onAdd(a, key) : await onUpdate(a, key); setEditing(null); }} />
      )}
      {removing && (
        <Confirm title={t("Delete this account?")} danger confirmLabel={t("Delete account")} onClose={() => setRemoving(null)} onConfirm={() => onRemove(removing)}
          text={<RemoveText account={removing} contexts={contexts.filter((c) => c.accountId === removing.id)} />} />
      )}
    </div>
  );
}

function RemoveText({ account, contexts }: { account: Account; contexts: Context[] }) {
  return (
    <>
      <p>
        {tn("The account {name} will be removed.", { name: <b>{account.name}</b> })}{" "}
        {account.kind === "default"
          ? t("Claude Code's standard configuration (~\\.claude) stays untouched.")
          : t("Its configuration folder is also deleted (Claude Code sign-in, settings and transcripts).")}
      </p>
      {contexts.length > 0 && (
        <>
          <p>{contexts.length === 1
            ? t("This context will also be deleted, along with its history. Open chats will be closed.")
            : t("These {n} contexts will also be deleted, along with their history. Open chats will be closed.", { n: contexts.length })}</p>
          <ul>{contexts.map((c) => <li key={c.id}><b>{c.name}</b></li>)}</ul>
        </>
      )}
      <p>{t("This can't be undone.")}</p>
    </>
  );
}

function AccountDialog({ account, onClose, onSave }: {
  account: Account | null; onClose: () => void; onSave: (a: Account, apiKey: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(account?.name ?? "");
  const [color, setColor] = useState(account?.color ?? ACCOUNT_COLORS[3]);
  const [hex, setHex] = useState((account?.color ?? ACCOUNT_COLORS[3]).slice(1).toUpperCase());
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? "subscription");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const custom = !ACCOUNT_COLORS.includes(color);

  function pick(c: string) {
    setColor(c);
    setHex(c.slice(1).toUpperCase());
  }
  function onHex(v: string) {
    const clean = v.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    setHex(clean.toUpperCase());
    if (clean.length === 6) setColor("#" + clean.toUpperCase());
  }

  const valid = name.trim() !== "" && (kind !== "apikey" || account?.kind === "apikey" || key.trim() !== "");

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const a: Account = account
        ? { ...account, name: name.trim(), color }
        : { id: newId(), name: name.trim(), color, kind, configDir: null };
      await onSave(a, key.trim() || null);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog title={account ? t("Edit account") : t("Add account")}
      lead={account ? undefined : t("Once signed in, you can use it in one or more contexts.")} onClose={onClose}>
      <div className="fld">
        <label className="lbl" htmlFor="acc-name">{t("Name")}</label>
        <input id="acc-name" className="text" autoFocus value={name} placeholder={t("e.g. Acme client")} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="fld">
        <span className="lbl">{t("Color")}</span>
        <div className="swatches" role="radiogroup" aria-label={t("Color")}>
          {ACCOUNT_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={color === c} className={`sw${color === c ? " on" : ""}`} style={{ background: c }} title={c} onClick={() => pick(c)}>
              {color === c && <Icon name="check" size={14} />}
            </button>
          ))}
          <label className={`sw cus${custom ? " on" : ""}`} title={t("Custom color")}>
            {custom && <Icon name="check" size={14} />}
            <input type="color" value={color} onChange={(e) => pick(e.target.value.toUpperCase())} aria-label={t("Choose a custom color")} />
          </label>
        </div>
        <div className="hexrow">
          <span className="prev" style={{ background: color }} />
          <label className="hex"><span>#</span><input value={hex} onChange={(e) => onHex(e.target.value)} maxLength={6} aria-label={t("Hex color")} /></label>
          <span className="tagprev">{t("Preview")} <span className="tag acc-c" style={accVars(color)}>{name.trim() || t("Account")}</span></span>
        </div>
      </div>
      {!account && (
        <div className="fld">
          <span className="lbl">{t("Type")}</span>
          <button className="rad" onClick={() => setKind("subscription")} role="radio" aria-checked={kind === "subscription"}>
            <span className={`radio${kind === "subscription" ? " on" : ""}`} />
            <span><b>{t("Claude subscription (Pro, Max, Team)")}</b><span className="rad-p">{tn("Sign in from the browser: a tab opens running {cmd} in this account's folder.", { cmd: <code>claude</code> })}</span></span>
          </button>
          <button className="rad" onClick={() => setKind("apikey")} role="radio" aria-checked={kind === "apikey"}>
            <span className={`radio${kind === "apikey" ? " on" : ""}`} />
            <span><b>{t("API key")}</b><span className="rad-p">{t("Paste the key from the Console. It's stored in Windows Credential Manager.")}</span></span>
          </button>
        </div>
      )}
      {(kind === "apikey" || account?.kind === "apikey") && (
        <div className="fld">
          <label className="lbl" htmlFor="acc-key">{account ? t("New API key (leave empty to keep the current one)") : t("API key")}</label>
          <input id="acc-key" className="text mono" type="password" autoComplete="off" value={key} placeholder="sk-ant-…" onChange={(e) => setKey(e.target.value)} />
        </div>
      )}
      {err && <p className="err">{err}</p>}
      <div className="dfoot">
        <span className="info"><Icon name="layers" size={14} />{t("Each account uses a separate configuration folder.")}</span>
        <div className="right">
          <button className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn pri" disabled={!valid || busy} onClick={save}>
            {account ? t("Save") : kind === "subscription" ? <>{t("Continue and sign in")}<Icon name="arrowUpRight" size={14} /></> : t("Add")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
