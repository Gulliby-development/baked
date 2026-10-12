import { useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { KeyChip } from "../ui/KeyCap.js";
import { isCompactTerminal } from "./compact.js";

// Tier 1 always shows, tier 2 on medium widths, tier 3 on wide terminals.
interface ShortcutDef {
  key: string;
  label: string;
  short: string;
  tier: 1 | 2 | 3;
}

export const FOOTER_SHORTCUTS: readonly ShortcutDef[] = [
  { key: "^K", label: "Palette", short: "Palette", tier: 1 },
  { key: "^L", label: "LLM", short: "LLM", tier: 1 },
  { key: "^D", label: "Mode", short: "Mode", tier: 1 },
  { key: "^S", label: "Skills", short: "Skills", tier: 2 },
  { key: "^G", label: "Git", short: "Git", tier: 2 },
  { key: "^N", label: "New Session", short: "New", tier: 3 },
  { key: "^P", label: "Sessions", short: "Sessions", tier: 3 },
  { key: "^T", label: "Tab", short: "Tab", tier: 3 },
  { key: "^C", label: "Quit", short: "Quit", tier: 3 },
];

const GAP = 2;
type LabelMode = "full" | "short" | "none";

function labelFor(s: ShortcutDef, mode: LabelMode): string {
  return mode === "full" ? s.label : mode === "short" ? s.short : "";
}

/** Cells of one shortcut: ` ^K ` chip, its one-cell shadow, then ` Label`. */
function chipWidth(key: string, label: string): number {
  return key.length + 2 + 1 + (label ? 1 + label.length : 0);
}

function rowWidth(items: readonly ShortcutDef[], mode: LabelMode): number {
  const gap = mode === "none" ? 1 : GAP;
  const cells = items.reduce((sum, s) => sum + chipWidth(s.key, labelFor(s, mode)), 0);
  return cells + gap * Math.max(0, items.length - 1) + 2;
}

/** The widest tier and label mode that fit on one line; tier 1 without labels is the floor. */
export function footerLayout(
  columns: number,
  rows: number,
): { items: readonly ShortcutDef[]; mode: LabelMode } {
  if (isCompactTerminal(columns, rows)) {
    return { items: FOOTER_SHORTCUTS.filter((s) => s.key === "^K"), mode: "full" };
  }
  // Labelled chips win over more keys; bare keys are the last resort.
  for (const modes of [["full", "short"], ["none"]] as const) {
    for (const tier of [3, 2, 1] as const) {
      const items = FOOTER_SHORTCUTS.filter((s) => s.tier <= tier);
      for (const mode of modes) if (rowWidth(items, mode) <= columns) return { items, mode };
    }
  }
  return { items: FOOTER_SHORTCUTS.filter((s) => s.tier === 1), mode: "none" };
}

export function Footer() {
  const { width, height } = useTerminalDimensions();
  const { items, mode } = footerLayout(width, height);
  return (
    <box
      flexDirection="row"
      justifyContent="center"
      paddingX={1}
      width="100%"
      gap={mode === "none" ? 1 : GAP}
    >
      {items.map((s) => (
        <text key={s.key} wrapMode="none">
          <KeyChip keyName={s.key} label={labelFor(s, mode)} />
        </text>
      ))}
    </box>
  );
}
