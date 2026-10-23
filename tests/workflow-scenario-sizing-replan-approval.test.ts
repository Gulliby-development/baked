import { afterEach, describe, expect, test } from "bun:test";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { agentTaskCount, evaluateAutoApproval, planScopeAdvice } from "../src/core/workflows/auto-approval.js";
import { featurePolicy } from "../src/core/workflows/initiatives/service.js";
import { InitiativeSettingsSchema } from "../src/core/workflows/initiatives/store.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R49 (#1627): sizing asks the planner to create slices and the next planning pass loses the
// host's task-count exemption. The same replacement is submitted whole or as a patch.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const markdown = "# Plan\n## Context\nValues\n## Decisions\nDEC-001: FR-001 needs values.\n## Components\nsrc/sim.ts, src/rates.ts, src/main.ts and value files\n## Data\nText\n## Verification\nCheck values\n## Risks\nNone for fixture";
const task = (id: string, paths: string[]): Task => ({
  id, title: `Create ${paths.join(", ")}`, description: `Create ${paths.join(", ")}`,
  requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [],
  checkIds: ["check"], origin: "planned", findingIds: [], rationale: "Required behavior",
});
const code = ["src/sim.ts", "src/rates.ts", "src/main.ts"];
const values = ["value-0.txt", "value-1.txt", "value-2.txt"];
const initial = (count: number) => [task("T001", code), ...Array.from({ length: count - 1 }, (_, i) => {
  const own = task(`T${String(i + 2).padStart(3, "0")}`, [values[Math.min(i, 2)]!]);
  if (i > 2) {
    own.writes[0]!.action = "modify";
    own.dependsOn = [`T${String(i + 1).padStart(3, "0")}`];
  }
  return own;
})];

class ScriptedExecutor extends FixtureExecutor {
  plans = 0;
  revisions = 0;
  analyses = 0;
  sizingNotes: string[] = [];
  analysisSizing: ({ note: string } | null)[] = [];
  constructor(root: string, private count: number, private stop: AbortController, private outside: boolean, private hostTests: boolean, private unrelated: boolean, private marker = false) { super(root); }

  override async execute(request: ExecutionRequest) {
    const output = request.profile.output;
    if (output === "analysis") this.analysisSizing.push(JSON.parse(request.prompt.split("\n").at(-1) ?? "{}").extra?.sizing ?? null);
    if (output === "analysis" && ++this.analyses === 2 && this.unrelated) {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}");
      return { output: {
        schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision",
        findings: [{ id: "F1", kind: "inconsistency", refs: ["plan.md"], description: "The plan must describe corrupt input in its Risks section", blocking: true }],
      }, inputTokens: 25, outputTokens: 25 };
    }
    if (output === "plan" || output === "revision") {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}");
      if (output === "revision") {
        this.revisions++;
        this.sizingNotes.push(data.extra.revision.findings[0].description);
        return { output: { schemaVersion: 1, operations: [{ op: "set", path: "taskGraph/tasks", value: this.slices() }] }, inputTokens: 25, outputTokens: 25 };
      }
      this.plans++;
      if (this.plans > 1) this.sizingNotes.push(request.prompt);
      const taskGraph: TaskGraph = {
        schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
        tasks: this.plans === 1 ? this.original() : this.slices(),
      };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    // Approval is the assertion boundary. Stop before any implementation changes the fixture.
    if (output === "implementation") {
      this.stop.abort();
      throw new DOMException("Stopped after approval", "AbortError");
    }
    return super.execute(request);
  }

  private original() {
    const tasks = initial(this.count);
    if (this.hostTests) tasks[1] = task("T002", ["tests/a.test.ts", "tests/b.test.ts"]);
    // An empty package marker the host writes from its content: no agent attempt, no tokens (#1658).
    if (this.marker) tasks.push({ ...task("T100", []), title: "Create package initializer", writes: [{ path: "src/__init__.py", action: "create", content: "" }] });
    return tasks;
  }

  private slices() {
    return [
      ...this.original().map((t, i) => i === 0 ? task(t.id, [code[0]!]) : this.hostTests && i === 1 ? task(t.id, ["tests/a.test.ts"]) : t),
      task(`T${String(this.count + 1).padStart(3, "0")}`, [code[1]!]),
      task(`T${String(this.count + 2).padStart(3, "0")}`, [this.outside ? "outside.txt" : code[2]!]),
      ...(this.hostTests ? [task(`T${String(this.count + 3).padStart(3, "0")}`, ["tests/b.test.ts"])] : []),
    ];
  }
}

