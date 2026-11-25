import { ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";

/** Modal shell: dimmed backdrop, Esc / backdrop click to close. */
export function Dialog({ title, lead, onClose, children, width = 560 }: {
  title: string; lead?: string; onClose: () => void; children: ReactNode; width?: number;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="dh">
          <div>
            <h2>{title}</h2>
            {lead && <p>{lead}</p>}
          </div>
          <button className="icon-btn" title={t("Close")} onClick={onClose}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, text, confirmLabel, cancelLabel, danger, onConfirm, onClose }: {
  title: string; text: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose} width={460}>
      <div className="dbody">{text}</div>
      <div className="dfoot">
        <div className="right">
          <button className="btn ghost" onClick={onClose}>{cancelLabel ?? t("Cancel")}</button>
          <button className={`btn ${danger ? "danger" : "pri"}`} autoFocus onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
        </div>
      </div>
    </Dialog>
  );
}

type MenuItem = { label: string; icon?: Parameters<typeof Icon>[0]["name"]; danger?: boolean; disabled?: boolean; onClick: () => void };

/** Right-click menu at the pointer, kept inside the window. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) });
      el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", key);
    };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className="menu ctx-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <button key={it.label} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled}
          onClick={() => { onClose(); it.onClick(); }}>
          {it.icon && <Icon name={it.icon} size={15} />}{it.label}
        </button>
      ))}
    </div>
  );
}

/** Small dropdown menu anchored to its trigger button. */
export function Menu({ items }: { items: { label: string; icon?: Parameters<typeof Icon>[0]["name"]; danger?: boolean; disabled?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    // stopPropagation: menus also sit inside clickable rows (sidebar items).
    <div className={`menu-wrap${open ? " open" : ""}`} ref={ref} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" title={t("More actions")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon && <Icon name={it.icon} size={15} />}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
