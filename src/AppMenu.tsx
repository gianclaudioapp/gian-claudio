// The app menu behind the hamburger next to the logo: File, Edit, View,
// Window and Help, each opening a submenu, like a classic Windows menu bar.
// Keyboard: arrows move, → opens a submenu, ← and Esc go back.
import { KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";

export interface AppMenuItem {
  label: string;
  /** Keyboard shortcut shown on the right (display only). */
  hint?: string;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
  onClick: () => void;
}

export interface AppMenuGroup {
  label: string;
  separator?: boolean;
  items: AppMenuItem[];
}

/** Moving the mouse to another group waits this long, so a diagonal path to a submenu doesn't switch it. */
const HOVER_DELAY = 120;

const enabledItems = (menu: Element | null) =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>(":scope > div > button:not(:disabled)") ?? []);

/** `groups` is read when the menu opens, so states like "has a selection" are current. */
export function AppMenu({ groups }: { groups: () => AppMenuGroup[] }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const ham = useRef<HTMLButtonElement>(null);
  const hover = useRef<number | undefined>(undefined);
  /** Where focus goes after the next render: the first top-level row or the open submenu. */
  const focusNext = useRef<"top" | "sub" | null>(null);

  const close = (refocus: boolean) => {
    window.clearTimeout(hover.current);
    setOpen(false);
    setSub(null);
    if (refocus) ham.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close(false);
    const blur = () => close(false);
    window.addEventListener("mousedown", outside);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", blur);
      window.clearTimeout(hover.current);
    };
  }, [open]);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "top") enabledItems(ref.current?.querySelector(".am-top") ?? null)[0]?.focus();
    if (target === "sub") enabledItems(ref.current?.querySelector(".am-sub") ?? null)[0]?.focus();
  }, [open, sub]);

  function hoverGroup(i: number) {
    window.clearTimeout(hover.current);
    if (sub === null || sub === i) setSub(i);
    else hover.current = window.setTimeout(() => setSub(i), HOVER_DELAY);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    const el = e.target as HTMLElement;
    const menu = el.closest("[role=menu]");
    const inSub = !!menu?.classList.contains("am-sub");
    const row = el.closest(".am-row");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = enabledItems(menu);
      const at = items.indexOf(el as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowRight" && !inSub && row) {
      e.preventDefault();
      focusNext.current = "sub";
      setSub(Number((row as HTMLElement).dataset.index));
    } else if ((e.key === "ArrowLeft" || e.key === "Escape") && inSub) {
      e.preventDefault();
      row?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
      setSub(null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  }

  const list = open ? groups() : [];
  return (
    <div className="am" ref={ref}>
      <button ref={ham} className={`icon-btn am-ham${open ? " on" : ""}`} title={t("Menu")} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { if (open) close(false); else { focusNext.current = "top"; setOpen(true); } }}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); focusNext.current = "top"; setOpen(true); } }}>
        <Icon name="menu" />
      </button>
      {open && (
        <div className="menu am-top" role="menu" onKeyDown={onKeyDown}>
          {list.map((g, i) => (
            <div key={g.label} className="am-row" data-index={i} onMouseEnter={() => hoverGroup(i)}>
              {g.separator && <hr />}
              <button role="menuitem" aria-haspopup="menu" aria-expanded={sub === i} className={sub === i ? "on" : ""}
                onClick={(e) => { window.clearTimeout(hover.current); focusNext.current = e.detail === 0 ? "sub" : null; setSub(i); }}>
                {g.label}<Icon name="chevronRight" size={14} />
              </button>
              {sub === i && (
                <div className="menu am-sub" role="menu" aria-label={g.label}>
                  {g.items.map((it) => (
                    <div key={it.label}>
                      {it.separator && <hr />}
                      <button role="menuitem" disabled={it.disabled} onClick={() => { close(false); it.onClick(); }}>
                        {it.label}{it.hint && <kbd>{it.hint}</kbd>}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
