import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { plannerSizing, sizePlan } from "../src/core/workflows/sizing.js";
import { hostContentProblems, hostFileProblems, hostWritten } from "../src/core/workflows/task-graph.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 40, tonemath core (run 582ea7b5, #1460): the brief fixed 20 module files that hold
// one comment line and a lib.rs of their 20 `pub mod` lines. Sizing priced every stub as code and
// the planner's Rust rule made each task register its module, so the plan had 20 one-file tasks
// "Create and register X" that cost 2.58M tokens (14% of the initiative) and wrote lib.rs 28
// times. A write that carries its content is now written by the host: one task, no agent attempt.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const modules = Array.from({ length: 20 }, (_, i) => `m${String(i).padStart(2, "0")}`);
const libRs = modules.map((m) => `pub mod ${m};`).join("\n") + "\n";
const stub = (m: string) => `// ${m}: filled by its owning feature.\n`;
const skeletonWrites = [
  ...modules.map((m) => ({ path: `src/${m}.rs`, action: "create" as const, content: stub(m) })),
  { path: "src/lib.rs", action: "create" as const, content: libRs },
];
const base = { requirementIds: ["FR-001"], criterionIds: ["AC-001"], profileId: "implementer", readHints: [], origin: "planned" as const, findingIds: [], rationale: "Required behavior" };
const skeleton: Task = { ...base, id: "T001", title: "Lay down the crate skeleton", description: "Module stubs and lib.rs", dependsOn: [], writes: skeletonWrites, checkIds: ["layout"] };
const value: Task = { ...base, id: "T002", title: "Create value", description: "Write ready", dependsOn: ["T001"], writes: [{ path: "value.txt", action: "create" }], checkIds: [] };

// A task check that the skeleton compiles in the sense the crate needs: every declared module
// exists and lib.rs declares exactly the 20 modules.
const layout = `const fs = require("node:fs"); const lines = fs.readFileSync("src/lib.rs", "utf8").trim().split("\\n"); if (lines.length !== 20) process.exit(1); for (const line of lines) { const m = /^pub mod (\\w+);$/.exec(line); if (!m || !fs.existsSync("src/" + m[1] + ".rs")) process.exit(1); }`;
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [...fixturePolicy.checks, { ...fixturePolicy.checks[0]!, id: "layout", args: ["-e", layout], scope: "task" }],
};

class SkeletonExecutor extends FixtureExecutor {
  implemented: string[] = [];
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nCrate skeleton, then value.\n## Decisions\nDEC-001: FR-001 fixes the module list.\n## Components\nsrc\n## Data\nNone\n## Verification\nlayout and check\n## Risks\nNone for fixture";
      const taskGraph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks: [skeleton, value] };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") this.implemented.push(request.task?.id ?? "");
    return super.execute(request);
  }
}

