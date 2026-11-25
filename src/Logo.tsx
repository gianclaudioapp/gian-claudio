// The GianClaudio emblem, rendered inline from the single source SVG so its
// color follows the accent chosen in Settings.
import source from "../assets/gianclaudio-logo.svg?raw";

const d = /\sd="([^"]+)"/.exec(source)?.[1] ?? "";
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1] ?? "0 0 1147 697";
const [, , vbW, vbH] = viewBox.split(/\s+/).map(Number);
/** Drawn slightly taller than the source (the emblem reads squat when small). */
const STRETCH_Y = 1.12;
const ratio = vbW / vbH / STRETCH_Y;

export function Logo({ height = 20, color = "var(--accent)" }: { height?: number; color?: string }) {
  // Explicit width + flex: none, or a flex parent squeezes it.
  return (
    <svg viewBox={viewBox} width={Math.round(height * ratio)} height={height} role="img" aria-label="GianClaudio"
      preserveAspectRatio="none" style={{ display: "block", flex: "none" }}>
      <path d={d} fill={color} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
