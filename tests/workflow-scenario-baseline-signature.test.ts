import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_BASELINE_PATH, commandKey } from "../src/core/verification/output-counts.js";
import type { BaselineSignatureRecord } from "../src/core/workflows/baseline-signature.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2295: a required check that fails before any change and fails the same way after the tasks,
// with only a value that changes between runs (Gradle's `1m 3s`, dotnet's `< 1 ms`, CTest's
// padding, a Lua address on Windows), was not recognised by the live `failureSignature`: the
// checks stage opened correctives for debt no task can reach. The shaped signature reads the
// repeated-failure table (`normalizeVolatile`); it ships in shadow, so the run still behaves as
// before and records one `baseline_signature` would-stop with both signatures.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const gradle = (time: string) =>
  `> Task :test FAILED\n\nParserTest > rejectsEmpty() FAILED\n    org.opentest4j.AssertionFailedError at ParserTest.kt:12\n\n1 test completed, 1 failed\n\nFAILURE: Build failed with an exception.\n\nBUILD FAILED in ${time}\n4 actionable tasks: 2 executed, 2 up-to-date\n`;
const busted = (address: string) =>
  `0 successes / 1 failure / 0 errors / 0 pending : 0.015 seconds\n\nFailure → spec/parse_spec.lua @ 3\nparse rejects empty input\nspec/parse_spec.lua:5: Expected objects to be the same.\nPassed in:\n(table: ${address}) {\n  [1] = 'x' }\n`;

/** Each toolchain family's failing output before any change and after the tasks. */
const FAMILIES: [string, string, string][] = [
  ["gradle", gradle("8s"), gradle("1m 3s")],
  [
    "dotnet",
    "  Failed App.Tests.ParserTests.RejectsEmpty [12 ms]\n  Error Message:\n   Assert.Equal() Failure\nFailed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1, Duration: 12 ms - App.Tests.dll (net8.0)",
    "  Failed App.Tests.ParserTests.RejectsEmpty [< 1 ms]\n  Error Message:\n   Assert.Equal() Failure\nFailed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1, Duration: < 1 ms - App.Tests.dll (net8.0)",
  ],
  [
    "ctest",
    "1/1 Test #1: parse ............................***Failed    0.01 sec\n0% tests passed, 1 tests failed out of 1\nTotal Test time (real) =   0.01 sec",
    "1/1 Test #1: parse ............................***Failed    1.23 sec\n0% tests passed, 1 tests failed out of 1\nTotal Test time (real) =  12.10 sec",
  ],
  ["busted", busted("00000184D28BE670"), busted("000001C3A0F21B30")],
];

/** A required check that prints `first` on its first run and `later` on every run after it. */
function flipping(id: string, first: string, later: string): RunPolicy["checks"][number] {
  const dir = mkdtempSync(join(tmpdir(), "baseline-signature-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const seen = join(dir, "seen").replaceAll("\\", "/");
  return {
    id,
    executable: "bun",
    args: [
      "-e",
      `const fs = require('node:fs'); const again = fs.existsSync(${JSON.stringify(seen)}); fs.writeFileSync(${JSON.stringify(seen)}, '1'); console.log(again ? ${JSON.stringify(later)} : ${JSON.stringify(first)}); process.exit(1)`,
    ],
    cwd: ".",
    timeoutMs: 10000,
    required: true,
    scope: "feature",
    envNames: [],
    writes: [],
  };
}

const wouldStops = (fixture: ReturnType<typeof workflowFixture>, runId: string) =>
  fixture.service.store
    .eventsOfType(runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; key: string; summary: string; inputs: BaselineSignatureRecord })
    .filter((p) => p.reason === "baseline_signature");

const errorsOf = (fixture: ReturnType<typeof workflowFixture>, runId: string) =>
  fixture.service.store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("errors/"))
    .map((a) => fixture.service.store.readArtifact(runId, a.id))
    .join("\n");

