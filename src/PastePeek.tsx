import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";
import { copyPaste, openPaste, type Paste, type PasteRef, type PasteTracker } from "./pastes";

interface Props {
  pref: PasteRef;
  /** Screen rect of the placeholder in the terminal. */
  anchor: DOMRect;
  tracker: PasteTracker;
  onEnter: () => void;
  onLeave: () => void;
}

/** Most lines drawn in the preview ("Open" shows the whole text). */
const MAX_LINES = 1500;
const GAP = 6;
const MARGIN = 12;

/** Preview of a pasted text or image, shown on Ctrl+hover over its placeholder. */
export function PastePeek({ pref, anchor, tracker, onEnter, onLeave }: Props) {
  const [paste, setPaste] = useState<Paste | null | "loading">("loading");
  const [copied, setCopied] = useState<"ok" | "error" | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setPaste("loading");
    setCopied(null);
    tracker.resolve(pref).then((p) => alive && setPaste(p));
    return () => { alive = false; };
  }, [pref.kind, pref.id, pref.lines, tracker]);

  // Above or below the placeholder, wherever there is more room; kept inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = window.innerHeight - anchor.bottom;
    const top = below >= height + GAP + MARGIN || below > anchor.top
      ? Math.min(anchor.bottom + GAP, window.innerHeight - height - MARGIN)
      : Math.max(MARGIN, anchor.top - height - GAP);
    const left = Math.max(MARGIN, Math.min(anchor.left - 14, window.innerWidth - width - MARGIN));
    setPos({ left, top });
  }, [anchor, paste]);

  const title = pref.kind === "text" ? t("Pasted text #{n}", { n: pref.id }) : t("Image #{n}", { n: pref.id });

  async function copy(p: Paste) {
    try {
      await copyPaste(p);
      setCopied("ok");
    } catch {
      setCopied("error");
    }
    setTimeout(() => setCopied(null), 1600);
  }

  let body: React.ReactNode;
  let meta = "";
  if (paste === "loading") {
    body = <div className="pk-empty">{t("Loading…")}</div>;
  } else if (!paste) {
    body = <div className="pk-empty">{t("The pasted content isn't available anymore.")}</div>;
  } else if (paste.kind === "text") {
    const lines = (paste.text ?? "").replace(/\r\n?/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    meta = `${lines.length === 1 ? t("1 line") : t("{n} lines", { n: lines.length })} · ${size(paste.bytes)}`;
    body = (
      <div className="pk-code">
        {lines.slice(0, MAX_LINES).map((l, i) => (
          <div key={i}><span className="pk-ln">{i + 1}</span><span className="pk-tx">{l || " "}</span></div>
        ))}
        {lines.length > MAX_LINES && <div className="pk-more">{t("…{n} more lines: Open shows them all", { n: lines.length - MAX_LINES })}</div>}
      </div>
    );
  } else {
    const fmt = paste.dataUrl?.match(/^data:image\/(\w+)/)?.[1]?.toUpperCase().replace("JPEG", "JPG") ?? "";
    meta = [paste.width && paste.height ? `${paste.width} × ${paste.height}` : "", fmt, size(paste.bytes)].filter(Boolean).join(" · ");
    body = <div className="pk-shot">{paste.dataUrl && <img src={paste.dataUrl} alt={title} />}</div>;
  }
  const ready = paste !== "loading" && paste;

  return (
    <div ref={box} className={`peek ${pref.kind}`} role="dialog" aria-label={title}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="pk-h">
        <span className="pk-ic"><Icon name={pref.kind === "text" ? "file" : "image"} size={14} /></span>
        <span className="pk-t"><b>{title}</b>{meta && <span>{meta}</span>}</span>
        {ready && (
          <span className="pk-a">
            <button className="pk-b" onClick={() => copy(paste)}>
              <Icon name={copied === "ok" ? "check" : "copy"} size={14} />
              {copied === "ok" ? t("Copied") : copied === "error" ? t("Can't copy") : t("Copy")}
            </button>
            <button className="pk-b" onClick={() => openPaste(paste)?.catch(() => {})}>
              <Icon name="arrowUpRight" size={14} />{t("Open")}
            </button>
          </span>
        )}
      </div>
      {body}
      <div className="pk-f">
        <span>{t("Release")} <kbd>Ctrl</kbd> {t("to close")}</span>
        {ready && <span className="r"><kbd>Ctrl</kbd>+{pref.kind === "text" ? t("click opens it in the editor") : t("click opens it in the viewer")}</span>}
      </div>
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
