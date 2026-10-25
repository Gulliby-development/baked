import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import {
  CASE_WALK_DIR,
  type CaseWalk,
  caseCheck,
  caseWalkDecision,
} from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { exportTrace, replayCaseWalks, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1715: the task-end case walk is a host decision a bench trace could not replay, because it reads
// test code and spec literals the trace does not keep. Each walk now records what held each case
// (the task's own files, the host's intact rows, a sibling's files) and the decision is replayed
// from that record.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-walk-replay-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Criterion = Spec["criteria"][number];
const CRITERION = {
  ...fixtureSpec.criteria[0],
  id: "AC-001",
  given: "a report",
  when: "the user runs `report --since 2024-01-02`",
  then: "the rows `alpha-7` and `omega-9` are listed",
} as Criterion;

type PlanTask = Pick<Task, "id" | "description" | "criterionIds" | "writes" | "dependsOn">;
const task = (id: string, path: string, dependsOn: string[] = []): PlanTask => ({
  id,
  description: "Write the report tests.",
  criterionIds: ["AC-001"],
  writes: [{ path, action: "create" }],
  dependsOn,
});
const holds = (...literals: string[]) =>
  `def test_report():\n${literals.map((l) => `    assert run(${JSON.stringify(l)}) == 0\n`).join("")}`;

test("the walk's record decides the same refusals and holds no literal (#1715)", async () => {
  const T007 = task("T007", "tests/test_cli.py");
  const T009 = task("T009", "tests/test_report.py", ["T007"]);
  const walks: (CaseWalk & { refused: number[] })[] = [];
  const check = caseCheck({ criteria: [CRITERION] }, T009, {
    checks: [],
    tasks: [T007, T009],
    record: (walk) => walks.push(walk),
  });
  if (!check) throw new Error("no case check");
  const refusals = await check(
    workspace({ "tests/test_report.py": holds("alpha-7"), "tests/test_cli.py": holds("report --since 2024-01-02") }),
  );
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain('"omega-9"');

  const [walk] = walks;
  if (!walk) throw new Error("no walk recorded");
  expect(walk.siblings).toBe(1);
  // Own file holds one, the sibling the command, and nothing holds the last.
  expect(walk.cases.map((c) => [c.held, c.sibling])).toEqual([
    [false, true],
    [true, null],
    [false, false],
  ]);
  expect(caseWalkDecision(walk)).toEqual(walk.refused);
  expect(walk.refused).toEqual([2]);
  const json = JSON.stringify(walk);
  for (const literal of ["alpha-7", "omega-9", "2024-01-02"]) expect(json.includes(literal)).toBe(false);
});

// Scripted scenario: a test task is refused once for a case its file leaves out, then passes. Both
// walks are recorded, kept in an exported trace and replayed unchanged; a rule that ignores sibling
// and row holds shows its new refusals.
test("each case walk is recorded, kept in a bench trace and replayed, and a rule change shows as new refusals (#1715)", async () => {
  const spec: Spec = { ...fixtureSpec, criteria: [CRITERION] };
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const found: string[][] = [];
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as {
        markdown: string;
        taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] };
      };
      plan.taskGraph.specHash = hashJson(spec);
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_report.py", action: "create" });
    }
    if (request.profile.output === "implementation") {
      const write = (body: string) => {
        mkdirSync(join(root, "tests"), { recursive: true });
        writeFileSync(join(root, "tests/test_report.py"), body);
      };
      write(holds("report --since 2024-01-02", "alpha-7"));
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      write(holds("report --since 2024-01-02", "alpha-7", "omega-9"));
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  expect(found[0]).toHaveLength(1);
  expect(found[1]).toEqual([]);

  const walks = replayCaseWalks(fixture.service.store, run.runId);
  expect(walks.map((b) => b.recorded)).toEqual([["AC-001#2"], []]);
  expect(walks.every((b) => JSON.stringify(b.replayed) === JSON.stringify(b.recorded))).toBe(true);
  const paths = fixture.service.store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith(CASE_WALK_DIR))
    .map((a) => a.logical_path);
  expect(paths).toContain(`${CASE_WALK_DIR}T001.json`);

  const dir = mkdtempSync(join(tmpdir(), "baked-case-walk-trace-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "trace.sqlite.gz");
  exportTrace(root, out);
  expect(Buffer.from(Bun.gunzipSync(readFileSync(out))).includes("def test_report")).toBe(false);
  const runOf = (replay: ReturnType<typeof replayTrace>) => replay.runs.find((r) => r.runId === run.runId);
  expect(runOf(replayTrace(out))?.newCaseRefusals).toBe(0);
  // A rule that refuses every case finds the refused walk's two held cases and the passing walk's three new.
  const every = (walk: CaseWalk) => walk.cases.map((_, i) => i);
  expect(runOf(replayTrace(out, { caseWalkRule: every }))?.newCaseRefusals).toBe(5);
}, 60_000);