describe("scenario: a baseline failure whose volatile values changed (#2295)", () => {
  test.each(FAMILIES)("%s: shadow records the baseline_signature would-stop and keeps the live decision", async (family, first, later) => {
    const check = flipping("tests", first, later);
    const fixture = workflowFixture({ policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, check] } });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "README.md"), "# App\n");
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());

    const artifact = fixture.service.store.latestArtifact(run.runId, CHECK_BASELINE_PATH);
    const baseline = JSON.parse(fixture.service.store.readArtifact(run.runId, artifact?.id ?? "")) as {
      failures: Record<string, string>;
      shapes: Record<string, string>;
    };
    expect(baseline.shapes[commandKey(check)]).toBeString();
    // Shadow: the live signature still tells the runs apart, so no baseline_failure stop.
    expect(errorsOf(fixture, run.runId)).not.toContain("baseline_failure: required check tests failed");
    const records = wouldStops(fixture, run.runId).filter((w) => w.key === "checks:check-tests");
    expect(records).toHaveLength(1);
    expect(records[0]?.inputs).toMatchObject({ checkId: "tests", at: "checks", decision: "shaped", subset: false });
    expect(records[0]?.inputs.legacy.before).not.toEqual(records[0]?.inputs.legacy.after);
    expect(records[0]?.inputs.shaped.before).toEqual(records[0]?.inputs.shaped.after);
    expect(records[0]?.summary).toContain("required check tests fails as it did before any change");

    // The replay hook decides each recorded comparison again from the bench trace.
    if (family !== "gradle") return;
    const dir = mkdtempSync(join(tmpdir(), "baseline-signature-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(fixture.root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === run.runId);
    expect(replayed?.baselineSignatures.some((b) => b.checkId === "tests" && b.at === "checks" && b.recorded === "shaped" && b.replayed === "shaped")).toBe(true);
    expect(replayed?.newSignatureDecisions).toBe(0);
    // The rule before #2295 (the live signature alone) decides it differently.
    const legacy = replayTrace(out, { baselineSignatureRule: () => "neither" }).runs.find((r) => r.runId === run.runId);
    expect(legacy?.newSignatureDecisions).toBeGreaterThan(0);
  }, 60000);

  test("the same failure is a match on both signatures and records no would-stop", async () => {
    const check = flipping("tests", gradle("8s"), gradle("9s"));
    const fixture = workflowFixture({ policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, check] } });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "README.md"), "# App\n");
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());
    expect(errorsOf(fixture, run.runId)).toContain("baseline_failure: required check tests failed");
    expect(wouldStops(fixture, run.runId)).toEqual([]);
    const records = fixture.service.store
      .artifacts(run.runId)
      .filter((a) => a.kind === "baseline-signature")
      .map((a) => JSON.parse(fixture.service.store.readArtifact(run.runId, a.id)) as BaselineSignatureRecord);
    expect(records.map((r) => r.decision)).toContain("both");
  }, 60000);

  // #1218's task-end excuse reads the same comparison with `subset`: the task's check opens a
  // correction (the live decision) and the would-stop says it would have been excused.
  test("the task-end check records the would-stop on its own path", async () => {
    const check = {
      ...flipping(
        "biome",
        "biome.json format\n  × Formatter would have printed the following content:\nChecked 1 file in 8s. No fixes applied.\nFound 1 error.",
        "biome.json format\n  × Formatter would have printed the following content:\nChecked 2 files in 1m 3s. No fixes applied.\nFound 1 error.",
      ),
    };
    class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output === "implementation") {
          mkdirSync(join(fixture.root, "src"), { recursive: true });
          writeFileSync(join(fixture.root, "src", "duration.ts"), "export const ms = 1;\n");
        }
        if (request.profile.output !== "plan") return result;
        const output = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        for (const task of output.taskGraph.tasks) task.writes.push({ path: "src/duration.ts", action: "create" });
        return result;
      }
    }
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, check] },
      executor: (root) => new ScriptedExecutor(root),
    });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "biome.json"), '{ "formatter": { "enabled": true } }');
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());

    const records = wouldStops(fixture, run.runId).filter((w) => w.key === "task:check-biome");
    expect(records).toHaveLength(1);
    expect(records[0]?.inputs).toMatchObject({ checkId: "biome", at: "task", decision: "shaped", subset: true });
    expect(records[0]?.summary).toContain("the task's check would be excused");
  }, 60000);
});
