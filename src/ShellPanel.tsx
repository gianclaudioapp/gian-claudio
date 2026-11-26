// The terminal panel next to Claude: plain shells (PowerShell, Git Bash…) in
// the context's working folder, one tab each. Every context keeps its own
// shells running while you look at another one; they close with the app.
import { CSSProperties } from "react";
import { Icon } from "./icons";
import { LaunchSpec, Terminal } from "./Terminal";
import { t } from "./i18n";

export interface ShellTab {
  ptyId: string;
  shellId: string;
  /** Title set by the shell or the running program (e.g. "npm run dev"). */
  title: string | null;
  spec: LaunchSpec;
}

export interface ContextShells {
  tabs: ShellTab[];
  active: string | null;
  /** The panel is shown for this context. */
  open: boolean;
}

export function shellName(id: string): string {
  switch (id) {
    case "pwsh": return "PowerShell 7";
    case "gitbash": return "Git Bash";
    case "cmd": return t("Command Prompt");
    case "wsl": return "WSL";
    default: return "PowerShell";
  }
}

/** A program's title, or the shell's name when the title is just the executable's path. */
function tabLabel(tab: ShellTab): string {
  const title = tab.title?.trim();
  return title && !/[\\/]/.test(title) ? title : shellName(tab.shellId);
}

interface Props {
  /** Shells of every context: all stay mounted so their processes keep running. */
  shells: Record<string, ContextShells>;
  activeCtx: string | null;
  side: "bottom" | "right";
  style: CSSProperties;
  folder: string;
  fontSize: number;
  onAdd: () => void;
  onSelect: (ptyId: string) => void;
  onClose: (ctxId: string, ptyId: string) => void;
  onTitle: (ctxId: string, ptyId: string, title: string) => void;
  onToggleSide: () => void;
  onHide: () => void;
  /** True once for the shell the user just opened or picked: it takes the focus. */
  claimFocus: (ptyId: string) => boolean;
}

export function ShellPanel({ shells, activeCtx, side, style, folder, fontSize, onAdd, onSelect, onClose, onTitle, onToggleSide, onHide, claimFocus }: Props) {
  const mine = activeCtx ? shells[activeCtx] : undefined;
  const shown = !!mine?.open && mine.tabs.length > 0;
  return (
    <div className="shell-panel" style={{ ...style, display: shown ? "flex" : "none" }}>
      <div className="sh-bar" role="tablist">
        {mine?.tabs.map((tab) => (
          <div key={tab.ptyId} role="tab" aria-selected={tab.ptyId === mine.active} className={`sh-tab${tab.ptyId === mine.active ? " on" : ""}`}
            title={tabLabel(tab)} onClick={() => onSelect(tab.ptyId)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(activeCtx!, tab.ptyId); } }}>
            <Icon name="terminal" size={13} />
            <span className="sh-label">{tabLabel(tab)}</span>
            <button className="sh-x" title={t("Close")} onClick={(e) => { e.stopPropagation(); onClose(activeCtx!, tab.ptyId); }}><Icon name="x" size={12} /></button>
          </div>
        ))}
        <button className="sh-btn" title={t("New shell")} onClick={onAdd}><Icon name="plus" size={14} /></button>
        <span className="sh-folder" title={folder}><Icon name="folder" size={13} />{folder.split(/[\\/]/).filter(Boolean).pop()}</span>
        <button className="sh-btn" title={side === "bottom" ? t("Move to the right") : t("Move to the bottom")} onClick={onToggleSide}>
          <Icon name={side === "bottom" ? "panelRight" : "panelBottom"} size={14} />
        </button>
        <button className="sh-btn" title={t("Hide the terminal")} onClick={onHide}><Icon name={side === "bottom" ? "chevronDown" : "chevronRight"} size={14} /></button>
      </div>
      <div className="sh-terms">
        {Object.entries(shells).flatMap(([ctxId, cs]) =>
          cs.tabs.map((tab) => (
            <Terminal key={tab.ptyId} spec={tab.spec} fontSize={fontSize} focusOnShow={() => claimFocus(tab.ptyId)}
              visible={ctxId === activeCtx && cs.open && tab.ptyId === cs.active}
              onActivity={() => {}}
              onTitle={(title) => onTitle(ctxId, tab.ptyId, title)}
              onExit={() => onClose(ctxId, tab.ptyId)} />
          )),
        )}
      </div>
    </div>
  );
}
