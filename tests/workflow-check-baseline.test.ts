import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  baselineRegression,
  CHECK_BASELINE_PATH,
  commandKey,
  failureSignature,
  diagnosticCount,
  outputCounts,
  testCount,
} from "../src/core/verification/output-counts.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

describe("check output counts", () => {
  test("reads the diagnostics of common linters and type checkers", () => {
    expect(diagnosticCount("Checked 12 files in 3ms. No fixes applied.")).toEqual({ tool: "biome", count: 0 });
    expect(
      diagnosticCount("Checked 12 files in 3ms. No fixes applied.\nFound 2 warnings.\nFound 3 infos."),
    ).toEqual({ tool: "biome", count: 5 });
    expect(diagnosticCount("✖ 5 problems (2 errors, 3 warnings)")).toEqual({ tool: "eslint", count: 5 });
    expect(diagnosticCount("All checks passed!")).toEqual({ tool: "ruff", count: 0 });
    expect(diagnosticCount("src/a.py:1:1: F401 unused\nFound 1 error.")).toEqual({ tool: "ruff", count: 1 });
    expect(diagnosticCount("Found 2 errors in 1 file.")).toEqual({ tool: "tsc", count: 2 });
    expect(
      diagnosticCount(
        '    Checking app v0.1.0\nwarning: `app` (bin "app") generated 3 warnings\n    Finished `dev` profile [unoptimized] target(s) in 0.5s',
      ),
    ).toEqual({ tool: "cargo", count: 3 });
    expect(diagnosticCount("Build succeeded.\n    2 Warning(s)\n    0 Error(s)")).toEqual({ tool: "dotnet", count: 2 });
    expect(diagnosticCount("")).toBeNull();
    expect(diagnosticCount("ok")).toBeNull();
  });

  test("reads the test counts of common runners", () => {
    expect(testCount(" 42 pass\n 0 fail\nRan 42 tests across 3 files. [1.2s]")).toEqual({ tool: "bun", count: 42 });
    expect(testCount("Tests:       1 failed, 12 passed, 13 total")).toEqual({ tool: "jest", count: 13 });
    expect(testCount("      Tests  12 passed (12)")).toEqual({ tool: "vitest", count: 12 });
    expect(testCount("======= 3 passed, 1 skipped in 0.12s =======")).toEqual({ tool: "pytest", count: 4 });
    expect(
      testCount(
        "test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured",
      ),
    ).toEqual({ tool: "cargo", count: 7 });
    expect(testCount("Passed!  - Failed: 0, Passed: 12, Skipped: 0, Total: 12")).toEqual({ tool: "dotnet", count: 12 });
    expect(testCount("[INFO] Tests run: 9, Failures: 0, Errors: 0, Skipped: 0")).toEqual({ tool: "maven", count: 9 });
    expect(testCount("=== RUN   TestA\n=== RUN   TestA/sub\n=== RUN   TestB\nPASS")).toEqual({ tool: "go", count: 2 });
    expect(testCount("ok  \texample.com/app\t0.01s")).toBeNull();
  });

  test("a regression needs the same tool on both sides and ignores fewer tests when tests are deleted", () => {
    const lint = { kind: "diagnostics" as const, tool: "biome", count: 1 };
    expect(baselineRegression(lint, "Checked 1 file in 1ms.\nFound 2 infos.")).toContain("rose from 1 to 2");
    expect(baselineRegression(lint, "Checked 1 file in 1ms.")).toBeNull();
    expect(baselineRegression(lint, "✖ 9 problems (9 errors, 0 warnings)")).toBeNull();
    const tests = { kind: "tests" as const, tool: "bun", count: 10 };
    expect(baselineRegression(tests, "Ran 8 tests across 1 file.")).toContain("fell from 10 to 8");
    expect(baselineRegression(tests, "Ran 8 tests across 1 file.", true)).toBeNull();
    expect(baselineRegression(tests, "Ran 12 tests across 1 file.")).toBeNull();
    // A failing suite's count is not a baseline: some tests never ran.
    expect(outputCounts("Ran 3 tests across 1 file.", false)).toEqual([]);
  });
});

