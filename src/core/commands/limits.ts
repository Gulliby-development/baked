import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { icon } from "../icons.js";
import { readUsageLimits, resetsIn } from "../llm/usage-limits.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";

/** `/limits`: how much of each subscription's usage limit is left (#2300). */
async function handleLimits(_input: string, ctx: CommandContext): Promise<void> {
  const theme = getThemeTokens();
  ctx.openInfoPopup({
    title: "Subscription limits",
    icon: icon("gauge"),
    lines: [{ type: "text", label: "Reading limits...", color: theme.textSecondary }],
  });
  const limits = await readUsageLimits();
  const now = new Date();
  const lines: InfoPopupLine[] = [];
  for (const p of limits) {
    if (lines.length) lines.push({ type: "spacer" });
    lines.push({ type: "header", label: p.plan ? `${p.name} (${p.plan})` : p.name });
    for (const w of p.windows) {
      const left = w.usedPercent === null ? null : Math.max(0, 100 - w.usedPercent);
      const color =
        w.status === "limited"
          ? theme.error
          : w.status === "warning"
            ? theme.warning
            : theme.success;
      if (left !== null && !w.unlimited)
        lines.push({ type: "bar", label: w.label, pct: left, barColor: color });
      const reset = resetsIn(w.resetsAt, now);
      lines.push({
        type: "entry",
        label: left === null && !w.unlimited ? w.label : "",
        desc: w.unlimited
          ? "unlimited"
          : [
              left === null ? "unknown" : `${String(Math.round(left))}% left`,
              w.remaining != null && w.entitlement != null
                ? `${String(w.remaining)}/${String(w.entitlement)}`
                : null,
              reset && `resets ${reset}`,
              w.detail,
            ]
              .filter(Boolean)
              .join(" · "),
        descColor: w.unlimited ? theme.success : color,
      });
    }
    if (p.credits)
      lines.push({
        type: "entry",
        label: "Credits",
        desc: p.credits.unlimited ? "unlimited" : (p.credits.balance ?? "available"),
      });
    const seen =
      p.source === "last-seen" && p.observedAt
        ? ` (as of ${new Date(p.observedAt).toLocaleString()})`
        : "";
    lines.push({
      type: "text",
      label: `${p.message}${seen}`,
      color: p.state === "error" ? theme.warning : theme.textMuted,
    });
  }
  ctx.openInfoPopup({ title: "Subscription limits", icon: icon("gauge"), lines, labelWidth: 26 });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/limits", handleLimits);
}
