import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { getCwd } from "../cwd.js";
import { icon } from "../icons.js";
import { CodeGraphCache } from "../intelligence/code-graph.js";
import { type GraphOverview, graphOverview, TEST_TONE } from "../intelligence/code-graph-model.js";
import { getThemeTokens, type ThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/**
 * `/graph`: a read-only glance at the code graph in the terminal: the biggest groups as bars and
 * the most depended-on files. The interactive graph is the desktop app's Code graph section.
 */

const caches = new Map<string, CodeGraphCache>();

function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
}

function toneColor(tone: number, tk: ThemeTokens): string {
  if (tone === TEST_TONE) return tk.info;
  return [tk.brand, tk.amber, tk.success][tone] ?? tk.textMuted;
}

/** The popup lines of a graph overview; at most `groups` bars and the overview's key files. */
export function graphOverviewLines(
  overview: GraphOverview,
  tk: ThemeTokens,
  groups = 10,
): InfoPopupLine[] {
  const { stats } = overview;
  const lines: InfoPopupLine[] = [
    {
      type: "text",
      label: `${count(stats.files)} files · ${count(stats.lines)} lines · ${count(stats.links)} import links`,
      color: tk.textSecondary,
    },
    { type: "spacer" },
  ];
  const shown = overview.groups.slice(0, groups);
  if (shown.length > 0) {
    lines.push({ type: "header", label: "Biggest groups" }, { type: "separator" });
    const max = Math.max(1, ...shown.map((g) => g.lines));
    for (const g of shown)
      lines.push({
        type: "bar",
        label: g.label,
        pct: Math.max(2, Math.round((g.lines / max) * 100)),
        desc: `${count(g.files)} files`,
        barColor: toneColor(g.tone, tk),
      });
    if (overview.groups.length > shown.length)
      lines.push({
        type: "text",
        label: `and ${overview.groups.length - shown.length} smaller groups`,
        color: tk.textFaint,
      });
    lines.push({ type: "spacer" });
  }
  if (overview.keyFiles.length > 0) {
    lines.push({ type: "header", label: "Most depended-on files" }, { type: "separator" });
    for (const f of overview.keyFiles)
      lines.push({
        type: "entry",
        label: `★ ${f.path}`,
        desc: `used by ${f.usedBy} · imports ${f.imports}`,
        color: tk.brand,
        descColor: tk.textMuted,
      });
    lines.push({ type: "spacer" });
  }
  lines.push({
    type: "text",
    label: "Open the Code graph section of the desktop app to explore it.",
    color: tk.textFaint,
  });
  return lines;
}

function handleGraph(_input: string, ctx: CommandContext): void {
  const workspace = getCwd();
  let cache = caches.get(workspace);
  if (!cache) {
    cache = new CodeGraphCache(workspace);
    caches.set(workspace, cache);
  }
  const model = cache.get();
  if (!model) {
    sysMsg(
      ctx,
      ctx.contextManager.isRepoMapReady()
        ? "The repository map has no code files to draw."
        : "The code graph is not built yet. BAKED builds it while indexing; try /graph again shortly.",
    );
    return;
  }
  ctx.openInfoPopup({
    title: "Code graph",
    icon: icon("repomap"),
    lines: graphOverviewLines(graphOverview(model), getThemeTokens()),
    width: 96,
    labelWidth: 44,
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/graph", handleGraph);
}
