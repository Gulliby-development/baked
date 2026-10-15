import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import {
  appendCorrections,
  failedCheckFindings,
  failureSignature,
} from "../src/core/verification/convergence.js";
import { PROBE_TRIES, probeTool, runProbe, writesDocumentation } from "../src/core/verification/repro.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Review, RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { RuntimeState, Task } from "../src/core/workflows/types.js";
import { fixtureSpec } from "./helpers/workflow-fixture.js";

const SIX = [
  "(fail) store > redacts headers [3.20ms]",
  "(fail) store > keeps BOM [1.10ms]",
  "(fail) store > a [0.50ms]",
  "(fail) store > b [0.50ms]",
  "(fail) store > c [0.50ms]",
  "(fail) store > d [0.50ms]",
].join("\n");
const ONE = "(fail) store > keeps BOM [9.90ms]\nerror: expect(received).toBe(expected)";

describe("failureSignature", () => {
  test("ignores timings and paths so the same failure compares equal", () => {
    const a = failureSignature(
      String.raw`(fail) store > keeps BOM [3.20ms]
error: boom at C:\work\run\src\app.ts:12:5`,
    );
    const b = failureSignature(
      "(fail) store > keeps BOM [8.00ms]\nerror: boom at /tmp/other/src/app.ts:99:1",
    );
    expect(a).toBe(b);
    expect(a).toContain("keeps BOM");
  });

  test("partial progress changes the signature", () => {
    expect(failureSignature(SIX)).not.toBe(failureSignature(ONE));
  });

  test("is empty when the output names no failure", () => {
    expect(failureSignature("all good\n3 pass")).toBe("");
  });
});

const task = (id: string, path: string): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path, action: "modify" }],
  readHints: [],
  checkIds: ["tests"],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const root: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [task("T001", "src/app.ts")],
};
const policy = { maxRepairRounds: 3, maxConvergenceRounds: 3, maxCorrectiveTasks: 20 } as RunPolicy;
const store = {
  run: () => ({ repair_rounds: 0, convergence_rounds: 0, corrective_tasks: 0 }),
  artifact: (_run: string, _kind: string, path: string) => ({
    id: `artifact:${path}`,
    content_hash: "h".repeat(64),
  }),
  latestArtifact: () => null,
  syncTasks: () => undefined,
  tasks: () => [],
  findingStatus: () => undefined,
  addRound: () => undefined,
} as unknown as WorkflowStore;
const stateOf = (): RuntimeState =>
  ({
    graph: structuredClone(root),
    rootGraph: structuredClone(root),
    spec: fixtureSpec,
    approvalRoot: "c".repeat(64),
    repairPredecessors: {},
    correctionHashes: [],
    manifest: {},
    expectedFiles: null,
    noProgressRounds: 0,
    previousFindingSet: null,
    freshTasks: {},
  }) as unknown as RuntimeState;
let ids = 0;
const failing = (output: string): Review["findings"] =>
  failedCheckFindings(
    { id: "tests" },
    "E1",
    output,
    root.tasks,
    { requirementIds: ["FR-001"], criterionIds: ["AC-001"] },
    "Inspect it.",
    () => `F${++ids}`,
  );
const fault = (run: () => void): WorkflowFault | undefined => {
  try {
    run();
  } catch (error) {
    return error as WorkflowFault;
  }
  return undefined;
};

