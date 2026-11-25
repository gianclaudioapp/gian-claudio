import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "./ui";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";

export interface LaunchSpec {
  /** PTY session id (one per running chat). */
  ptyId: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** Run this argv instead of `claude` (e.g. the installer). */
  program?: string[];
  /** API-key account: Rust injects its key from Credential Manager. */
  apiKeyAccount?: string | null;
}

interface Props {
  spec: LaunchSpec;
  visible: boolean;
  onActivity: () => void;
  onExit: (code: number | null) => void;
  /** Terminal title set by the program (Claude Code puts the topic there). */
  onTitle?: (title: string) => void;
  /** Font size in px (from the text-size setting). */
  fontSize: number;
}

/** The terminal is always dark, whatever the app theme (matches --term-bg). */
const BG = "#1D1D21";
const FG = "#E6E6E3";
const theme = {
  background: BG,
  foreground: FG,
  cursor: FG,
  cursorAccent: BG,
  selectionBackground: "#34497A",
  black: "#1B1B1E",
  brightBlack: "#7A7A80",
  red: "#F07A7A",
  brightRed: "#FF9B9B",
  green: "#4CC38A",
  brightGreen: "#6EDBA4",
  yellow: "#E5B567",
  brightYellow: "#F2CD86",
  blue: "#6B9BFF",
  brightBlue: "#8DB2FF",
  magenta: "#B49BFF",
  brightMagenta: "#CBB8FF",
  cyan: "#4FC1C9",
  brightCyan: "#79D6DC",
  white: "#D4D4D0",
  brightWhite: "#FFFFFF",
};

/** "#1D1D21" → "rgb:1d1d/1d1d/2121", the X11 form used in OSC color replies. */
function xColor(hex: string): string {
  const h = hex.slice(1).toLowerCase();
  return `rgb:${h.slice(0, 2).repeat(2)}/${h.slice(2, 4).repeat(2)}/${h.slice(4, 6).repeat(2)}`;
}