describe("scenario: tonemath core, a brief that fixes a 20-module skeleton (#1460)", () => {
  test("the host writes the stubs and lib.rs in one task with no agent attempt, and the run completes", async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new SkeletonExecutor(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    // Only the value task reached an implementer.
    expect(fixture.executor.implemented).toEqual(["T002"]);
    expect(readFileSync(join(fixture.root, "src/lib.rs"), "utf8")).toBe(libRs);
    for (const m of modules) expect(readFileSync(join(fixture.root, `src/${m}.rs`), "utf8")).toBe(stub(m));
    // Each file is one journaled edit of the run, so review, undo and delivery see it; lib.rs once.
    const store = fixture.service.store;
    const patched = store.effects(run.runId).filter((e) => e.kind === "file_patch").map((e) => (JSON.parse(e.intent_json) as { path: string }).path);
    expect(patched.filter((p) => p === "src/lib.rs")).toHaveLength(1);
    for (const w of skeletonWrites) expect(patched).toContain(w.path);
    // The skeleton task used no tokens.
    expect(store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("verified");
  }, 60000);
});

describe("sizing a host-written skeleton task (#1460)", () => {
  const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
  const sized: RunPolicy = { ...defaultWorkflowPolicy, maxTotalTokens: 800_000, sizing: { maxAttemptTokens: 600_000 } };

  test("20 stubs and lib.rs in one task cost nothing and are not oversized", () => {
    const report = sizePlan({ graph: graph(skeleton, value), policy: sized, samples: [], spent: 0 });
    // Like a task without writes, it gets no attempt to size.
    expect(report.tasks.map((t) => t.taskId)).toEqual(["T002"]);
    expect(report.decision).not.toBe("split-tasks");
    expect(plannerSizing(sized, []).note).toContain("written by the host and costs nothing");
  });

  test("the same stubs without content are priced as code and split", () => {
    const agent = { ...skeleton, writes: skeletonWrites.map(({ path, action }) => ({ path, action })) };
    const report = sizePlan({ graph: graph(agent, value), policy: sized, samples: [], spent: 0 });
    expect(report.tasks.find((t) => t.taskId === "T001")?.oversized).toBe(true);
    expect(report.decision).toBe("split-tasks");
  });

  test("a Python package of empty __init__.py files and a TypeScript barrel are host-written", () => {
    const python = { ...skeleton, writes: [{ path: "pkg/__init__.py", action: "create" as const, content: "" }, { path: "pkg/io/__init__.py", action: "create" as const, content: "" }] };
    const barrel = { ...skeleton, writes: [{ path: "src/index.ts", action: "create" as const, content: 'export * from "./parse.js";\n' }] };
    expect(hostWritten(python)).toBe(true);
    expect(hostWritten(barrel)).toBe(true);
    // One write without content, or any delete, keeps the task an agent task.
    expect(hostWritten({ writes: [...python.writes, { path: "pkg/io/read.py", action: "create" }] })).toBe(false);
    expect(hostWritten({ writes: [{ path: "old.py", action: "delete", content: "" }] })).toBe(false);
    expect(hostWritten({ writes: [] })).toBe(false);
    // A plan that mixes them is returned to the planner instead of ignoring the content.
    const mixed = { ...python, id: "T003", writes: [...python.writes, { path: "pkg/io/read.py", action: "create" as const }] };
    expect(hostContentProblems({ tasks: [python, barrel] })).toEqual([]);
    expect(hostContentProblems({ tasks: [mixed] })[0]).toContain("Task T003 gives content to pkg/__init__.py, pkg/io/__init__.py");
  });
});

describe("files a run must write in the host (#1461)", () => {
  const files = skeletonWrites.map(({ path, content }) => ({ path, content }));
  test("one host-written task with exactly the content satisfies them", () => {
    expect(hostFileProblems({ tasks: [skeleton, value] }, files)).toEqual([]);
    expect(hostFileProblems({ tasks: [value] }, null)).toEqual([]);
  });
  test("other content, two tasks, or another task creating one of them is a plan problem", () => {
    const changed = { ...skeleton, writes: skeletonWrites.map((w) => (w.path === "src/lib.rs" ? { ...w, content: "pub mod m00;\n" } : w)) };
    expect(hostFileProblems({ tasks: [changed, value] }, files)[0]).toContain("src/lib.rs is not written that way");
    const halves = [
      { ...skeleton, writes: skeletonWrites.slice(0, 10) },
      { ...skeleton, id: "T003", writes: skeletonWrites.slice(10) },
    ];
    expect(hostFileProblems({ tasks: halves }, files)[0]).toContain("write all of them in one task");
    const creator = { ...value, id: "T004", writes: [{ path: "src/m00.rs", action: "create" as const }] };
    expect(hostFileProblems({ tasks: [skeleton, creator] }, files)).toEqual([
      "Task T004 creates a file of extra.hostFiles; the host-written task creates it, so modify it after that task instead.",
    ]);
  });
});
