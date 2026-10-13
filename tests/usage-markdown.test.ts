import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwd, setCwd } from "../src/core/cwd.js";
import type { RunUsageReport, UsageSummary } from "../src/core/workflows/usage.js";
import { runUsageMarkdown, usageMarkdown } from "../src/core/workflows/usage-markdown.js";
import { parseUsageArgs, runUsageCli } from "../src/headless/overview.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const figures = {
  attempts: 3,
  tokens: 1_500,
  inputTokens: 1_200,
  outputTokens: 200,
  cacheReadTokens: 400,
  cacheWriteTokens: 50,
  costUsd: 0.123,
  unpricedTokens: 100,
};

const summary: UsageSummary = {
  ...figures,
  days: 7,
  since: Date.UTC(2026, 9, 5),
  groupBy: ["stage", "model"],
  filters: { model: "anthropic/claude-sonnet-4-6" },
  runs: 2,
  totalTokens: 1_500,
  groups: [
    {
      ...figures,
      key: "plan / anthropic/claude-sonnet-4-6",
      keys: { stage: "plan", model: "anthropic/claude-sonnet-4-6" },
      runs: 2,
    },
  ],
};

describe("usage Markdown", () => {
  test("renders the window, filters, totals, groups and the price note", () => {
    const md = usageMarkdown(summary, Date.UTC(2026, 9, 12));
    expect(md).toContain("# BAKED usage");
    expect(md).toContain("- Window: last 7 days, 2026-10-05 to 2026-10-12 (UTC)");
    expect(md).toContain("- Filters: model `anthropic/claude-sonnet-4-6`");
    expect(md).toContain("| Estimated cost (USD) | $0.12 |");
    expect(md).toContain("| Unpriced tokens | 100 |");
    expect(md).toContain("| Stage | Model | Runs | Attempts | Tokens |");
    expect(md).toContain("| plan | anthropic/claude-sonnet-4-6 | 2 | 3 | 1,500 | 1,200 | 200 | 400 | 50 | $0.12 | 100 |");
    expect(md).toContain("Estimated cost: $0.12 + 100 unpriced tokens.");
    expect(md).toContain("price table");
  });

  test("says when the window has no attempts and escapes pipes in keys", () => {
    expect(usageMarkdown({ ...summary, groups: [] })).toContain("No workflow attempts in this window.");
    const piped = usageMarkdown({
      ...summary,
      groupBy: ["model"],
      groups: [{ ...figures, key: "a|b", keys: { model: "a|b" }, runs: 1 }],
    });
    expect(piped).toContain("| a\\|b |");
  });

  test("renders one run by stage and by model", () => {
    const row = (attemptId: string, stage: string, model: string | null, tokens: number, cost: number | null) => ({
      attemptId,
      stage,
      model,
      status: "succeeded",
      usedTokens: tokens,
      steps: 1,
      peakInputTokens: tokens,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: cost,
      compactedBytes: 0,
      stopReason: null,
      finalizedBy: null,
    });
    const report = {
      runId: "run-1",
      totalTokens: 0,
      totals: { tokens: null, steps: null, cacheReadTokens: null, cacheWriteTokens: null, compactedBytes: null },
      stages: [],
      models: [],
      attempts: [row("a", "plan", "m1", 1_000, 0.5), row("b", "plan", null, 10, 0), row("c", "review", "m2", 300, null)],
    } as RunUsageReport;
    const md = runUsageMarkdown(report);
    expect(md).toContain("# BAKED usage of run run-1");
    expect(md).toContain("- Estimated cost: $0.50 + 300 unpriced tokens");
    expect(md).toContain("| plan | 2 | 1,010 |");
    expect(md).toContain("| (host) | 1 | 10 |");
    expect(md.indexOf("| m1 |")).toBeLessThan(md.indexOf("| m2 |"));
    expect(md).not.toContain("## By tool");
    const withTools = runUsageMarkdown({
      ...report,
      tools: [
        { tool: "run_repro", calls: 3, tokens: 12_000 },
        { tool: "read", calls: 1, tokens: 900 },
      ],
    });
    expect(withTools).toContain("## By tool");
    expect(withTools).toContain("| run_repro | 3 | 12,000 |");
    expect(withTools.indexOf("| run_repro |")).toBeLessThan(withTools.indexOf("| read |"));
  });
});

describe("usage export options", () => {
  test("baked usage takes --format md and --output, not with --json", () => {
    expect(parseUsageArgs(["--format", "md"])).toMatchObject({ markdown: true });
    expect(parseUsageArgs(["--output", "u.md"])).toMatchObject({ markdown: true, output: "u.md" });
    expect(parseUsageArgs(["--format", "html"])).toBe("--format takes md");
    expect(parseUsageArgs(["--json", "--format", "md"])).toBe("--json excludes --format and --output");
  });

  test("baked workflow usage takes --format md; --output implies it", () => {
    expect(parseWorkflowArgs(["usage", "r1", "--format", "md"]).flags.format).toBe("md");
    expect(parseWorkflowArgs(["usage", "r1", "--output", "u.md"]).flags.format).toBe("md");
    expect(() => parseWorkflowArgs(["usage", "r1", "--format", "csv"])).toThrow("--format takes md");
    expect(() => parseWorkflowArgs(["status", "r1", "--format", "md"])).toThrow();
  });

  test("baked usage writes Markdown to a file in a project without runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-usage-md-"));
    cleanups.push(() => removeTempDir(dir));
    const previous = getCwd();
    setCwd(dir, { changeProcess: false });
    const write = process.stdout.write.bind(process.stdout);
    const out: string[] = [];
    process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
    try {
      expect(await runUsageCli(["--days", "3", "--output", "reports/usage.md"])).toBe(0);
      expect(await runUsageCli(["--format", "md"])).toBe(0);
    } finally {
      process.stdout.write = write;
      setCwd(previous, { changeProcess: false });
    }
    const file = join(dir, "reports/usage.md");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("last 3 days");
    expect(text).toContain("No workflow attempts in this window.");
    expect(text).not.toContain(dir);
    expect(out.join("")).toContain("# BAKED usage");
  });
});