describe("no-progress detection of repair rounds", () => {
  test("the finding names what fails", () => {
    expect(failing(ONE)[0]?.impact).toContain("keeps BOM");
  });

  // hookdrop c325575b: the second repair round was never used after one identical failure.
  test("the first identical failure gets one more repair round, told to probe", () => {
    const state = stateOf();
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    const last = state.graph?.tasks.at(-1);
    expect(last?.description).toContain("run_probe");
    expect(state.graph?.tasks.at(-2)?.description).not.toContain("run_probe");
  });

  test("a second identical failure starts the correction from a clean context, a third stops", () => {
    const state = stateOf();
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    const fresh = state.graph?.tasks.at(-1);
    expect(fresh?.description).not.toContain("run_probe");
    expect(state.freshTasks[fresh?.id ?? ""]).toBe(`artifact:tasks/${fresh?.id}/fresh-start.json`);
    expect(Object.keys(state.freshTasks)).toHaveLength(1);
    const stop = fault(() => appendCorrections(store, "run", state, policy, failing(ONE), "repair"));
    expect(stop?.details).toMatchObject({ reason: "no_progress", freshRestart: true });
    expect(stop?.message).toContain("clean context");
  });

  test("freshRestartAfter sets the repeat that restarts, and the round limit does not refuse it", () => {
    const state = stateOf();
    const one = { ...policy, freshRestartAfter: 1 } as RunPolicy;
    appendCorrections(store, "run", state, one, failing(ONE), "repair");
    appendCorrections(store, "run", state, one, failing(ONE), "repair");
    expect(Object.keys(state.freshTasks)).toEqual([state.graph?.tasks.at(-1)?.id ?? ""]);
    // At the round limit a repeat that is due a clean-context restart still gets it.
    const limited = stateOf();
    const capped = { ...policy, maxRepairRounds: 0, freshRestartAfter: 1 } as RunPolicy;
    const atLimit = { ...store, run: () => ({ repair_rounds: 1, convergence_rounds: 0, corrective_tasks: 0 }) } as unknown as WorkflowStore;
    limited.previousFindingSet = null;
    expect(fault(() => appendCorrections(atLimit, "run", limited, capped, failing(ONE), "repair"))?.details).toMatchObject({ limit: "maxRepairRounds" });
    appendCorrections(store, "run", limited, { ...capped, maxRepairRounds: 3 }, failing(ONE), "repair");
    appendCorrections(atLimit, "run", limited, capped, failing(ONE), "repair");
    expect(Object.keys(limited.freshTasks)).toHaveLength(1);
  });

  test("fewer failures count as progress", () => {
    const state = stateOf();
    appendCorrections(store, "run", state, policy, failing(SIX), "repair");
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    appendCorrections(store, "run", state, policy, failing(ONE), "repair");
    expect(state.noProgressRounds).toBe(1);
  });

  test("convergence rounds still stop at the first repeat", () => {
    const state = stateOf();
    appendCorrections(store, "run", state, policy, failing(ONE), "convergence");
    const stop = fault(() =>
      appendCorrections(store, "run", state, policy, failing(ONE), "convergence"),
    );
    expect(stop?.details.reason).toBe("no_progress");
  });
});

describe("run_probe", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const workspace = () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-probe-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), "x");
    return dir;
  };
  const options = (dir: string) => ({
    root: dir,
    executables: ["bun"],
    generated: [] as string[],
    signal: new AbortController().signal,
    sandbox: null,
  });

  test("returns the output of a program the checks start", async () => {
    const outcome = await runProbe(
      new ProcessScope(),
      { executable: "bun", args: ["-e", "console.log('probe-ok')"] },
      options(workspace()),
    );
    expect(outcome.status).toBe("ran");
    expect(outcome.output).toContain("probe-ok");
    expect(outcome.exitCode).toBe(0);
  });

  test("refuses a program no check starts", async () => {
    const outcome = await runProbe(
      new ProcessScope(),
      { executable: "curl", args: [] },
      options(workspace()),
    );
    expect(outcome.status).toBe("refused");
  });

  test("refuses a probe that changed a source file", async () => {
    const dir = workspace();
    const outcome = await runProbe(
      new ProcessScope(),
      { executable: "bun", args: ["-e", "require('fs').writeFileSync('a.txt','y')"] },
      options(dir),
    );
    expect(outcome.status).toBe("refused");
  });

  test("stops after the allowed number of tries", async () => {
    const tool = probeTool(["bun"], async () => ({ status: "ran", output: "" }));
    for (let i = 0; i < PROBE_TRIES; i += 1)
      expect(((await tool.execute({ executable: "bun", args: [] })) as { status: string }).status).toBe("ran");
    expect(((await tool.execute({ executable: "bun", args: [] })) as { status: string }).status).toBe("refused");
  });

  test("only the implementer profile offers it", () => {
    const withProbe = builtinProfiles.filter((p) => p.allowedTools.includes("run_probe"));
    expect(withProbe.map((p) => p.id)).toEqual(["implementer"]);
  });

  test("documentation writes are recognized by name and extension", () => {
    const writes = (path: string, action = "modify") => [{ path, action }];
    expect(writesDocumentation(writes("README.md"))).toBe(true);
    expect(writesDocumentation(writes("readme"))).toBe(true);
    expect(writesDocumentation(writes("docs\\usage.rst", "create"))).toBe(true);
    expect(writesDocumentation(writes("src/app.ts"))).toBe(false);
    expect(writesDocumentation(writes("src/readme.ts.bak/x.go"))).toBe(false);
    expect(writesDocumentation(writes("README.md", "delete"))).toBe(false);
  });
});
