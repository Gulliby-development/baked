import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimsNoReproTool,
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
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

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
  const review = (findings: Review["findings"]): Review => ({
    schemaVersion: 1,
    snapshotHash: "0".repeat(64),
    verdict: "changes_requested",
    coverage: [],
    findings,
  });
  test("is advised once to attach one or say why none can show it", () => {
    expect(missingReproAdvice(review([finding({})]))[0]).toContain("F1 have no repro");
    expect(missingReproAdvice(review([finding({ repro: regexRepro })]))).toEqual([]);
    expect(missingReproAdvice(review([finding({ noRepro: "Only a race shows it" })]))).toEqual([]);
    expect(missingReproAdvice(review([finding({ kind: "missing" })]))).toEqual([]);
  });

  test("turns back a noRepro that says no tool was available while run_repro is offered (#528)", () => {
    const noTool = finding({ noRepro: "No execution/reproduction tool is available in this session" });
    expect(missingReproAdvice(review([noTool]), ["python"])[0]).toContain("offers run_repro, which starts python");
    expect(missingReproAdvice(review([noTool]))).toEqual([]);
    expect(missingReproAdvice(review([noTool]), [])).toEqual([]);
    expect(
      missingReproAdvice(review([finding({ noRepro: "Needs a set-up the runner cannot make" })]), ["java"]),
    ).toEqual([]);
    for (const reason of [
      "no execution tool was available",
      "No workspace reproduction tool is available in this review",
      "The run_repro tool was not offered",
    ])
      expect(claimsNoReproTool(reason)).toBe(true);
    for (const reason of ["Only a race shows it", "The runner cannot select a culture", "Needs an unreadable directory"])
      expect(claimsNoReproTool(reason)).toBe(false);
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

  // Round 11 (#528): reviewers with run_repro offered gave "no execution tool" as noRepro.
  test("a reviewer that says no tool was available is told run_repro is offered", async () => {
    class NoToolReviews extends FixtureExecutor {
      checks: string[][][] = [];
      tools: unknown[] = [];
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output !== "review" || !request.profile.allowedTools.includes("run_repro"))
          return result;
        const extra = (JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { reproTool?: unknown } }).extra;
        this.tools.push(extra.reproTool);
        const output = result.output as Review;
        output.findings = [
          finding({
            severity: "low",
            evidenceIds: output.coverage[0]?.evidenceIds ?? [],
            noRepro: "No execution/reproduction tool is available in this session",
          }),
        ];
        if (!output.findings[0]?.evidenceIds.length) output.findings = [];
        output.verdict = "pass";
        this.checks.push([request.validate?.(output) ?? [], request.validate?.(output) ?? []]);
        return result;
      }
    }
    const fixture = workflowFixture({ executor: (root) => new NoToolReviews(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, new AbortController().signal);
    const executable = fixturePolicy.checks[0]?.executable;
    expect(fixture.executor.tools[0]).toEqual({ name: "run_repro", programs: [executable] });
    const [first, second] = fixture.executor.checks[0] ?? [];
    expect(first?.join("\n")).toContain(`offers run_repro, which starts ${String(executable)}`);
    expect(second).toEqual([]);
  });
});

// linehunk f0b66451 (#528): one finding came back in four review rounds with the same noRepro.
test("a repeated finding keeps the earlier noRepro and is not asked again", async () => {
  const checks = fixturePolicy.checks.map((c) => ({
    ...c,
    args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"],
  }));
  const fixture = workflowFixture({ policy: { ...fixturePolicy, checks } });
  cleanups.push(fixture.dispose);
  const { executor, service } = fixture;
  const advice: string[][] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "refutation") {
      const extra = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}").extra;
      return {
        output: { schemaVersion: 1, findingId: extra.finding.id, decision: "confirmed", evidenceIds: extra.evidence.map((e: { id: string }) => e.id), explanation: "Holds" },
        inputTokens: 20,
        outputTokens: 30,
      };
    }
    const result = await original(request);
    if (request.task?.id === "T002") writeFileSync(join(fixture.root, "value.txt"), "ready\n");
    if (request.profile.output !== "review") return result;
    const extra = (JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      extra: { dimension: string; evidence: { id: string }[]; previousRound?: unknown };
    }).extra;
    if (extra.dimension !== "correctness") return result;
    const evidenceIds = extra.evidence.map((e) => e.id);
    const output = result.output as Review;
    const traversal = { severity: "low", evidenceIds, file: "value.txt", claim: "A traversal IO failure is swallowed" } as const;
    if (!extra.previousRound) {
      output.verdict = "changes_requested";
      output.findings = [
        finding({ id: "M1", kind: "missing", file: "value.txt", evidenceIds, claim: "The value lacks a newline" }),
        finding({ ...traversal, id: "C1", noRepro: "Needs an unreadable directory" }),
      ];
    } else {
      output.verdict = "pass";
      output.findings = [finding({ ...traversal, id: "C2", repeatOf: "C1" })];
    }
    advice.push(request.validate?.(output) ?? []);
    return result;
  };
  const run = await fixture.start();
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const final = await service.drive(run.runId, new AbortController().signal);
  expect(final.status).toBe("completed");
  expect(advice).toEqual([[], []]);
  const repeated = service.store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith("reviews/"))
    .flatMap((a) => (JSON.parse(service.store.readArtifact(run.runId, a.id)) as Review).findings ?? [])
    .find((f) => f.repeatOf === "C1");
  expect(repeated?.noRepro).toBe("Needs an unreadable directory");
}, 30000);
