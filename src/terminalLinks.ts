// Ctrl+hover shows a file path or URL in negative in the terminal; Ctrl+click opens
// it with the default program (browser, image viewer, editor...). Without
// Ctrl the terminal behaves as before, so selecting text is unaffected.
import type { IDecoration, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { PLACEHOLDER_RE, refOf, type PasteRef } from "./pastes";

/** Terminal colors: a highlighted link is drawn in negative (text color as background). */
export interface LinkColors { fg: string; bg: string }

/** Where the user's text lives, cell by cell: string index → 1-based buffer cell. */
interface LogicalLine {
  text: string;
  cells: Array<{ x: number; y: number }>;
}

interface Hit { start: number; len: number; target: string; paste?: PasteRef }

/** Paste placeholders ("[Pasted text #3 +30 lines]", "[Image #1]"): Ctrl+hover
 *  previews them, Ctrl+click opens them. */
export interface PasteHooks {
  /** Show the preview next to `anchor` (screen rect of the placeholder), or ask to hide it (null). */
  peek(ref: PasteRef | null, anchor?: DOMRect): void;
  open(ref: PasteRef): void;
}

const URL_RE = /\b(?:https?|file):\/\/[^\s"'<>`│]+/gi;
/** Start of an absolute path: C:\ or C:/, \\server\, ~\ or ~/. */
const ABS_RE = /(?<![\w\\/])(?:[A-Za-z]:[\\/]|\\\\[\w.$-]+\\|~[\\/])/g;
/** Where an absolute path surely ends (quotes, markup, box borders). */
const ABS_STOP = /["'<>|*?`\u2500-\u257F]/;
/** A space-free token that may be a relative path. */
const TOKEN_RE = /[^\s"'`()<>[\]{}|\u2500-\u257F]+/g;
const LOOKS_LIKE_PATH = /[\\/]|\.[A-Za-z0-9]{1,8}(?::\d+){0,2}[.,;:!?]*$/;

export function registerTerminalLinks(xterm: Terminal, cwd: string, colors: LinkColors, pastes?: PasteHooks): IDisposable {
  const cache = new Map<string, Promise<Hit[]>>();
  let ctrl = false;
  let hovered: { link: ILink; decorations: IDecoration[] } | null = null;

  function highlight(on: boolean) {
    if (!hovered) return;
    const { link } = hovered;
    if (link.decorations) link.decorations.pointerCursor = on;
    hovered.decorations.forEach((d) => d.dispose());
    hovered.decorations = on ? invertRange(xterm, link, colors) : [];
    const ref = hoveredPaste.get(link);
    if (ref && pastes) pastes.peek(on ? ref : null, on ? rangeRect(xterm, link) : undefined);
  }
  const hoveredPaste = new WeakMap<ILink, PasteRef>();

  const onKey = (e: KeyboardEvent) => {
    const down = e.type === "keydown" ? e.ctrlKey || e.key === "Control" : e.ctrlKey && e.key !== "Control";
    if (down !== ctrl) { ctrl = down; highlight(ctrl); }
  };
  const onBlur = () => { ctrl = false; highlight(false); };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", onBlur);

  const provider = xterm.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = logicalLine(xterm, lineNumber - 1);
      if (!line || !line.text.trim()) return callback(undefined);
      const key = `${cwd}\n${line.text}`;
      let hits = cache.get(key);
      if (!hits) {
        if (cache.size > 200) cache.clear();
        hits = findHits(line.text, cwd, !!pastes);
        cache.set(key, hits);
      }
      hits.then((list) => {
        const links: ILink[] = list.filter((h) => line.cells[h.start + h.len - 1]).map((h) => {
          const link: ILink = {
            text: line.text.slice(h.start, h.start + h.len),
            range: { start: line.cells[h.start], end: line.cells[h.start + h.len - 1] },
            decorations: { underline: false, pointerCursor: false },
            activate(event) {
              if (!event.ctrlKey) return;
              if (h.paste) return pastes?.open(h.paste);
              invoke("link_open", { target: h.target }).catch((err) => console.error("link_open", err));
            },
            hover(event) {
              hovered = { link, decorations: [] };
              ctrl = event.ctrlKey;
              // xterm calls hover() first and only then swaps link.decorations
              // for its live object (reset to our initial values): set the
              // pointer cursor once that has happened.
              queueMicrotask(() => hovered?.link === link && highlight(ctrl));
            },
            leave() {
              if (hovered?.link !== link) return;
              highlight(false);
              hovered = null;
            },
          };
          if (h.paste) hoveredPaste.set(link, h.paste);
          return link;
        });
        callback(links.length ? links : undefined);
      }, () => callback(undefined));
    },
  });

  return {
    dispose() {
      provider.dispose();
      highlight(false);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    },
  };
}

/** The whole line the row belongs to, joining rows the terminal wrapped. */
function logicalLine(xterm: Terminal, row: number): LogicalLine | null {
  const buf = xterm.buffer.active;
  let first = row;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let last = row;
  while (buf.getLine(last + 1)?.isWrapped) last++;
  let text = "";
  const cells: LogicalLine["cells"] = [];
  for (let y = first; y <= last; y++) {
    const line = buf.getLine(y);
    if (!line) return null;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // second half of a wide char
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1 });
      text += chars;
    }
  }
  return { text, cells };
}

