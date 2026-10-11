import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../src/core/specs/hash.js";
import { readsChangedFile } from "../src/core/workflows/invalidation.js";
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
    const root = workspace({ "docs/a.md": "text" });
    expect(readsChangedFile(root, task("T5", ["docs/a.md"]), new Set(["src/diff.ts"]))).toBe(true);
  });
});

// jsondelta 9fbc18e7: a repair of one function in src/diff.ts restored T001 and invalidated T002,
// T003 and T004, whose reruns cost 494k of 1.94M tokens.
describe("a repair task restoring its predecessor", () => {
  async function scenario(changed: string[] | null) {
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
    const t2 = task("T002", ["tests/a.test.ts"], { dependsOn: ["T001"] });
    const t3 = task("T003", ["src/cli.ts"], { dependsOn: ["T001"] });
    const t4 = task("T004", ["src/diff.ts"], {
      origin: "repair",
      findingIds: ["F1"],
      checkIds: [],
    });
    state.graph = { ...state.graph, tasks: [t1, t2, t3, t4] };
    state.repairPredecessors = { F1: "T001" };
    state.taskGates = {};
    store.transaction(() => {
      const snapshot = store.putSnapshot(run.runId, {}).id;
      store.syncTasks(run.runId, state.graph as never);
      for (const id of ["T001", "T002", "T003"]) store.taskStatus(run.runId, id, "implemented", snapshot);
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
    scheduler.settleTask(run.runId, state, JSON.parse(store.run(run.runId).policy_json) as RunPolicy, t4, child, [], ["E1"]);
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

  test("without the repair's diff every dependent is invalidated", async () => {
    const { store, runId } = await scenario(null);
    expect(statuses(store, runId)).toMatchObject({ T002: "invalidated", T003: "invalidated" });
  });
});
