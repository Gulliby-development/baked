import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  missingReproAdvice,
  outputShows,
  REPRO_TRIES,
  reproAllows,
  reproTool,
  runRepro,
} from "../src/core/verification/repro.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Review } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-repro-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.txt"), "data");
  return root;
}

const finding = (fields: Partial<Review["findings"][number]>): Review["findings"][number] => ({
  id: "F1",
  kind: "correctness",
  severity: "high",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file: null,
  symbol: null,
  evidenceIds: ["E1"],
  claim: "The tag pattern accepts a trailing newline",
  impact: "A tag can hold a line break",
  suggestedFix: "Anchor the pattern to the end of the input",
  ...fields,
});

// Run 5b703388: the reviewer claimed /^[A-Za-z0-9_-]+$/ accepts "tag\n", true in Python but not
// in JavaScript without the m flag.
const regexRepro = {
  executable: "bun",
  args: ["-e", "console.log(/^[A-Za-z0-9_-]+$/.test('tag\\n'))"],
  expected: "false",
  actual: "true",
};

async function run(args: string[], actual = "true", root = workspace()) {
  return runRepro(
    new ProcessScope(),
    { ...regexRepro, args, actual },
    { root, executables: ["bun"], generated: [], signal: new AbortController().signal, sandbox: null },
  );
}

describe("review finding repro", () => {
  test("a false claim about JavaScript regex behavior is refuted", async () => {
    const outcome = await run(regexRepro.args);
    expect(outcome.status).toBe("refuted");
    expect(outcome.reason).toContain("expected value");
  });

  test("a claim the output shows on its own line is reproduced, also from a failing command", async () => {
    expect((await run(["-e", "console.log('checking'); console.log('true')"])).status).toBe(
      "reproduced",
    );
    expect(
      (await run(["-e", "console.log('true'); process.exit(1)"])).status,
    ).toBe("reproduced");
  });

  test("a command that fails without the claimed value is inconclusive", async () => {
    const outcome = await run(["-e", "throw new Error('syntax')"]);
    expect(outcome.status).toBe("inconclusive");
  });

  test("a repro may start only a program the run's checks start", async () => {
    const outcome = await runRepro(new ProcessScope(), { ...regexRepro, executable: "python3" }, {
      root: workspace(),
      executables: ["bun"],
      generated: [],
      signal: new AbortController().signal,
      sandbox: null,
    });
    expect(outcome.status).toBe("inconclusive");
    expect(outcome.reason).toContain("not a program the run's checks start");
  });

  test("a repro that changes source files is inconclusive", async () => {
    const outcome = await run(["-e", "require('node:fs').writeFileSync('source.txt', 'x'); console.log('true')"]);
    expect(outcome.status).toBe("inconclusive");
    expect(outcome.reason).toContain("changed source files");
  });

  test("the output matches whole lines, or a block for a multi-line value", () => {
    expect(outputShows("10\r\n", "1")).toBe(false);
    expect(outputShows("result:\n  1  \n", "1")).toBe(true);
    expect(outputShows("a\nb\nc\n", "b\nc")).toBe(true);
  });

  test("only a reproduced claim, or an exempt one, starts a correction", () => {
    expect(reproAllows(finding({}), "reproduced", true)).toBe(true);
    expect(reproAllows(finding({}), "refuted", true)).toBe(false);
    expect(reproAllows(finding({ severity: "critical" }), "refuted", true)).toBe(false);
    expect(reproAllows(finding({}), "inconclusive", true)).toBe(false);
    expect(reproAllows(finding({ kind: "security" }), "inconclusive", true)).toBe(true);
    expect(reproAllows(finding({}), undefined, true)).toBe(false);
    expect(reproAllows(finding({ severity: "critical" }), undefined, true)).toBe(true);
    expect(reproAllows(finding({ kind: "missing" }), undefined, true)).toBe(true);
    // Without a program a repro could start, findings block as before.
    expect(reproAllows(finding({}), undefined, false)).toBe(true);
  });

  test("the reviewer tool runs a bounded number of repros", async () => {
    let runs = 0;
    const tool = reproTool(["bun"], async () => {
      runs++;
      return { status: "refuted", reason: "", exitCode: 0, output: "false" };
    });
    expect(tool.description).toContain("bun");
    for (let i = 0; i <= REPRO_TRIES; i++) await tool.execute(regexRepro);
    expect(runs).toBe(REPRO_TRIES);
  });
});

describe("a correctness finding without a repro", () => {
  test("is advised once to attach one or say why none can show it", () => {
    const review = (findings: Review["findings"]): Review => ({
      schemaVersion: 1,
      snapshotHash: "0".repeat(64),
      verdict: "changes_requested",
      coverage: [],
      findings,
    });
    expect(missingReproAdvice(review([finding({})]))[0]).toContain("F1 have no repro");
    expect(missingReproAdvice(review([finding({ repro: regexRepro })]))).toEqual([]);
    expect(missingReproAdvice(review([finding({ noRepro: "Only a race shows it" })]))).toEqual([]);
    expect(missingReproAdvice(review([finding({ kind: "missing" })]))).toEqual([]);
  });

  test("reviewers with run_repro get the advice once, then the review is accepted", async () => {
    class AdvisedReviews extends FixtureExecutor {
      checks: string[][][] = [];
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output !== "review" || !request.profile.allowedTools.includes("run_repro"))
          return result;
        const output = result.output as Review;
        output.findings = [finding({ severity: "low", evidenceIds: output.coverage[0]?.evidenceIds ?? [] })];
        if (!output.findings[0]?.evidenceIds.length) output.findings = [];
        output.verdict = "pass";
        this.checks.push([request.validate?.(output) ?? [], request.validate?.(output) ?? []]);
        return result;
      }
    }
    const fixture = workflowFixture({ executor: (root) => new AdvisedReviews(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, new AbortController().signal);
    const checks = fixture.executor.checks;
    expect(checks.length).toBeGreaterThan(0);
    const [first, second] = checks[0] ?? [];
    expect(first?.join("\n")).toContain("have no repro");
    expect(second).toEqual([]);
  });
});
