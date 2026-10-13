import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatWorkflowResult } from "../src/core/commands/workflow.js";
import { comparisonMarkdown, compareRuns } from "../src/core/workflows/compare.js";
import { parseWorkflowArgs, workflowHelp } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("run comparison (A/B routing)", () => {
  test("puts two runs of a feature side by side and prints or writes the Markdown", async () => {
    const fx = workflowFixture();
    cleanups.push(() => fx.dispose());
    const signal = new AbortController().signal;
    const finished = async () => {
      const run = await fx.start();
      await fx.service.drive(run.runId, signal);
      await fx.approve(run.runId);
      const done = await fx.service.drive(run.runId, signal);
      if (done.status !== "completed") throw new Error(`Fixture run ended ${done.status}`);
      return run.runId;
    };
    const a = await finished();
    const waiting = await fx.start();
    await fx.service.drive(waiting.runId, signal);

    const c = compareRuns(fx.service.store, a, waiting.runId);
    expect(c.sameFeature).toBe(true);
    expect(c.a).toMatchObject({ runId: a, status: "completed", checks: { passed: 1, failed: 0 } });
    const second = fx.service.store.snapshot(waiting.runId);
    expect(c.b).toMatchObject({ status: second.status, reason: second.reason });
    expect(c.a.tokens).toBe(fx.service.store.run(a).token_usage);
    expect(c.delta.tokens).toBe(c.b.tokens - c.a.tokens);
    expect(c.stages.length).toBeGreaterThan(0);
    expect(c.routeDifferences).toEqual([]);

    const markdown = comparisonMarkdown(c);
    expect(markdown).toContain(`# Run comparison: ${a} (A) and ${waiting.runId} (B)`);
    expect(markdown).toContain("Both runs used the same models.");
    expect(markdown).toContain(`| Status | completed | ${second.status}`);
    expect(markdown).toContain("## Tokens by stage");

    expect(workflowHelp).toContain("compare RUN_A RUN_B");
    expect(() => parseWorkflowArgs(["compare", a])).toThrow("2 positional");
    const printed = (await executeWorkflowCommand(fx.service, parseWorkflowArgs(["compare", a, waiting.runId]), signal)) as { markdown: string };
    expect(printed.markdown).toBe(markdown);
    expect(formatWorkflowResult(printed)).toBe(markdown);
    const written = (await executeWorkflowCommand(fx.service, parseWorkflowArgs(["compare", a, waiting.runId, "--output", "ab.md"]), signal)) as { path: string };
    expect(readFileSync(join(fx.root, "ab.md"), "utf8")).toBe(markdown);
    expect(written.path).toBe(join(fx.root, "ab.md"));
    await expect(executeWorkflowCommand(fx.service, parseWorkflowArgs(["compare", a, "missing-run"]), signal)).rejects.toThrow();
  }, 90000);
});
