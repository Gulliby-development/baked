import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../src/core/specs/hash.js";
import { changeReach, readsChangedFile } from "../src/core/workflows/invalidation.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const task = (id: string, writes: string[], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: writes.map((path) => ({ path, action: "modify" as const })),
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});

describe("readsChangedFile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });
  const workspace = (files: Record<string, string>) => {
    const root = join(process.env.TEMP ?? "/tmp", `baked-inval-${crypto.randomUUID()}`);
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  test("a task that writes or hints the changed file reads it", () => {
    const root = workspace({});
    const changed = new Set(["src/diff.ts"]);
    expect(readsChangedFile(root, task("T2", ["src/diff.ts"]), changed)).toBe(true);
    expect(readsChangedFile(root, task("T2", [], { readHints: ["src/diff.ts"] }), changed)).toBe(
      true,
    );
  });

  test("a written file that imports the changed one reads it; one that does not, does not", () => {
    const root = workspace({
      "tests/diff.test.ts": 'import { diff } from "../src/diff.js";\n',
      "src/cli.ts": 'import { parse } from "./parse.js";\nimport { test } from "bun:test";\n',
    });
    const changed = new Set(["src/diff.ts"]);
    expect(readsChangedFile(root, task("T3", ["tests/diff.test.ts"]), changed)).toBe(true);
    expect(readsChangedFile(root, task("T4", ["src/cli.ts"]), changed)).toBe(false);
  });

  test("python modules are matched by dotted name", () => {
    const root = workspace({
      "tests/test_x.py": "from pkg.diff import diff\n",
      "tests/test_y.py": "from pkg.other import other\n",
    });
    const changed = new Set(["src/pkg/diff.py"]);
    expect(readsChangedFile(root, task("T3", ["tests/test_x.py"]), changed)).toBe(true);
    expect(readsChangedFile(root, task("T4", ["tests/test_y.py"]), changed)).toBe(false);
  });

  test("a file the scan cannot read counts as touching the change", () => {
    const root = workspace({ "config/a.json": "{}" });
    expect(readsChangedFile(root, task("T5", ["config/a.json"]), new Set(["src/diff.ts"]))).toBe(true);
    expect(changeReach(root, task("T5", ["config/a.json"]), new Set(["src/diff.ts"]))).toBe("unknown");
  });

  // R5: md-site T004/T005 and expenses-py A T003/T005 reran for 280k and ended already_satisfied.
  test("a documentation writer is reached only by a file in its writes or read hints", () => {
    const root = workspace({ "README.md": "text", "docs/usage.md": "text" });
    const changed = new Set(["src/diff.ts"]);
    expect(changeReach(root, task("T6", ["README.md", "docs/usage.md"]), changed)).toBe("none");
    expect(changeReach(root, task("T6", ["README.md"], { readHints: ["src/diff.ts"] }), changed)).toBe("named");
    expect(changeReach(root, task("T6", ["README.md"]), new Set(["README.md"]))).toBe("named");
  });

  test("a task reached only through an import is told apart from one that names the file", () => {
    const root = workspace({ "tests/diff.test.ts": 'import { diff } from "../src/diff.js";\n' });
    const changed = new Set(["src/diff.ts"]);
    expect(changeReach(root, task("T3", ["tests/diff.test.ts"]), changed)).toBe("imports");
    expect(changeReach(root, task("T3", ["tests/diff.test.ts"], { readHints: ["src/diff.ts"] }), changed)).toBe("named");
  });
});

