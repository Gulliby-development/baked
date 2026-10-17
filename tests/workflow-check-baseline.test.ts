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
import { baselineDebt, baselineKeys } from "../src/core/verification/task-end-check.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

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

  // A language without a parser of its own still gets the fewer-tests baseline (#1488).
  test("reads TAP plans and JUnit XML reports", () => {
    expect(testCount("ok 1 - adds\nok 2 - subtracts\n1..2")).toEqual({ tool: "tap", count: 2 });
    expect(testCount("1..3\nok 1\n    1..5\n    ok 1 - sub\nok 2\nok 3\n1..1 # second stream\nok 1")).toEqual({ tool: "tap", count: 4 });
    expect(testCount("t/basic.t .. ok\nAll tests successful.\nFiles=2, Tests=14,  0 wallclock secs\nResult: PASS")).toEqual({ tool: "tap", count: 14 });
    expect(testCount('<?xml version="1.0"?>\n<testsuites name="busted" tests="7" failures="0">\n<testsuite name="a" tests="4"></testsuite>\n</testsuites>')).toEqual({ tool: "junit", count: 7 });
    expect(testCount('<testsuite name="a" tests="4"/>\n<testsuite name="b" tests="3"/>')).toEqual({ tool: "junit", count: 7 });
    expect(testCount('<testsuite name="a"><testcase name="x"/><testcase name="y"/></testsuite>')).toEqual({ tool: "junit", count: 2 });
    // A range in prose is no plan.
    expect(testCount("use slices 1..2 of the input")).toBeNull();
    const tap = { kind: "tests" as const, tool: "tap", count: 10 };
    expect(baselineRegression(tap, "ok 1\n1..8")).toContain("fell from 10 to 8");
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

  // #1055, mouse-mover-update 3d7389cf: the baseline printed the run worktree in its stack trace and
  // the later run printed a task worktree, so the same failure got a 364k corrective task.
  test("a baseline failure is recognised when its stack trace names another worktree", async () => {
    const stale = {
      ...lint,
      id: "test",
      args: [
        "-e",
        "const at = [process.cwd(), '.baked', 'worktrees', 'run', `T${process.pid}`, 'src', 'cursor.test.ts'].join('/'); console.error(`TypeError: screen is undefined\\n    at ${at}:12:3`); process.exit(1)",
      ],
    };
    const fixture = workflowFixture({ policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, stale] } });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "README.md"), "# App\n");
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());

    expect(baseline(fixture, run.runId)?.failures).toMatchObject({
      [commandKey(stale)]: "TypeError: screen is undefined\n    at <root>/src/cursor.test.ts:12:3",
    });
    const status = await fixture.service.get(run.runId);
    expect(status.status).toBe("blocked");
    expect(status.reason).toBe("no_progress");
    const tasks = fixture.service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as { origin: string });
    expect(tasks.every((t) => t.origin === "planned")).toBe(true);
  });

  // #1218, dur 741547f0: Biome rejected the scaffold's own biome.json before any change. After
  // T001 its summary said "Checked 2 files" instead of "Checked 1 file", so the task-end check was
  // not recognised and corrective T004 spent 38k tokens on a file it could not fix.
  test("a task check that fails on an unplanned file as it did before any change opens no correction", async () => {
    const biome = {
      ...lint,
      id: "biome",
      args: [
        "-e",
        "const n = require('node:fs').readdirSync('.').filter((f) => !f.startsWith('.')).length; console.error('biome.json format ━━━━━━━━━━\\n\\n  × Formatter would have printed the following content:'); console.log(`Checked ${n} file${n === 1 ? '' : 's'} in 3ms. No fixes applied.`); console.log('Found 1 error.'); process.exit(1)",
      ],
    };
    class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output === "implementation") {
          mkdirSync(join(fixture.root, "src"), { recursive: true });
          writeFileSync(join(fixture.root, "src", "duration.ts"), "export const ms = 1;\n");
        }
        if (request.profile.output !== "plan") return result;
        // T001 writes code, so the static feature check covers it at task end.
        const output = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        for (const task of output.taskGraph.tasks) task.writes.push({ path: "src/duration.ts", action: "create" });
        return result;
      }
    }
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, biome] },
      executor: (root) => new ScriptedExecutor(root),
    });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "biome.json"), '{ "formatter": { "enabled": true } }');
    const run = await driveToChecks(fixture);

    expect(baseline(fixture, run.runId)?.failures[commandKey(biome)]).toContain("Checked <n> file in");
    const tasks = fixture.service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as { origin: string });
    expect(tasks.every((t) => t.origin === "planned")).toBe(true);
    const status = await fixture.service.get(run.runId);
    expect(status.status).toBe("blocked");
    const errors = fixture.service.store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("errors/"))
      .map((a) => fixture.service.store.readArtifact(run.runId, a.id));
    expect(errors.join("\n")).toContain("baseline_failure: required check biome failed before any change");
  });

  // #1222: under `staticBaseline: "relative"` the same pre-existing debt in a file no task writes
  // passes the check, so the run completes instead of stopping with baseline_failure.
  describe("with staticBaseline: relative", () => {
    const biomeCheck = (diagnostics: string) => ({
      ...lint,
      id: "biome",
      args: [
        "-e",
        `const d = ${JSON.stringify(diagnostics)}.split(",").filter(Boolean); for (const f of d) console.error(f + " ━━━━━━━━━━\\n\\n  × Formatter would have printed the following content:"); console.log("Checked 2 files in 3ms. No fixes applied."); if (d.length) { console.log("Found " + d.length + " errors."); process.exit(1) }`,
      ],
    });
    class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output !== "plan") return result;
        const output = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        for (const task of output.taskGraph.tasks) task.writes.push({ path: "src/duration.ts", action: "create" });
        return result;
      }
    }
    const scenario = async (diagnostics: string) => {
      const biome = biomeCheck(diagnostics);
      const fixture = workflowFixture({
        policy: { ...fixturePolicy, staticBaseline: "relative", checks: [...fixturePolicy.checks, biome] },
        executor: (root) => {
          const executor = new ScriptedExecutor(root);
          const execute = executor.execute.bind(executor);
          executor.execute = async (request) => {
            if (request.profile.output === "implementation") {
              mkdirSync(join(root, "src"), { recursive: true });
              writeFileSync(join(root, "src", "duration.ts"), "export const ms = 1;\n");
            }
            return execute(request);
          };
          return executor;
        },
      });
      cleanups.push(fixture.dispose);
      writeFileSync(join(fixture.root, "biome.json"), '{ "formatter": { "enabled": true } }');
      const run = await driveToChecks(fixture);
      return { fixture, run, biome };
    };

    test("debt in a file no task writes passes the check and the run completes", async () => {
      const { fixture, run, biome } = await scenario("biome.json format");
      expect(baseline(fixture, run.runId)?.debt).toEqual({ [commandKey(biome)]: ["biome.json|format"] });
      const st = await fixture.service.get(run.runId);
      expect(st.status).toBe("completed");
      const tasks = fixture.service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as { origin: string });
      expect(tasks.every((t) => t.origin === "planned")).toBe(true);
      const debt = fixture.service.store
        .artifacts(run.runId)
        .filter((a) => a.logical_path.startsWith("checks/baseline-debt/biome-"));
      expect(debt.length).toBeGreaterThan(0);
    });

    test("debt needs the whole summary count and only baseline diagnostics", () => {
      const out = "biome.json format ━━━━\nsrc/a.ts:3:7 lint/style/useConst FIXABLE ━━━━\nFound 2 errors.";
      const baseline = baselineKeys(out, "/w");
      expect(baseline).toEqual(["biome.json|format", "src/a.ts|lint/style/useConst"]);
      expect(baselineDebt(out, "/w", { baseline, changed: [], summary: 2 })).toEqual(baseline);
      // The tool counted more than the parser found: an unlisted diagnostic may be new.
      expect(baselineDebt(out, "/w", { baseline, changed: [], summary: 3 })).toBeNull();
      expect(baselineDebt(out, "/w", { baseline, changed: [], summary: null })).toBeNull();
      expect(baselineDebt(out, "/w", { baseline: ["biome.json|format"], changed: [], summary: 2 })).toBeNull();
    });

    // #1326: ruff's default `full` format puts the rule code on its own header line and the
    // location on a `-->` line; the parser found nothing in it, so the run stopped on F401 debt.
    test("ruff debt in its default output format passes the check and the run completes", async () => {
      const full = "F401 [*] `os` imported but unused\n --> tools/legacy.py:1:8\n  |\n1 | import os\n  |        ^^\n  |\nhelp: Remove unused import: `os`\n\nFound 1 error.\n[*] 1 fixable with the `--fix` option.";
      expect(baselineKeys(full, "/w")).toEqual(["tools/legacy.py|F# [*] `os` imported but unused"]);
      const ruff = {
        ...lint,
        id: "ruff",
        args: ["-e", `console.log(${JSON.stringify(full)}); process.exit(1)`],
      };
      const fixture = workflowFixture({
        policy: { ...fixturePolicy, staticBaseline: "relative", checks: [...fixturePolicy.checks, ruff] },
      });
      cleanups.push(fixture.dispose);
      mkdirSync(join(fixture.root, "tools"));
      writeFileSync(join(fixture.root, "tools", "legacy.py"), "import os\n");
      const run = await driveToChecks(fixture);
      expect(baseline(fixture, run.runId)?.debt).toEqual({ [commandKey(ruff)]: ["tools/legacy.py|F# [*] `os` imported but unused"] });
      expect((await fixture.service.get(run.runId)).status).toBe("completed");
    });

    test("the same diagnostic in a file a task writes still fails the check", async () => {
      const { fixture, run } = await scenario("src/duration.ts format");
      const findings = fixture.service.store.findings(run.runId).map((f) => JSON.parse(f.body_json) as { claim: string });
      expect(findings.some((f) => /check biome failed$/.test(f.claim))).toBe(true);
      expect(
        fixture.service.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("checks/baseline-debt/")),
      ).toBe(false);
    });
  });

  test("a failure signature leaves out linter summary counts but keeps the diagnostics", () => {
    const biome = (files: number, file: string) =>
      `${file} format\n  × Formatter would have printed the following content:\nChecked ${files} file${files === 1 ? "" : "s"} in 3ms. No fixes applied.\nFound 1 error.`;
    expect(failureSignature(biome(2, "biome.json"), "/w")).toBe(failureSignature(biome(1, "biome.json"), "/w"));
    expect(failureSignature(biome(2, "src/a.ts"), "/w")).not.toBe(failureSignature(biome(1, "biome.json"), "/w"));
    expect(failureSignature("src/a.ts(1,1): error TS1005\nFound 1 error in 1 file.", "/w")).toBe(
      failureSignature("src/a.ts(1,1): error TS1005\nFound 2 errors in 3 files.", "/w"),
    );
    expect(failureSignature("a.py:1:1: E501\nFound 1 error.\n3 files checked", "/w")).toBe(
      failureSignature("a.py:1:1: E501\nFound 1 error.\n4 files checked", "/w"),
    );
    // #1425: Python tools and test summaries count files checked and tests passed too.
    for (const [before, after] of [
      ["src/a.py:3: error: Bad\nFound 1 error in 1 file (checked 4 source files)", "src/a.py:3: error: Bad\nFound 1 error in 1 file (checked 5 source files)"],
      ["Would reformat: src/a.py\n1 file would be reformatted, 3 files already formatted", "Would reformat: src/a.py\n1 file would be reformatted, 4 files already formatted"],
      ["would reformat src/a.py\n1 file would be reformatted, 3 files would be left unchanged.", "would reformat src/a.py\n1 file would be reformatted, 4 files would be left unchanged."],
      ["FAILED tests/test_a.py::test_x\n1 failed, 4 passed in 0.2s", "FAILED tests/test_a.py::test_x\n1 failed, 5 passed in 0.3s"],
      ["Tests:       1 failed, 4 passed, 5 total", "Tests:       1 failed, 5 passed, 6 total"],
      ["5 tests completed, 1 failed", "6 tests completed, 1 failed"],
    ])
      expect(failureSignature(before, "/w")).toBe(failureSignature(after, "/w"));
    // A different number of failures is a different failure.
    expect(failureSignature("FAILED tests/test_a.py::test_x\n1 failed, 4 passed", "/w")).not.toBe(failureSignature("FAILED tests/test_a.py::test_x\n2 failed, 4 passed", "/w"));
    expect(failureSignature("✖ 2 problems (2 errors, 0 warnings)", "/w")).toBe(
      failureSignature("✖ 3 problems (3 errors, 0 warnings)", "/w"),
    );
  });

  test("a failure signature names every worktree of the project as the workspace", () => {
    const at = (path: string) => `Error: boom\n    at ${path}/src/a.ts:3:7`;
    const unix = "/work/app/.baked/worktrees/3d7389cf";
    const win = "C:\\Project\\app\\.baked\\worktrees\\3d7389cf";
    const expected = "Error: boom\n    at <root>/src/a.ts:3:7";
    expect(failureSignature(at(`${unix}/main`), `${unix}/main`)).toBe(expected);
    expect(failureSignature(at(`${unix}/T005`), `${unix}/main`)).toBe(expected);
    expect(failureSignature(at("/work/app"), `${unix}/main`)).toBe(expected);
    expect(failureSignature(at(`${win}\\T005`), `${win}\\main`)).toBe(
      failureSignature(at(`${win}\\main`), `${win}\\main`),
    );
  });

  test("a failure signature leaves out colours, durations and the workspace path", () => {
    expect(failureSignature("\u001b[31merror\u001b[0m in 12ms at /work/app/a.ts", "/work/app")).toBe("error in <duration> at <root>/a.ts");
  });
});
