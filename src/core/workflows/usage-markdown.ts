/**
 * Usage as a Markdown document to share: the project summary of `GET /v1/usage` and the usage of
 * one run. Only model IDs, stage IDs, run IDs and figures go in; no paths, prompts or accounts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type RunUsageReport,
  toolBackendLine,
  type UsageDimension,
  type UsageSummary,
} from "./usage.js";

const PRICE_NOTE =
  "Costs are estimates from BAKED's price table: uncached input, cache reads, cache writes and " +
  "output at each model's list price. Tokens of attempts without per-step usage or a known " +
  "price are counted as unpriced and left out of the cost. Host attempts (checks, publication) " +
  "run without a model and cost nothing.";

/** A Markdown table cell: one line, pipes escaped. */
function cell(value: string): string {
  return (
    value
      .replace(/\r?\n+/g, " ")
      .replaceAll("|", "\\|")
      .trim() || "-"
  );
}
const count = (n: number): string => n.toLocaleString("en-US");
const usd = (n: number): string => `$${n.toFixed(2)}`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const plural = (n: number, word: string): string => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const LABELS: Record<UsageDimension, string> = { model: "Model", stage: "Stage", day: "Day" };

function table(head: string[], rows: string[][], numeric: number): string[] {
  const align = head.map((_, i) => (i >= head.length - numeric ? "---:" : "---"));
  return [
    `| ${head.join(" | ")} |`,
    `| ${align.join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

function cost(usdValue: number, unpriced: number): string {
  return unpriced > 0 ? `${usd(usdValue)} + ${count(unpriced)} unpriced tokens` : usd(usdValue);
}

/** The project usage summary as Markdown: window, filters, totals and the grouped table. */
export function usageMarkdown(summary: UsageSummary, now: number = Date.now()): string {
  const filters = [
    ...(summary.filters.model !== undefined ? [`model \`${summary.filters.model}\``] : []),
    ...(summary.filters.stage !== undefined ? [`stage \`${summary.filters.stage}\``] : []),
  ];
  const out = [
    "# BAKED usage",
    "",
    `- Window: last ${plural(summary.days, "day")}, ${day(summary.since)} to ${day(now)} (UTC)`,
    `- Grouped by: ${summary.groupBy.join(", ")}`,
    `- Filters: ${filters.length ? filters.join(", ") : "none"}`,
    "",
    "## Totals",
    "",
    ...table(
      ["Figure", "Value"],
      [
        ["Runs", count(summary.runs)],
        ["Attempts", count(summary.attempts)],
        ["Tokens", count(summary.tokens)],
        ["Input tokens (cache reads included)", count(summary.inputTokens)],
        ["Output tokens", count(summary.outputTokens)],
        ["Cache reads", count(summary.cacheReadTokens)],
        ["Cache writes", count(summary.cacheWriteTokens)],
        ["Estimated cost (USD)", usd(summary.costUsd)],
        ["Unpriced tokens", count(summary.unpricedTokens)],
      ],
      1,
    ),
    "",
    `## By ${summary.groupBy.join(" and ")}`,
    "",
  ];
  if (summary.groups.length === 0) out.push("No workflow attempts in this window.");
  else
    out.push(
      ...table(
        [
          ...summary.groupBy.map((d) => LABELS[d]),
          "Runs",
          "Attempts",
          "Tokens",
          "Input",
          "Output",
          "Cache reads",
          "Cache writes",
          "USD (estimate)",
          "Unpriced tokens",
        ],
        summary.groups.map((g) => [
          ...summary.groupBy.map((d) => g.keys[d] ?? ""),
          count(g.runs),
          count(g.attempts),
          count(g.tokens),
          count(g.inputTokens),
          count(g.outputTokens),
          count(g.cacheReadTokens),
          count(g.cacheWriteTokens),
          usd(g.costUsd),
          count(g.unpricedTokens),
        ]),
        9,
      ),
    );
  out.push("", `Estimated cost: ${cost(summary.costUsd, summary.unpricedTokens)}.`, "", PRICE_NOTE);
  return `${out.join("\n")}\n`;
}

/** The usage of one run as Markdown: totals, then tokens and cost by stage and by model. */
export function runUsageMarkdown(report: RunUsageReport): string {
  const backends = toolBackendLine(report.toolBackends ?? []);
  interface Row {
    attempts: number;
    tokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    unpriced: number;
  }
  const empty = (): Row => ({
    attempts: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    unpriced: 0,
  });
  const add = (row: Row, attempt: RunUsageReport["attempts"][number]): void => {
    row.attempts++;
    row.tokens += attempt.usedTokens ?? 0;
    row.input += attempt.inputTokens ?? 0;
    row.output += attempt.outputTokens ?? 0;
    row.cacheRead += attempt.cacheReadTokens ?? 0;
    row.cacheWrite += attempt.cacheWriteTokens ?? 0;
    if (attempt.costUsd === null) row.unpriced += attempt.usedTokens ?? 0;
    else row.costUsd += attempt.costUsd;
  };
  const total = empty();
  const byStage = new Map<string, Row>();
  const byModel = new Map<string, Row>();
  for (const attempt of report.attempts) {
    add(total, attempt);
    for (const [map, key] of [
      [byStage, attempt.stage],
      [byModel, attempt.model ?? "(host)"],
    ] as const) {
      const row = map.get(key) ?? empty();
      add(row, attempt);
      map.set(key, row);
    }
  }
  const head = [
    "Attempts",
    "Tokens",
    "Input",
    "Output",
    "Cache reads",
    "Cache writes",
    "USD (estimate)",
    "Unpriced tokens",
  ];
  const figures = (row: Row): string[] => [
    count(row.attempts),
    count(row.tokens),
    count(row.input),
    count(row.output),
    count(row.cacheRead),
    count(row.cacheWrite),
    usd(row.costUsd),
    count(row.unpriced),
  ];
  const section = (title: string, label: string, rows: Map<string, Row>, sort: boolean) => {
    const entries = [...rows];
    if (sort) entries.sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]));
    return [
      `## ${title}`,
      "",
      ...table(
        [label, ...head],
        entries.map(([key, row]) => [key, ...figures(row)]),
        head.length,
      ),
      "",
    ];
  };
  const out = [
    `# BAKED usage of run ${report.runId}`,
    "",
    `- Attempts: ${count(total.attempts)}`,
    `- Tokens: ${count(total.tokens)} (input ${count(total.input)}, output ${count(total.output)}, cache reads ${count(total.cacheRead)}, cache writes ${count(total.cacheWrite)})`,
    `- Estimated cost: ${cost(total.costUsd, total.unpriced)}`,
    ...(backends ? [`- Code intelligence: ${backends}`] : []),
    "",
  ];
  if (report.attempts.length === 0) out.push("No attempts match.", "");
  else
    out.push(
      ...section("By stage", "Stage", byStage, false),
      ...section("By model", "Model", byModel, true),
    );
  out.push(PRICE_NOTE);
  return `${out.join("\n")}\n`;
}

/** The default file name of an exported project summary: `baked-usage-30d-2026-10-12.md`. */
export function usageFileName(days: number, now: number = Date.now()): string {
  return `baked-usage-${days}d-${day(now)}.md`;
}

/** Writes the Markdown of a summary to `output`, relative to `workspace`; returns the full path. */
export function writeUsageMarkdown(
  workspace: string,
  output: string,
  summary: UsageSummary,
): string {
  const path = resolve(workspace, output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, usageMarkdown(summary));
  return path;
}