// The lint check exits 0 and reports one info per line of value.txt, as Biome does for infos.
const lint = {
  id: "lint",
  executable: "bun",
  args: [
    "-e",
    "const f = Bun.file('value.txt'); const n = (await f.exists()) ? (await f.text()).split('\\n').filter(Boolean).length : 0; console.log('Checked 2 files in 1ms. No fixes applied.'); if (n) console.log(`Found ${n} infos.`)",
  ],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
};
const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, lint] };

async function driveToChecks(fixture: ReturnType<typeof workflowFixture>) {
  const run = await fixture.start();
  await fixture.service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, signal());
  return run;
}

const baseline = (fixture: ReturnType<typeof workflowFixture>, runId: string) => {
  const artifact = fixture.service.store.latestArtifact(runId, CHECK_BASELINE_PATH);
  return artifact ? JSON.parse(fixture.service.store.readArtifact(runId, artifact.id)) : null;
};

describe("baseline comparison in update runs", () => {
  test("a check that passes with more diagnostics than the code the run started from fails", async () => {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    mkdirSync(join(fixture.root, "src"));
    writeFileSync(join(fixture.root, "src", "a.ts"), "export const a = 1;\n");
    const run = await driveToChecks(fixture);

    expect(baseline(fixture, run.runId)?.counts).toEqual({
      [commandKey(lint)]: [{ kind: "diagnostics", tool: "biome", count: 0 }],
    });
    const findings = fixture.service.store
      .findings(run.runId)
      .map((f) => JSON.parse(f.body_json) as { claim: string });
    const lintFinding = findings.find((f) => f.claim === "Required check lint failed");
    expect(JSON.stringify(lintFinding)).toContain("diagnostics rose from 0 to 1");
    expect(findings.some((f) => f.claim === "Required check check failed")).toBe(false);
  });

  test("a scaffold run measures no baseline counts and passes on exit codes", async () => {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "README.md"), "# App\n");
    const run = await driveToChecks(fixture);
    for (let i = 0; i < 3 && (await fixture.service.get(run.runId)).status !== "completed"; i++) {
      await fixture.resume(run.runId);
      await fixture.service.drive(run.runId, signal());
    }

    // Only which required checks fail before any change is recorded (#934).
    expect(baseline(fixture, run.runId)).toMatchObject({ counts: {}, diagnostics: {} });
    const approval = fixture.service.store.requests(run.runId).find((r) => r.kind === "approval");
    // value.txt does not exist yet, so the fixture's check fails before the tasks write it.
    expect(JSON.parse(approval?.body_json ?? "{}").baselineFailures).toEqual(["check"]);
    expect((await fixture.service.get(run.runId)).status).toBe("completed");
  });

  // #934, md-site 00ae0ac0: a Bun CLI scaffold kept a `vite build` check that cannot pass on any
  // plan; a corrective task spent four attempts on it before the run blocked.
  test("a required check that fails the same way before any change stops the run without a correction", async () => {
    const stale = {
      ...lint,
      id: "build",
      args: ["-e", "console.error('Could not resolve entry module \"index.html\".'); process.exit(1)"],
    };
    const fixture = workflowFixture({ policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, stale] } });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "README.md"), "# App\n");
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    // The approval already names it, before any task runs.
    const approval = fixture.service.store
      .requests(run.runId)
      .find((r) => r.kind === "approval" && r.status === "pending");
    expect(JSON.parse(approval?.body_json ?? "{}").baselineFailures).toEqual(["check", "build"]);
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());

    expect(baseline(fixture, run.runId)?.failures).toMatchObject({
      [commandKey(stale)]: 'Could not resolve entry module "index.html".',
    });
    const status = await fixture.service.get(run.runId);
    expect(status.status).toBe("blocked");
    expect(status.reason).toBe("no_progress");
    const errors = fixture.service.store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("errors/"))
      .map((a) => fixture.service.store.readArtifact(run.runId, a.id));
    expect(errors.join("\n")).toContain("baseline_failure: required check build failed before any change");
    const tasks = fixture.service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as { origin: string });
    expect(tasks.every((t) => t.origin === "planned")).toBe(true);
  });

  test("a failure signature leaves out colours, durations and the workspace path", () => {
    expect(failureSignature("\u001b[31merror\u001b[0m in 12ms at /work/app/a.ts", "/work/app")).toBe("error in <duration> at <root>/a.ts");
  });
});