/** One xterm.js view bound to one `claude` process in a pseudo-terminal. */
export function Terminal({ spec, visible, onActivity, onExit, onTitle, fontSize }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const term = useRef<XTerm | null>(null);
  // Latest callbacks without re-running the spawn effect.
  const cb = useRef({ onActivity, onExit, onTitle });
  cb.current = { onActivity, onExit, onTitle };
  const actions = useRef<{ copy: () => void; paste: () => void; selectAll: () => void; hasSelection: () => boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; canCopy: boolean } | null>(null);

  useEffect(() => {
    const xterm = new XTerm({
      fontFamily: '"Geist Mono", Consolas, monospace',
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      theme,
      allowProposedApi: true,
      scrollback: 10000,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(host.current!);
    fitAddon.fit();
    term.current = xterm;
    fit.current = fitAddon;

    const { ptyId } = spec;
    const write = (data: string) => invoke("pty_write", { id: ptyId, data }).catch(() => {});
    let disposed = false;
    const unlisten: Array<() => void> = [];

    // Programs ask the terminal for its colors (OSC 10/11) to pick a light or
    // dark palette — Claude Code's "auto" theme does. xterm.js doesn't answer
    // on its own, so reply with ours.
    const osc = [10, 11].map((code) =>
      xterm.parser.registerOscHandler(code, (data) => {
        if (data !== "?") return false;
        write(`\x1b]${code};${xColor(code === 10 ? FG : BG)}\x1b\\`);
        return true;
      }),
    );
    const title = xterm.onTitleChange((s) => cb.current.onTitle?.(s));

    // Copy / paste like Windows Terminal: Ctrl+C copies when text is selected
    // (otherwise it still interrupts Claude), Ctrl+V pastes, and so do the
    // Ctrl+Shift and Insert variants.
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const key = ev.key.toLowerCase();
      const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
      if ((ctrl && key === "c" && (ev.shiftKey || xterm.hasSelection())) || (ctrl && key === "insert")) {
        ev.preventDefault();
        copySelection(xterm);
        return false;
      }
      if ((ctrl && key === "v") || (ev.shiftKey && !ev.ctrlKey && key === "insert")) {
        ev.preventDefault(); // no second paste from the browser's own paste event
        pasteInto(xterm);
        return false;
      }
      return true;
    });
    actions.current = { copy: () => copySelection(xterm), paste: () => pasteInto(xterm), selectAll: () => xterm.selectAll(), hasSelection: () => xterm.hasSelection() };

    (async () => {
      unlisten.push(
        await listen<{ id: string; data: string }>("pty-output", (e) => {
          if (e.payload.id !== ptyId) return;
          xterm.write(e.payload.data);
          cb.current.onActivity();
        }),
        await listen<{ id: string; code: number | null }>("pty-exit", (e) => {
          if (e.payload.id !== ptyId) return;
          xterm.write(`\r\n\x1b[90m${t("[session ended]")}\x1b[0m\r\n`);
          cb.current.onExit(e.payload.code);
        }),
      );
      if (disposed) return;
      try {
        await invoke("pty_spawn", {
          req: {
            id: ptyId, cwd: spec.cwd, args: spec.args, env: spec.env,
            program: spec.program ?? null, apiKeyAccount: spec.apiKeyAccount ?? null,
            cols: xterm.cols, rows: xterm.rows,
          },
        });
      } catch (err) {
        xterm.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
      }
    })();

    const input = xterm.onData(write);
    const resize = xterm.onResize(({ cols, rows }) => invoke("pty_resize", { id: ptyId, cols, rows }).catch(() => {}));
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) fitAddon.fit();
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      ro.disconnect();
      input.dispose();
      resize.dispose();
      title.dispose();
      osc.forEach((d) => d.dispose());
      unlisten.forEach((u) => u());
      invoke("pty_kill", { id: ptyId }).catch(() => {});
      invoke("status_forget", { ptyId }).catch(() => {});
      xterm.dispose();
    };
    // A new ptyId means a new chat: remount the whole terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.ptyId]);

  // Text size changes apply live; refit so rows/columns follow (the PTY is resized too).
  useEffect(() => {
    const xterm = term.current;
    if (!xterm || xterm.options.fontSize === fontSize) return;
    xterm.options.fontSize = fontSize;
    if (host.current?.offsetParent) fit.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        term.current?.focus();
      });
    }
  }, [visible]);

  return (
    <>
      <div className="term-host" ref={host} style={{ display: visible ? "block" : "none" }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, canCopy: !!actions.current?.hasSelection() });
        }} />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => { setMenu(null); term.current?.focus(); }} items={[
          { label: t("Copy"), icon: "copy", disabled: !menu.canCopy, onClick: () => actions.current?.copy() },
          { label: t("Paste"), icon: "paste", onClick: () => actions.current?.paste() },
          { label: t("Select all"), icon: "selectAll", onClick: () => actions.current?.selectAll() },
        ]} />
      )}
    </>
  );
}

function copySelection(xterm: XTerm) {
  const text = xterm.getSelection();
  if (!text) return;
  invoke("clipboard_write", { text }).catch(() => navigator.clipboard?.writeText(text).catch(() => {}));
  xterm.clearSelection();
}

/** Text is pasted as typed text (bracketed when the program asks for it);
 *  an image on the clipboard is saved as a PNG and its path is inserted. */
async function pasteInto(xterm: XTerm) {
  try {
    const p = await invoke<{ text: string | null; imagePath: string | null }>("clipboard_read");
    // As a real paste, so Claude Code sees an image path being pasted and attaches it.
    if (p.imagePath) xterm.paste(`"${p.imagePath}" `);
    else if (p.text) xterm.paste(p.text);
  } catch {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (text) xterm.paste(text);
  }
  xterm.focus();
}