async function scenario(revision?: "patch", initiative = false, count = 8, outside = false, hostTests = false, unrelated = false, marker = false) {
  const controller = new AbortController();
  const base: RunPolicy = {
    ...fixturePolicy, revision, clarification: "assume", sizing: { maxAttemptTokens: 10_000 },
    checks: [{ ...fixturePolicy.checks[0]!, args: ["--version"] }],
    autoApproval: { renewal: false, limits: { maxTasks: 8, maxFiles: 20, allowedPaths: ["src/**", "tests/**", "value-*.txt"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens } },
  };
  const settings = InitiativeSettingsSchema.parse({ workflowId: "sdd", basePolicy: base, featureAutoApproval: { maxTasks: 8, maxFiles: 20 }, budget: null, model: null, ownerLabel: "test" });
  // Literal paths keep boundaryLimits at 8 tasks; a glob would raise the limit to 500.
  const policy = initiative ? featurePolicy(settings, { tokens: 2_000_000, calls: 200, activeMs: 3_600_000 }, {
    id: "fixture", title: "Values", boundary: { scope: "Values", paths: [...code, ...values, ...(marker ? ["src/__init__.py"] : [])] }, contract: "Values exist", dependsOn: [], mandatory: true,
  }, false) : base;
  // Several tasks share each boundary path, so the feature still has eight tasks before sizing.
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, count, controller, outside, hostTests, unrelated, marker) });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, controller.signal);
  const store = fixture.service.store;
  const approval = store.requests(run.runId).find((r) => r.kind === "approval");
  const report = store.latestArtifact(run.runId, "sizing/plan-0.json");
  expect(report).toBeDefined();
  expect(JSON.parse(store.readArtifact(run.runId, report!.id)).decision).toBe("split-tasks");
  expect(store.state(run.runId).graph?.tasks).toHaveLength(count + (hostTests ? 3 : 2) + (marker ? 1 : 0));
  if (hostTests) {
    const first = store.artifacts(run.runId).find((a) => a.logical_path === "tasks.json");
    expect(JSON.parse(store.readArtifact(run.runId, first!.id)).tasks).toHaveLength(count + 1);
  }
  return { fixture, approval, body: JSON.parse(approval?.body_json ?? "{}"), state: store.state(run.runId) };
}