// jsondelta 9fbc18e7: a repair of one function in src/diff.ts restored T001 and invalidated T002,
// T003 and T004, whose reruns cost 494k of 1.94M tokens.
describe("a repair task restoring its predecessor", () => {
  async function scenario(changed: string[] | null, withChecks = false, dependents: Task[] = [], checks: RunPolicy["checks"] = []) {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, root } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    const store = service.store;
    const state = store.state(run.runId);
    const base = state.graph?.tasks[0];
    if (!base || !state.graph) throw new Error("no graph");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/a.test.ts"), 'import { x } from "../src/diff.js";\n');
    writeFileSync(join(root, "src/cli.ts"), 'import { y } from "./parse.js";\n');
    const t1 = { ...base, id: "T001", writes: [{ path: "src/diff.ts", action: "modify" as const }] };
    const t2 = task("T002", ["tests/a.test.ts"], { dependsOn: ["T001"], checkIds: withChecks ? ["unit"] : [] });
    const t3 = task("T003", ["src/cli.ts"], { dependsOn: ["T001"] });
    const t4 = task("T004", ["src/diff.ts"], {
      origin: "repair",
      findingIds: ["F1"],
      checkIds: [],
    });
    state.graph = { ...state.graph, tasks: [t1, t2, t3, t4, ...dependents] };
    state.repairPredecessors = { F1: "T001" };
    state.taskGates = {};
    store.transaction(() => {
      const snapshot = store.putSnapshot(run.runId, {}).id;
      store.syncTasks(run.runId, state.graph as never);
      for (const id of ["T001", "T002", "T003", ...dependents.map((d) => d.id)]) store.taskStatus(run.runId, id, "implemented", snapshot);
      store.taskStatus(run.runId, "T001", "invalidated");
      store.taskStatus(run.runId, "T004", "implemented", snapshot);
      if (changed)
        store.artifact(run.runId, "diff", "tasks/T004/diff.json", canonical({ changed }));
      store.saveState(run.runId, state);
    });
    const child = store.beginStep(run.runId, "task-T004", null);
    const scheduler = service.scheduler as unknown as {
      settleTask(...args: unknown[]): void;
    };
    const policy = JSON.parse(store.run(run.runId).policy_json) as RunPolicy;
    policy.checks = [...policy.checks, ...checks];
    if (withChecks)
      policy.checks = [...policy.checks, { id: "unit", executable: "bun", args: ["-e", "0"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] }];
    scheduler.settleTask(run.runId, state, policy, t4, child, [], ["E1"]);
    return { store, runId: run.runId, state };
  }
  const statuses = (store: { tasks(id: string): { id: string; status: string }[] }, runId: string) =>
    Object.fromEntries(store.tasks(runId).map((t) => [t.id, t.status]));

  test("only the dependent that reads the changed file is invalidated; the other reruns its checks", async () => {
    const { store, runId, state } = await scenario(["src/diff.ts"]);
    expect(statuses(store, runId)).toMatchObject({
      T001: "implemented",
      T002: "invalidated",
      T003: "implemented",
    });
    expect(state.taskGates.T003).toBeUndefined();
  });

  test("a dependent reached only through an import reruns its checks first when it has task checks", async () => {
    const { store, runId, state } = await scenario(["src/diff.ts"], true);
    expect(statuses(store, runId)).toMatchObject({ T002: "implemented", T003: "implemented" });
    expect(state.taskGates.T002).toBeUndefined();
  });

  // R6 md-site a586cde0: corrections rewrote src/site.ts and src/cli.ts, then their planned owner
  // T003 ran again from its original description, three times in all.
  test("a dependent whose every written file the repair rewrote is superseded and only rechecked", async () => {
    const owner = task("T005", ["src/diff.ts"], { dependsOn: ["T001"], checkIds: ["unit"] });
    const { store, runId, state } = await scenario(["src/diff.ts"], true, [owner]);
    expect(statuses(store, runId)).toMatchObject({ T005: "implemented" });
    expect(state.taskGates.T005).toBeUndefined();
  });

  // R9 propdrift 90c09da7: a test task whose only check is the feature-scope `verify` reran with
  // its agent (114k) after a repair rewrote its one file.
  test("a dependent whose only declared check is feature-scope is superseded too", async () => {
    const owner = task("T005", ["src/diff.ts"], { dependsOn: ["T001"], checkIds: ["verify"] });
    const verify = { id: "verify", executable: "mvn", args: ["verify"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [] };
    const { store, runId } = await scenario(["src/diff.ts"], false, [owner], [verify]);
    expect(statuses(store, runId)).toMatchObject({ T005: "implemented" });
  });

  test("a dependent that writes more than the repair rewrote is still invalidated", async () => {
    const owner = task("T005", ["src/diff.ts", "src/other.ts"], { dependsOn: ["T001"], checkIds: ["unit"] });
    const { store, runId } = await scenario(["src/diff.ts"], true, [owner]);
    expect(statuses(store, runId)).toMatchObject({ T005: "invalidated" });
  });

  test("a dependent without task checks is invalidated even when the repair rewrote its files", async () => {
    const owner = task("T005", ["src/diff.ts"], { dependsOn: ["T001"], checkIds: [] });
    const { store, runId } = await scenario(["src/diff.ts"], true, [owner]);
    expect(statuses(store, runId)).toMatchObject({ T005: "invalidated" });
  });

  test("without the repair's diff every dependent is invalidated", async () => {
    const { store, runId } = await scenario(null);
    expect(statuses(store, runId)).toMatchObject({ T002: "invalidated", T003: "invalidated" });
  });
});
