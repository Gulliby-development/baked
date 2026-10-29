import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 58, wheeltags 9ed8820c (#1864): the decomposer gave the base feature's tests to an
// acceptance feature, so base's plan wrote no test and the scaffold had none. pytest exited 5
// ("no tests ran"), the required tests check failed five times, and the run stopped no_progress
// with every downstream feature waiting.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** pytest on a tree with no test: exit 5, whatever the plan does. */
const pytestEmpty = { id: "tests", executable: "bun", args: ["-e", "console.log('collected 0 items\\n\\n============ no tests ran in 0.01s ============'); process.exit(5)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [] };
const policy: RunPolicy = { ...fixturePolicy, checks: [fixturePolicy.checks[0]!, pytestEmpty] };
/** `swift test` on a test target with no test yet (Swift 6.4.1, #2419): exit 0, and `requireTests` fails it. */
const swiftEmpty = { ...pytestEmpty, args: ["-e", `console.log(${JSON.stringify("Test Suite 'All tests' passed at 2026-10-28 21:31:05.697\n\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds\n◊ Test run started.\n√ Test run with 0 tests in 0 suites passed after 0.001 seconds.")})`], requireTests: true };
const swiftPolicy: RunPolicy = { ...fixturePolicy, checks: [fixturePolicy.checks[0]!, swiftEmpty] };

/** The fixture's plan, plus a test file when `withTest` is set; implementation writes every planned file. */
class PlanExecutor extends FixtureExecutor {
  constructor(private dir: string, private withTest: boolean) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan" && this.withTest)
      (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: "tests/test_value.py", action: "create" });
    if (request.profile.output === "implementation")
      for (const write of request.task?.writes ?? []) {
        const file = join(request.root ?? this.dir, write.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "ready");
      }
    return result;
  }
}

async function run(withTest: boolean, checks: RunPolicy = policy) {
  const fixture = workflowFixture({ policy: checks, executor: (root) => new PlanExecutor(root, withTest) });
  cleanups.push(fixture.dispose);
  const started = await fixture.start();
  const drive = () => fixture.service.drive(started.runId, new AbortController().signal).catch((error: unknown) => ({ status: "faulted", error }));
  let done = await drive();
  // The plan approval, then the rest of the run.
  if ((done as { status: string }).status === "waiting") {
    await fixture.approve(started.runId);
    done = await drive();
  }
  const diagnostics = fixture.service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("checks/no-tests/"));
  const claims = fixture.service.store.findings(started.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  const report = runReport(fixture.service.store, started.runId);
  const view = readWorkflowView(fixture.service, started.runId);
  return { done, diagnostics, claims, report, view, read: (id: string) => fixture.service.store.readArtifact(started.runId, id) };
}

test("a plan that writes no test is not failed by a test check that collected none", async () => {
  const { done, diagnostics, claims, read } = await run(false);
  expect(claims.filter((c) => c.includes("tests"))).toEqual([]);
  expect((done as { status: string }).status).toBe("completed");
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(read(diagnostics[0]!.id)).toContain("tests collected no test and this run's plan writes none");
});

test("a plan that writes a test still fails when the check collects none", async () => {
  const { done, diagnostics } = await run(true);
  expect((done as { status: string }).status).not.toBe("completed");
  expect(diagnostics).toEqual([]);
});

test("a Swift test target with no test yet is not failed in a plan that writes none (#2419)", async () => {
  const { done, diagnostics, claims, read } = await run(false, swiftPolicy);
  expect(claims.filter((c) => c.includes("tests"))).toEqual([]);
  expect((done as { status: string }).status).toBe("completed");
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(read(diagnostics[0]!.id)).toContain("tests collected no test and this run's plan writes none");
});

// Bench round 59 (#1894): base, names and targets were accepted, and their reports still read
// `| tests | failed |`; every view of the checks now reads what acceptance decided.
test("the report and the run view show a host-passed check as passed, with the reason", async () => {
  const { report, view } = await run(false);
  expect(report).toContain("| `tests` | passed (by the host) |");
  expect(report).toContain("`tests` failed and counts as passed: tests collected no test and this run's plan writes none");
  const detail = view?.checkDetails.find((c) => c.checkId === "tests");
  expect(detail).toMatchObject({ status: "passed", hostPassed: expect.stringContaining("collected no test") });
  expect(view?.checks.filter((c) => c.check_id === "tests").every((c) => c.status === "passed")).toBe(true);
});

test("a check that really failed still reads failed", async () => {
  const { report, view } = await run(true);
  expect(report).toMatch(/\| `tests` \| failed \|/);
  expect(view?.checkDetails.find((c) => c.checkId === "tests")?.status).toBe("failed");
});