describe("scenario: a sizing replan preserves the approval task count (#1627)", () => {
  for (const revision of [undefined, "patch"] as const) {
    test(`eight planned tasks become ten and retain limits approval, revision=${revision ?? "full"}`, async () => {
      const { fixture, approval, body, state } = await scenario(revision);
      expect(body.autoApproval.declined ?? []).toEqual([]);
      expect(approval).toMatchObject({ status: "accepted", actor: "auto-approval" });
      expect(body.autoApproval.mode).toBe("limits");
      expect(state.hostSplitTasks).toBe(2);
      expect(state.sizingPlannedTasks).toBeNull();
      expect(fixture.executor.plans).toBe(revision ? 1 : 2);
      expect(fixture.executor.revisions).toBe(revision ? 1 : 0);
      expect(fixture.executor.sizingNotes[0]).toContain("at most 8 planned tasks");
      // The analysis of the re-plan can check what the planner quotes from its sizing note (#1930).
      expect(fixture.executor.analysisSizing[0]).toBeNull();
      expect(fixture.executor.analysisSizing.at(-1)?.note).toContain("Keep each code task to at most");
    });

    test(`host test splits are still excluded when the planner takes over, revision=${revision ?? "full"}`, async () => {
      const { approval, body, state } = await scenario(revision, false, 8, false, true);
      expect(body.autoApproval.declined ?? []).toEqual([]);
      expect(approval).toMatchObject({ status: "accepted", actor: "auto-approval" });
      expect(body.autoApproval.mode).toBe("limits");
      expect(state.hostSplitTasks).toBe(3);
    });
  }

  test("a plan already above the limit still needs a person after sizing", async () => {
    const { approval, body } = await scenario(undefined, false, 9);
    expect(approval?.status).toBe("pending");
    expect(body.autoApproval.declined).toContain("Limits: 9 tasks exceed 8 (2 added for sizing not counted)");
  });

  for (const revision of [undefined, "patch"] as const) {
    test(`an initiative feature retains tiered approval after sizing, revision=${revision ?? "full"}`, async () => {
      const { approval, body } = await scenario(revision, true);
      expect(body.autoApproval.declined ?? []).toEqual([]);
      expect(approval).toMatchObject({ status: "accepted", actor: "auto-approval" });
      expect(body.autoApproval.mode).toBe("limits");
    });
  }

  test("a sizing slice outside the allowed paths still needs a person", async () => {
    const { approval, body } = await scenario("patch", false, 8, true);
    expect(approval?.status).toBe("pending");
    expect(body.autoApproval.declined).toContain("Limits: outside.txt is outside the allowed paths");
  });

  // R51 (#1711): url-shortener's third planning pass cleared the allowance and the same graph
  // that passed on pass 2 was declined with "9 tasks exceed 8".
  test("a later replan of the same graph keeps the sizing allowance, so every pass decides the same", async () => {
    const { fixture, approval, body, state } = await scenario(undefined, false, 8, false, false, true);
    expect(fixture.executor.plans).toBe(3);
    expect(body.autoApproval.declined ?? []).toEqual([]);
    expect(approval).toMatchObject({ status: "accepted", actor: "auto-approval" });
    expect(state.hostSplitTasks).toBe(2);
  });
});

