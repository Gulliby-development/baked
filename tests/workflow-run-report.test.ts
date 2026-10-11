import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PULL_REQUEST_BODY_LIMIT, runReport } from "../src/core/workflows/run-report.js";
import { parseWorkflowArgs, workflowHelp } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { formatWorkflowResult } from "../src/core/commands/workflow.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function completedRun() {
  const fx = workflowFixture();
  cleanups.push(() => fx.dispose());
  const run = await fx.start();
  await fx.service.drive(run.runId, new AbortController().signal);
  await fx.approve(run.runId);
  const done = await fx.service.drive(run.runId, new AbortController().signal);
  if (done.status !== "completed") throw new Error(`Fixture run ended ${done.status}`);
  return { fx, runId: run.runId };
}

describe("run report", () => {
  test("covers what was done, tasks, checks, criteria, findings, decisions, usage and artifacts", async () => {
    const { fx, runId } = await completedRun();
    const report = runReport(fx.service.store, runId);
    expect(report.startsWith("# Fixture\n")).toBe(true);
    expect(report).toContain(`Run \`${runId}\``);
    expect(report).toContain("status **completed**");
    expect(report).toContain("Value exists");
    for (const heading of ["## Summary", "## Changes", "## Tasks", "## Checks", "## Acceptance criteria", "## Findings", "## Decisions", "## Usage", "## Artifacts"])
      expect(report).toContain(heading);
    expect(report).toContain("| `value.txt` | created |");
    expect(report).toContain("| `check` | passed | current |");
    expect(report).toContain("| AC-001 | pass | automated |");
    expect(report).toMatch(/\| \S+ \| approval \| accepted \| user \|/);
    const usage = fx.service.store.run(runId).token_usage;
    expect(report).toContain(`${usage.toLocaleString("en-US")} tokens`);
    expect(report).toContain("| Stage | Attempts | Tokens |");
    expect(report).toContain("| Model | Attempts | Tokens |");
    expect(report).toContain(`baked workflow artifacts ${runId} --file ID`);
    // Same run, same text: delivery digests the body.
    expect(runReport(fx.service.store, runId)).toBe(report);
  }, 60000);

  test("shortens long lists, then cuts, to fit a length and keeps the appendix whole", async () => {
    const { fx, runId } = await completedRun();
    const full = runReport(fx.service.store, runId);
    const appendix = "## Delivery\n\n- add `value.txt`";
    const short = runReport(fx.service.store, runId, { maxChars: 1200, appendix });
    expect(short.length).toBeLessThanOrEqual(1200);
    expect(short.length).toBeLessThan(full.length + appendix.length);
    expect(short.trimEnd().endsWith(appendix)).toBe(true);
    expect(PULL_REQUEST_BODY_LIMIT).toBeLessThan(65536);
  }, 60000);

  test("CLI prints the report or writes it to a file; the TUI shows its Markdown", async () => {
    const { fx, runId } = await completedRun();
    const signal = new AbortController().signal;
    expect(workflowHelp).toContain("report RUN_ID [--output FILE]");
    expect(() => parseWorkflowArgs(["report"])).toThrow("positional");
    expect(() => parseWorkflowArgs(["report", runId, "--top", "3"])).toThrow("not valid");
    const printed = (await executeWorkflowCommand(fx.service, parseWorkflowArgs(["report", runId]), signal)) as { runId: string; markdown: string };
    expect(printed.markdown).toBe(runReport(fx.service.store, runId));
    expect(formatWorkflowResult(printed)).toBe(printed.markdown);
    const written = (await executeWorkflowCommand(fx.service, parseWorkflowArgs(["report", runId, "--output", "out/report.md"]), signal)) as { path: string; bytes: number };
    expect(written.path).toBe(join(fx.root, "out", "report.md"));
    expect(readFileSync(written.path, "utf8")).toBe(printed.markdown);
    expect(formatWorkflowResult(written)).toBe(`Run report written to ${written.path}.`);
    await expect(executeWorkflowCommand(fx.service, parseWorkflowArgs(["report", "missing-run"]), signal)).rejects.toThrow();
  }, 60000);
});