/** URLs directly; paths only when the file exists (checked by the backend). */
async function findHits(text: string, cwd: string, withPastes: boolean): Promise<Hit[]> {
  const hits: Hit[] = [];
  const taken = (i: number) => hits.some((h) => i >= h.start && i < h.start + h.len);

  if (withPastes) {
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      hits.push({ start: m.index!, len: m[0].length, target: "", paste: refOf(m) });
    }
  }

  for (const m of text.matchAll(URL_RE)) {
    if (taken(m.index!)) continue;
    let url = m[0].replace(/[.,;:!?'"]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) url = url.slice(0, -1);
    hits.push({ start: m.index!, len: url.length, target: url });
  }

  const starts: number[] = [];
  const candidates: string[] = [];
  for (const m of text.matchAll(ABS_RE)) {
    if (taken(m.index!)) continue;
    const rest = text.slice(m.index!);
    const stop = rest.search(ABS_STOP);
    starts.push(m.index!);
    candidates.push((stop < 0 ? rest : rest.slice(0, stop)).trimEnd());
  }
  // Tokens inside an absolute candidate belong to it (its spaces split them).
  const inAbs = (i: number) => starts.some((s, k) => i >= s && i < s + candidates[k].length);
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (taken(m.index!) || inAbs(m.index!)) continue;
    if (/^[A-Za-z]:|^\\\\|^~[\\/]|:\/\//.test(tok) || !LOOKS_LIKE_PATH.test(tok)) continue;
    starts.push(m.index!);
    candidates.push(tok);
  }
  if (!candidates.length) return hits;

  const found = await invoke<Array<{ len: number; path: string } | null>>("link_resolve", { cwd, candidates });
  found.forEach((f, i) => {
    if (f && !taken(starts[i])) hits.push({ start: starts[i], len: f.len, target: f.path });
  });
  return hits;
}

/** Draw the link in negative, row by row, like a terminal selection. */
function invertRange(xterm: Terminal, link: ILink, colors: LinkColors): IDecoration[] {
  const out: IDecoration[] = [];
  const buf = xterm.buffer.active;
  const { start, end } = link.range;
  for (let y = start.y; y <= end.y; y++) {
    const x0 = y === start.y ? start.x : 1;
    const x1 = y === end.y ? end.x : xterm.cols;
    try {
      const marker = xterm.registerMarker(y - 1 - (buf.baseY + buf.cursorY));
      if (!marker) continue;
      const deco = xterm.registerDecoration({ marker, x: x0 - 1, width: x1 - x0 + 1, backgroundColor: colors.fg, foregroundColor: colors.bg, layer: "top" });
      if (deco) {
        // The overlay sits above the text: let the mouse through, so the
        // terminal keeps the link hovered and shows its pointer cursor.
        deco.onRender((el) => { el.style.pointerEvents = "none"; el.style.cursor = "pointer"; });
        deco.onDispose(() => marker.dispose());
        out.push(deco);
      } else marker.dispose();
    } catch {
      // Decorations are optional: the pointer cursor still marks the link.
    }
  }
  return out;
}

/** Screen rectangle of a link (its first to last row). */
function rangeRect(xterm: Terminal, link: ILink): DOMRect | undefined {
  const screen = xterm.element?.querySelector(".xterm-screen");
  if (!screen) return undefined;
  const r = screen.getBoundingClientRect();
  const cw = r.width / xterm.cols;
  const ch = r.height / xterm.rows;
  const top = xterm.buffer.active.viewportY;
  const { start, end } = link.range;
  const x0 = start.y === end.y ? start.x : 1;
  const x1 = start.y === end.y ? end.x : xterm.cols;
  return new DOMRect(r.left + (x0 - 1) * cw, r.top + (start.y - 1 - top) * ch, (x1 - x0 + 1) * cw, (end.y - start.y + 1) * ch);
}

/** Paste placeholders in the last lines of the terminal (where the prompt is). */
export function placeholdersNearBottom(xterm: Terminal, rows = 300): PasteRef[] {
  const buf = xterm.buffer.active;
  let text = "";
  for (let y = Math.max(0, buf.length - rows); y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    // Keep trailing spaces where the line wraps: they may be inside a placeholder.
    text += (line.isWrapped ? "" : "\n") + line.translateToString(!buf.getLine(y + 1)?.isWrapped);
  }
  return [...text.matchAll(PLACEHOLDER_RE)].map(refOf);
}