// R50, expenses-py (#1658): eight agent tasks and an empty `__init__.py` the host writes were
// declined as "9 tasks exceed 8", and the plan waited 11.3 h for a person.
describe("scenario: host-written tasks do not count against the task limit (#1658)", () => {
  for (const revision of [undefined, "patch"] as const) {
    test(`eight agent tasks and an empty package marker keep limits approval, revision=${revision ?? "full"}`, async () => {
      const { approval, body } = await scenario(revision, false, 8, false, false, false, true);
      expect(body.autoApproval.declined ?? []).toEqual([]);
      expect(approval).toMatchObject({ status: "accepted", actor: "auto-approval" });
      expect(body.autoApproval.mode).toBe("limits");
    });
  }

  test("an initiative feature with a package marker keeps tiered approval", async () => {
    const { approval, body } = await scenario("patch", true, 8, false, false, false, true);
    expect(body.autoApproval.declined ?? []).toEqual([]);
    expect(approval).toMatchObject({ status: "accepted", actor: "auto-approval" });
  });

  test("nine agent tasks still need a person, and the reason says the marker was not counted", async () => {
    const { approval, body } = await scenario(undefined, false, 9, false, false, false, true);
    expect(approval?.status).toBe("pending");
    expect(body.autoApproval.declined).toContain("Limits: 9 tasks exceed 8 (2 added for sizing, 1 host-written not counted)");
  });

  test("the planner's advice counts agent tasks only", () => {
    const policy: RunPolicy = {
      ...fixturePolicy,
      autoApproval: { renewal: false, limits: { maxTasks: 8, maxFiles: 20, allowedPaths: ["src/**", "value-*.txt"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens } },
    };
    const marker: Task = { ...task("T100", []), writes: [{ path: "src/__init__.py", action: "create", content: "" }] };
    const graph = (count: number): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a", planHash: "b", tasks: [...initial(count), marker] });
    expect(agentTaskCount(graph(8))).toEqual({ agent: 8, host: 1, slices: 0 });
    expect(planScopeAdvice(policy, graph(8))).toEqual([]);
    expect(planScopeAdvice(policy, graph(9))[0]).toContain("9 tasks exceed 8 (1 host-written not counted)");
  });
});

// R51 (#1711): url-shortener (13 tasks in 8 planned ones) and md-site (14 tasks in 7) waited for a
// person, while expenses-py with the same shape passed, because slices counted by pass history.
describe("scenario: sizing slices of one planned task count once (#1711)", () => {
  const limits = { maxTasks: 8, maxFiles: 40, allowedPaths: ["**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens };
  const policy: RunPolicy = { ...fixturePolicy, autoApproval: { renewal: false, limits } };
  const graphOf = (tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a", planHash: "b", tasks });
  const slices = (from: string, path: string, count: number, firstId: number): Task[] =>
    Array.from({ length: count }, (_, index) => ({
      ...task(index === 0 ? from : `T${String(firstId + index).padStart(3, "0")}`, [path]),
      sizingSlice: { taskId: from, index, count, share: 1 / count },
    }));
  const plain = (count: number, first = 1) => Array.from({ length: count }, (_, i) => task(`T${String(first + i).padStart(3, "0")}`, [`src/m${first + i}.ts`]));
  // url-shortener: 5 code tasks and three test tasks cut into 3, 2 and 3 slices.
  const urlShortener = graphOf([...plain(5), ...slices("T006", "tests/a.test.ts", 3, 20), ...slices("T007", "tests/b.test.ts", 2, 30), ...slices("T008", "tests/c.test.ts", 3, 40)]);
  // md-site: 4 plain tasks, a group of 4, a group of 5 and the docs task.
  const mdSite = graphOf([...plain(4), ...slices("T005", "tests/render.test.ts", 4, 20), ...slices("T006", "tests/parse.test.ts", 5, 30), task("T007", ["README.md"])]);
  // A part the host cut by file names its task in its note even without a slice record.
  const byFile = graphOf([...plain(7), task("T008", ["tests/x.test.ts"]), { ...task("T009", ["tests/y.test.ts"]), description: "Tests\nSizing split this task by file: write only tests/y.test.ts; tests/x.test.ts belong to the other parts of T008." }]);

  test("the recorded R51 shapes are within a limit of 8, whatever the pass", () => {
    expect(urlShortener.tasks).toHaveLength(13);
    expect(agentTaskCount(urlShortener)).toEqual({ agent: 8, host: 0, slices: 5 });
    expect(mdSite.tasks).toHaveLength(14);
    expect(agentTaskCount(mdSite)).toEqual({ agent: 7, host: 0, slices: 7 });
    expect(agentTaskCount(byFile)).toEqual({ agent: 8, host: 0, slices: 1 });
    for (const graph of [urlShortener, mdSite, byFile]) {
      expect(planScopeAdvice(policy, graph)).toEqual([]);
      expect(evaluateAutoApproval(policy, {} as Parameters<typeof evaluateAutoApproval>[1], fixtureSpec, graph, [], []).reasons.join("\n")).not.toContain("tasks exceed");
    }
  });

  test("nine distinct planned tasks are still declined, and the reason names the slices left out", () => {
    const nine = graphOf([...plain(9), ...slices("T010", "tests/z.test.ts", 3, 20)]);
    expect(planScopeAdvice(policy, nine)[0]).toContain("10 tasks exceed 8 (2 sizing slices not counted)");
    expect(planScopeAdvice(policy, graphOf(plain(9)))[0]).toContain("9 tasks exceed 8");
  });
});
