// What a "[Pasted text #N +X lines]" or "[Image #N]" placeholder in a chat
// stands for. Pastes already sent are found in Claude Code's own files (by
// the backend); pastes still in the prompt are matched with the copies this
// terminal kept when it pasted them.
import { invoke } from "@tauri-apps/api/core";

export interface PasteRef { kind: "text" | "image"; id: number; /** "+X lines", text only. */ lines: number | null }

export interface Paste {
  kind: "text" | "image";
  text: string | null;
  path: string | null;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

/** The chat a terminal runs, to look pastes up in Claude Code's files. */
export interface ChatFiles { configDir: string | null; cwd: string; sessionId: string }

type Kept = { kind: "text"; text: string; lines: number } | { kind: "image"; path: string };

export const PLACEHOLDER_RE = /\[(?:Pasted text #(\d+)(?: \+(\d+) lines?)?|Image #(\d+))\]/g;

export function refOf(m: RegExpMatchArray): PasteRef {
  return m[3]
    ? { kind: "image", id: Number(m[3]), lines: null }
    : { kind: "text", id: Number(m[1]), lines: m[2] ? Number(m[2]) : null };
}

/** Claude Code's "+X lines" counts the line breaks. */
export function lineCount(text: string): number {
  return (text.replace(/\r\n?/g, "\n").match(/\n/g) ?? []).length;
}

interface Lookup { paste: Paste | null; maxSentId: number }

/** One per terminal: remembers what it pasted, resolves placeholders. */
export class PasteTracker {
  private kept: Kept[] = [];
  private found = new Map<string, Paste>();

  constructor(private chat: ChatFiles | null, private placeholdersOnScreen: () => PasteRef[]) {}

  keepText(text: string) {
    this.kept.push({ kind: "text", text, lines: lineCount(text) });
    if (this.kept.length > 50) this.kept.shift();
  }

  keepImage(path: string) {
    this.kept.push({ kind: "image", path });
    if (this.kept.length > 50) this.kept.shift();
  }

  async resolve(ref: PasteRef): Promise<Paste | null> {
    const key = `${ref.kind}#${ref.id}`;
    const cached = this.found.get(key);
    if (cached) return cached;
    let maxSent = 0;
    if (this.chat) {
      const res = await invoke<Lookup>("paste_lookup", { ...this.chat, kind: ref.kind, id: ref.id }).catch(() => null);
      if (res?.paste && fits(res.paste, ref)) {
        this.found.set(key, res.paste);
        return res.paste;
      }
      maxSent = res?.maxSentId ?? 0;
    }
    if (ref.id <= maxSent) return null; // sent, but its content is gone
    const kept = this.matchUnsent(ref, maxSent);
    if (!kept) return null;
    const paste: Paste | null = kept.kind === "text"
      ? { kind: "text", text: kept.text, path: null, dataUrl: null, width: null, height: null, bytes: new Blob([kept.text]).size }
      : await invoke<Paste>("paste_image_file", { path: kept.path }).catch(() => null);
    // Not cached: until it is sent, the same number could still change hands.
    return paste;
  }

  /**
   * The placeholders still in the prompt (ids above the last sent one) are the
   * latest pastes, in order. Walk both from the newest, skipping kept pastes that
   * don't fit (short texts Claude Code typed in full, or pastes deleted since).
   */
  private matchUnsent(ref: PasteRef, maxSent: number): Kept | null {
    const unsent = [...new Map(this.placeholdersOnScreen().filter((r) => r.id > maxSent).map((r) => [r.id, r])).values()]
      .sort((a, b) => b.id - a.id);
    let k = this.kept.length - 1;
    for (const r of unsent) {
      while (k >= 0 && !keptFits(this.kept[k], r)) k--;
      if (k < 0) return null;
      if (r.id === ref.id) return this.kept[k];
      k--;
    }
    return null;
  }
}

function fits(p: Paste, ref: PasteRef): boolean {
  return p.kind === ref.kind && (ref.lines == null || p.text == null || lineCount(p.text) === ref.lines);
}

function keptFits(k: Kept, ref: PasteRef): boolean {
  return k.kind === ref.kind && (k.kind === "image" || ref.lines == null || k.lines === ref.lines);
}

export function openPaste(p: Paste) {
  if (p.kind === "image" && p.path) return invoke("link_open", { target: p.path });
  if (p.text != null) return invoke("paste_open_text", { text: p.text });
}

export function copyPaste(p: Paste) {
  if (p.kind === "image" && p.path) return invoke("clipboard_write_image", { path: p.path });
  if (p.text != null) return invoke("clipboard_write", { text: p.text });
}
