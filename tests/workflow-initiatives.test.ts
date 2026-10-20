import { expectRecovery } from "./helpers/workflow-remedies.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  applySplitEdit,
  boundaryPathCounts,
  featureDigest,
  type InitiativePlan,
  literalPathCount,
  MAX_MERGED_PATHS,
  mergeSmallSiblings,
  planSizeProblem,
  planStructureProblems,
  sequenceSharedPaths,
  topologicalOrder,
  validateInitiativePlan,
} from "../src/core/workflows/initiatives/plan.js";
import {
  featureApprovalDeclined,
  featurePolicy,
  type InitiativeSettings,
  type InitiativeStartRequest,
  InitiativeService,
  type InitiativeView,
  initiativeCostTolerance,
  runFeatureId,
} from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { RoutingRecordSchema } from "../src/core/llm/model-routing.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import {
  executeInitiativeCommand,
  initiativeExit,
  initiativeHelp,
  parseInitiativeArgs,
} from "../src/headless/workflow-initiative.js";
import { workflowHelp } from "../src/headless/workflow-parse.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { mergedBase } from "../src/core/workflows/worktree.js";
import { PLACEHOLDER_SHARE } from "../src/core/workflows/initiatives/estimate.js";
import {
  assignFeatureWorkflows,
  lightenSmallLeaves,
  planWorkflowProblems,
  restoreContractWorkflows,
  withLightContract,
} from "../src/core/workflows/initiatives/workflows.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const feature = (id: string, dependsOn: string[] = [], paths: string[] = [`${id}.txt`]) => ({
  id,
  title: `Feature ${id}`,
  boundary: { scope: `Everything about ${id}`, paths },
  contract: `${id}.txt holds the value of ${id}`,
  dependsOn,
  mandatory: true,
});
const plan = (features: InitiativePlan["features"]): InitiativePlan => ({
  schemaVersion: 1,
  title: "Values",
  goals: ["Every value exists"],
  completionCriteria: ["Each value file is ready"],
  features,
});
const threeFeatures = plan([feature("core"), feature("api", ["core"]), feature("docs")]);

const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  maxTotalTokens: 100000,
  maxAgentCalls: 40,
  checks: [{ id: "check", executable: "bun", args: ["-e", "0"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }],
};

/**
 * A deterministic stand-in for every agent: the decomposer returns `split`, the spec of a feature
 * carries `contracts[feature]` in its outcome (so a test can change an upstream contract), and
 * the implementer writes FEATURE.txt.
 */
class InitiativeExecutor implements AgentExecutor {
  calls: string[] = [];
  contracts: Record<string, string> = {};
  /** Extra path a feature's plan writes, to step outside its boundary. */
  extraWrites: Record<string, string> = {};
  /** Further files a feature's plan writes, one task each. */
  extraTasks: Record<string, string[]> = {};
  writes: Record<string, number> = {};
  /** Models whose implementation calls fail as an account without credits. */
  refused = new Set<string>();
  /** What a refused model says. */
  refusal = "You have no credits remaining. Add credits to continue.";
  /** The files in each feature's root when it was implemented. */
  seen: Record<string, string[]> = {};
  /** Implementation calls in flight, and the most at once. */
  active = 0;
  maxActive = 0;
  /** An implementation waits (up to `rendezvousMs`) until this many implementations have begun. */
  rendezvous = 0;
  rendezvousMs = 5000;
  private arrived = 0;
  /** When set, each call records its tokens as priced usage, as the agent executor does. */
  usageStore: WorkflowStore | null = null;
  constructor(private root: string, public split: unknown = threeFeatures, public tokens = 100) {}
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    const implementing = request.profile.output === "implementation";
    if (implementing) {
      this.maxActive = Math.max(this.maxActive, ++this.active);
      this.arrived++;
    }
    try {
      const deadline = Date.now() + this.rendezvousMs;
      while (implementing && this.arrived < this.rendezvous && Date.now() < deadline) await Bun.sleep(5);
      return this.respond(request);
    } finally {
      if (implementing) this.active--;
    }
  }
  private respond(request: ExecutionRequest) {
    const root = request.root ?? this.root;
    if (this.refused.has(request.profile.model) && request.profile.output === "implementation")
      throw Object.assign(new Error(this.refusal), { statusCode: 429 });
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      inputHash: string; snapshotHash: string; spec: Spec | null;
      extra: { evidence?: { id: string }[]; featureId?: string };
    };
    const key = (featureId: string) => featureId.split("_").at(-1) ?? featureId;
    let output: unknown;
    switch (request.profile.output) {
      case "initiativePlan":
        output = this.split;
        break;
      case "research":
        output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: [] };
        break;
      case "spec": {
        const featureId = data.extra.featureId ?? "";
        const spec: Spec = {
          schemaVersion: 1, featureId, revision: 1, title: `Spec ${key(featureId)}`, problem: "Missing value",
          outcome: `Value exists (${this.contracts[key(featureId)] ?? "v1"})`,
          inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [],
          requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }],
          criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }],
          // The host replaces these with the initiative's pins.
          dependencies: [],
        };
        output = spec;
        break;
      }
      case "plan": {
        const spec = data.spec as Spec;
        const name = key(spec.featureId);
        const path = `${name}.txt`;
        const markdown = `# Plan\n## Context\nCreate ${path}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${path}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        const writes = [{ path, action: existsSync(join(root, path)) ? "modify" : "create" }];
        const extra = this.extraWrites[name];
        if (extra) writes.push({ path: extra, action: existsSync(join(root, extra)) ? "modify" : "create" });
        output = {
          schemaVersion: 1, markdown,
          taskGraph: {
            schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
            tasks: [path, ...(this.extraTasks[name] ?? [])].map((file, i) => ({ id: `T${String(i + 1).padStart(3, "0")}`, title: `Create ${file}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: i ? [{ path: file, action: existsSync(join(root, file)) ? "modify" : "create" }] : writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" })),
          },
        };
        break;
      }
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      case "implementation": {
        const name = request.task?.writes[0]?.path.replace(".txt", "") ?? "";
        this.seen[name] = readdirSync(root).filter((f) => f.endsWith(".txt")).sort();
        for (const write of request.task?.writes ?? []) {
          // Each write changes the file, as a rebased feature adapts its result to the new contract.
          const count = (this.writes[write.path] = (this.writes[write.path] ?? 0) + 1);
          const version = this.contracts[write.path.replace(".txt", "")] ?? "v1";
          writeFileSync(join(root, write.path), `ready ${version}${count > 1 ? ` (write ${count})` : ""}`);
        }
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Command checked value" }], findings: [] };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    this.usageStore?.transaction(() =>
      this.usageStore?.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
        schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null, maxSteps: 10, maxTokens: 1_000_000,
        stopReason: "submitted", finalizedBy: null, totalTokens: this.tokens,
        steps: [{ step: 1, inputTokens: this.tokens / 2, outputTokens: this.tokens / 2, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
      })),
    );
    return { output, inputTokens: this.tokens / 2, outputTokens: this.tokens / 2 };
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A Git repository with one commit, for features that run in worktrees. */
function repository(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Values\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
}

function setup<E extends InitiativeExecutor = InitiativeExecutor>(
  split: unknown = threeFeatures,
  tokens = 100,
  make: (root: string) => E = (root) => new InitiativeExecutor(root, split, tokens) as E,
) {
  const root = mkdtempSync(join(tmpdir(), "baked-initiative-"));
  const executor = make(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } };
  const workflows = new NativeWorkflowService(root, config, executor);
  const initiatives = new InitiativeService(workflows);
  cleanups.push(() => {
    workflows.close();
    rmSync(root, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;
  const start = (extra: Partial<InitiativeStartRequest> = {}) =>
    initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Add the value files", policy, ownerLabel: "test", ...extra });
  const id = () => ({ commandId: newId(), expectedRevision: initiatives.view("values").revision });
  const approveSplit = () => {
    const view = initiatives.view("values");
    const request = view.pendingDecisions.find((d) => d.scope === "initiative");
    if (!request) throw new Error("No pending split approval");
    return initiatives.approve("values", id(), { requestId: request.requestId, digest: request.digest });
  };
  /** Approves the pending approval request of a feature's current run. */
  const approveFeature = async (featureId: string) => {
    const view = initiatives.view("values");
    const decision = view.pendingDecisions.find((d) => d.featureId === featureId && d.kind === "approval");
    if (!decision?.runId) throw new Error(`No pending approval for ${featureId}`);
    const run = await workflows.get(decision.runId);
    await workflows.decide(decision.runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "approve", requestId: decision.requestId, digest: decision.digest });
    return decision;
  };
  const drive = () => initiatives.drive("values", signal);
  const featureOf = (view: InitiativeView, featureId: string) => {
    const found = view.features.find((f) => f.id === featureId);
    if (!found) throw new Error(`Missing feature ${featureId}`);
    return found;
  };
  return { root, executor, workflows, initiatives, start, id, approveSplit, approveFeature, drive, featureOf };
}

describe("initiative plan", () => {
  test("features sharing a file are chained in plan order, unless already joined or already running (#1336)", () => {
    const lib = (id: string, dependsOn: string[] = []) => feature(id, dependsOn, [`src/${id}.rs`, "src/lib.rs"]);
    const split = plan([lib("core"), lib("hll", ["core"]), lib("frequent", ["core"]), lib("hist", ["core"]), feature("docs", [], ["docs/**"]), feature("readme", [], ["docs/guide.md"])]);
    const { plan: sequenced, added } = sequenceSharedPaths(split);
    expect(sequenced.features.map((f) => [f.id, f.dependsOn])).toEqual([
      ["core", []],
      ["hll", ["core"]],
      ["frequent", ["core", "hll"]],
      ["hist", ["core", "frequent"]],
      ["docs", []],
      ["readme", ["docs"]],
    ]);
    expect(added.map((a) => [a.featureId, a.dependsOn, a.paths])).toEqual([
      ["frequent", "hll", ["src/lib.rs"]],
      ["hist", "frequent", ["src/lib.rs"]],
      ["readme", "docs", ["docs/guide.md"]],
    ]);
    expect(planStructureProblems(sequenced)).toEqual([]);
    // A feature with a run keeps its dependencies; the input plan is not changed.
    expect(sequenceSharedPaths(split, new Set(["frequent"])).added.map((a) => [a.featureId, a.dependsOn])).toEqual([["hist", "frequent"], ["hist", "hll"], ["readme", "docs"]]);
    expect(split.features[2]?.dependsOn).toEqual(["core"]);
    // Two different globs are not compared.
    expect(sequenceSharedPaths(plan([feature("a", [], ["src/*.rs"]), feature("b", [], ["src/**"]), feature("c")])).added).toEqual([]);
  });

  test("validates the DAG: unique IDs, known dependencies, no cycles", () => {
    expect(planStructureProblems(threeFeatures)).toEqual([]);
    expect(planStructureProblems(plan([feature("a"), feature("a"), feature("b")]))).toContain("duplicate feature ID a");
    expect(planStructureProblems(plan([feature("a", ["x"]), feature("b"), feature("c")]))).toContain("a depends on unknown feature x");
    expect(planStructureProblems(plan([feature("a", ["a"]), feature("b"), feature("c")]))).toContain("a depends on itself");
    const cyclic = planStructureProblems(plan([feature("a", ["c"]), feature("b", ["a"]), feature("c", ["b"])]));
    expect(cyclic.some((p) => p.startsWith("dependency cycle: "))).toBe(true);
    expect(topologicalOrder(plan([feature("b", ["a"]), feature("a"), feature("c", ["b"])])).map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  test("keeps the split between 3 and 12 features and refuses a larger one with stages", () => {
    const many = (n: number) => plan(Array.from({ length: n }, (_, i) => feature(`f${i}`)));
    expect(planSizeProblem(many(3))).toBeNull();
    expect(planSizeProblem(many(12))).toBeNull();
    expect(planSizeProblem(many(13))).toContain("Split the request into stages");
    expect(planSizeProblem(many(2))).toContain("single workflow run");
    expect(validateInitiativePlan(many(13))).toHaveLength(1);
  });

  test("merge, split, remove and rename rewrite the dependency edges", () => {
    const four = plan([feature("a"), feature("b", ["a"]), feature("c", ["b"]), feature("d", ["a"])]);
    const merged = applySplitEdit(four, { op: "merge", featureIds: ["a", "b"], id: "ab", title: "A and B" });
    expect(merged.features.map((f) => f.id)).toEqual(["ab", "c", "d"]);
    expect(merged.features.find((f) => f.id === "c")?.dependsOn).toEqual(["ab"]);
    expect(merged.features.find((f) => f.id === "ab")?.boundary.paths).toEqual(["a.txt", "b.txt"]);
    const split = applySplitEdit(four, { op: "split", featureId: "b", into: [{ id: "b1", title: "B one" }, { id: "b2", title: "B two", paths: ["b2/**"] }] });
    expect(split.features.find((f) => f.id === "c")?.dependsOn).toEqual(["b1", "b2"]);
    expect(split.features.find((f) => f.id === "b2")?.dependsOn).toEqual(["a"]);
    const removed = applySplitEdit(four, { op: "remove", featureId: "d" });
    expect(removed.features).toHaveLength(3);
    expect(() => applySplitEdit(removed, { op: "remove", featureId: "c" })).toThrow("at least 3");
    expect(applySplitEdit(four, { op: "rename", featureId: "a", title: "Alpha" }).features[0]?.title).toBe("Alpha");
    expect(() => applySplitEdit(four, { op: "rename", featureId: "zz", title: "x" })).toThrow("Unknown feature zz");
  });
});

describe("initiative feature workflows", () => {
  test("workflow and size edits, and a merge keeps its largest part's workflow", () => {
    const four = plan([feature("a"), feature("b", ["a"]), feature("c"), feature("d")]);
    const withWorkflow = applySplitEdit(four, { op: "workflow", featureId: "c", workflow: "quick" });
    expect(withWorkflow.features.find((f) => f.id === "c")?.workflow).toBe("quick");
    const sized = applySplitEdit(withWorkflow, { op: "size", featureId: "d", size: "large" });
    expect(sized.features.find((f) => f.id === "d")?.size).toBe("large");
    const merged = applySplitEdit(sized, { op: "merge", featureIds: ["c", "d"], id: "cd" });
    expect(merged.features.find((f) => f.id === "cd")).toMatchObject({ size: "large" });
    expect(merged.features.find((f) => f.id === "cd")?.workflow).toBeUndefined();
    // A workflow change is a new run; a size change is not.
    expect(featureDigest(sized.features[2] ?? feature("x"))).not.toBe(featureDigest(four.features[2] ?? feature("x")));
    expect(featureDigest(sized.features[3] ?? feature("x"))).toBe(featureDigest(four.features[3] ?? feature("x")));
  });

  test("each feature gets the workflow that fits it, and a feature others depend on keeps a spec", async () => {
    const t = setup();
    let view = await t.start({ plan: threeFeatures });
    // docs is a small docs change with no dependents; core is depended on, so it needs a spec.
    expect(view.features.map((f) => [f.id, f.workflowId, f.size])).toEqual([
      ["core", "sdd", "medium"],
      ["api", "sdd", "medium"],
      ["docs", "quick", "small"],
    ]);
    await expect(t.initiatives.edit("values", t.id(), { op: "workflow", featureId: "core", workflow: "quick" })).rejects.toThrow("needs a workflow that writes a spec");
    await expect(t.initiatives.edit("values", t.id(), { op: "workflow", featureId: "docs", workflow: "nope" })).rejects.toThrow("cannot run a feature here");
    view = await t.initiatives.edit("values", t.id(), { op: "workflow", featureId: "api", workflow: "quick" });
    expect(t.featureOf(view, "api").workflowId).toBe("quick");
    await t.approveSplit();
    view = t.initiatives.view("values");
    // Shares follow size: medium 2, medium 2, small 1.
    const remaining = view.budget.remaining.tokens;
    expect(t.featureOf(view, "core").share?.tokens).toBe(Math.floor((remaining * 2) / 5));
    expect(t.featureOf(view, "docs").share?.tokens).toBe(Math.floor(remaining / 5));
    for (let i = 0; i < 12 && view.status !== "completed"; i++) {
      view = await t.drive();
      const waiting = view.pendingDecisions.find((d) => d.scope === "feature" && d.kind === "approval");
      if (waiting?.featureId) await t.approveFeature(waiting.featureId);
    }
    expect(view.status).toBe("completed");
    const workflowOf = (featureId: string) =>
      (JSON.parse(t.workflows.store.run(t.featureOf(view, featureId).runId ?? "").definition_json) as { id: string }).id;
    expect([workflowOf("core"), workflowOf("api"), workflowOf("docs")]).toEqual(["sdd", "quick", "quick"]);
    expect(t.featureOf(view, "docs").state).toBe("accepted");
  });

  test("the estimate re-forecasts as features are accepted (#1312)", async () => {
    // Bench round 32, notesift: the split's forecast said "fits" at 10.6M to 19.0M and the
    // initiative used 32.7M. Accepted features count at what they used; fewer than three
    // non-skeleton acceptances leave the remaining features on their planned estimates.
    const t = setup();
    let view = await t.start({ plan: threeFeatures });
    const before = t.initiatives.estimate("values");
    expect(before?.features.map((f) => [f.featureId, f.workflowId, f.size])).toEqual([
      ["core", "sdd", "medium"],
      ["api", "sdd", "medium"],
      ["docs", "quick", "small"],
    ]);
    expect(before?.basis).toBe("defaults");
    // Each feature's boundary paths go to the estimate (#1354).
    expect(before?.features.map((f) => f.paths)).toEqual([1, 1, 1]);
    expect(before?.budget.maxTotalTokens).toBe(view.budget.limits.maxTotalTokens);
    expect(before?.progress.accepted).toBe(0);
    await t.approveSplit();
    const spent = (featureId: string) => t.workflows.store.history().find((r) => r.runId === t.featureOf(view, featureId).runId)?.tokens ?? 0;
    for (let i = 0; i < 12 && t.featureOf(view, "core").state !== "accepted"; i++) {
      view = await t.drive();
      const waiting = view.pendingDecisions.find((d) => d.scope === "feature" && d.kind === "approval");
      if (waiting?.featureId) await t.approveFeature(waiting.featureId);
    }
    const middle = t.initiatives.estimate("values");
    const core = middle?.features.find((f) => f.featureId === "core");
    expect(core?.basis).toBe("measured");
    expect(core?.tokens).toEqual({ low: spent("core"), high: spent("core") });
    // The feature's spec says how many acceptance criteria it has.
    const coreRun = t.featureOf(view, "core").runId ?? "";
    expect(core?.criteria).toBe(t.workflows.store.state(coreRun).spec?.criteria.length);
    expect(middle?.progress.accepted).toBe(1);
    expect(middle?.progress.ratio).toBeNull();
    expect(middle?.progress.bySize).toEqual({});
    // Stage history still prices api's workflow using core, without applying a calibration ratio.
    const api = middle?.features.find((f) => f.featureId === "api");
    expect(api?.basis).toBe("workflow-history");
    expect((api?.tokens.low ?? 0) + (api?.tokens.high ?? 0)).toBeCloseTo(2 * spent("core"), -2);
    for (let i = 0; i < 12 && view.status !== "completed"; i++) {
      view = await t.drive();
      const waiting = view.pendingDecisions.find((d) => d.scope === "feature" && d.kind === "approval");
      if (waiting?.featureId) await t.approveFeature(waiting.featureId);
    }
    expect(view.status).toBe("completed");
    // Every feature accepted: the estimate is what the initiative used, with no margin left.
    const after = t.initiatives.estimate("values");
    expect(after?.features.map((f) => f.basis)).toEqual(["measured", "measured", "measured"]);
    expect(after?.tokens.low).toBe(after?.tokens.high);
    expect(after?.tokens.high).toBe(view.budget.used.tokens);
    expect(after?.withMargin).toBe(after?.tokens.high);
    expect(after?.progress.spent).toBe(view.budget.used.tokens);
  });

  // Bench round 38, stoptable (#1387): the boundaries were globs, each counted as one path, so the
  // path floor never applied and a finished glob feature would price a "path" at its whole cost.
  test("a boundary that names a glob gives the estimate no path count", async () => {
    expect(literalPathCount(feature("core", [], ["src/core/**"]))).toBe(0);
    expect(literalPathCount(feature("core", [], ["src/a.ts", "src/{b,c}.ts"]))).toBe(0);
    expect(literalPathCount(feature("core", [], ["src/a.ts", "tests/a.test.ts"]))).toBe(2);
    const globs = plan([feature("core", [], ["src/core/**"]), feature("api", ["core"], ["api.txt", "api.test.txt"]), feature("docs", [], ["docs/*.md"])]);
    const t = setup(globs);
    await t.start({ plan: globs, keepFeatures: true });
    const estimate = t.initiatives.estimate("values");
    expect(estimate?.features.map((f) => [f.featureId, f.paths])).toEqual([
      ["core", undefined],
      ["api", 2],
      ["docs", undefined],
    ]);
  });

  test("with forecastStop a feature waits while the forecast is over the shared budget (#1312)", async () => {
    // Bench round 32, notesift: the forecast was over the budget long before the budget ran out,
    // and features kept starting. With forecastStop the next start waits for a person instead.
    const budget = { maxTotalTokens: 200_000, maxAgentCalls: 200, maxActiveMs: 10_000_000 };
    const plain = setup();
    await plain.start({ plan: threeFeatures, budget });
    let view = await plain.approveSplit();
    expect(view.next.kind).toBe("start");
    const t = setup();
    await t.start({ plan: threeFeatures, budget, forecastStop: true });
    view = await t.approveSplit();
    const estimate = t.initiatives.estimate("values");
    expect(estimate?.tokens.low).toBeGreaterThan(budget.maxTotalTokens);
    expect(view.next.kind).toBe("blocked");
    expect(view.next.featureId).toBe("core");
    expect(view.next.message).toContain("The forecast is over the shared budget");
    expectRecovery(view.next.message, view.next.recovery, "extend");
    view = await t.drive();
    expect(view.features.every((f) => f.runId === null)).toBe(true);
    // Raising the budget above the forecast lets the feature start.
    view = await t.initiatives.extendBudget("values", t.id(), { maxTotalTokens: (estimate?.withMargin ?? 0) * 2 });
    expect(view.next.kind).toBe("start");
    view = await t.drive();
    expect(t.featureOf(view, "core").runId).not.toBeNull();
  });

  test("features an edit leaves alone keep what they had, also without a workflow", () => {
    const choices = [
      { id: "sdd", description: "", schemaVersion: 1 as const, contract: true, execution: "inline" as const, stages: [] },
      { id: "quick", description: "", schemaVersion: 2 as const, contract: false, execution: "inline" as const, stages: [] },
    ];
    const fitted = assignFeatureWorkflows(threeFeatures, choices, "sdd", { replaceInvalid: false, keep: new Set(["core", "api"]) });
    expect(fitted.features.map((f) => f.workflow)).toEqual([undefined, undefined, "quick"]);
    expect(featureDigest(fitted.features[0] ?? feature("x"))).toBe(featureDigest(threeFeatures.features[0] ?? feature("x")));
  });

  test("a decomposer's workflow that cannot run its feature is replaced", async () => {
    const split = plan([
      { ...feature("core"), workflow: "quick" },
      feature("api", ["core"]),
      { ...feature("docs"), workflow: "missing-workflow" },
    ]);
    const t = setup(split);
    await t.start();
    const view = await t.drive();
    expect(view.status).toBe("awaiting_approval");
    expect(t.featureOf(view, "core").workflowId).toBe("sdd");
    expect(t.featureOf(view, "docs").workflowId).toBe("quick");
  });
});

// Bench round 32, notesift (#1311): shares by size words (small 1, medium 2, large 4) and open runs
// that grew past their share left the last feature 0.8M of a 30M budget, and the budget was
// extended only after the fact.
describe("scenario: an initiative budget shared by estimated need (#1311)", () => {
  /** Completes the "values" initiative so a second one is priced from its feature runs. */
  async function measured() {
    // Calls large enough for the estimates to clear the smallest share and sizing ceiling.
    const t = setup(threeFeatures, 20_000);
    let view = await t.start({
      plan: threeFeatures,
      featureAutoApproval: { maxTasks: 5, maxFiles: 5 },
      budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 400, maxActiveMs: 21_600_000 },
    });
    await t.approveSplit();
    for (let i = 0; i < 12 && view.status !== "completed"; i++) view = await t.drive();
    expect(view.status).toBe("completed");
    return t;
  }
  const second = async (t: Awaited<ReturnType<typeof measured>>, budget: { maxTotalTokens: number; maxAgentCalls: number; maxActiveMs: number }) => {
    await t.initiatives.start({
      commandId: newId(),
      initiativeId: "second",
      prompt: "Add the value files again",
      policy: { ...policy, sizing: { maxRunTokens: 50_000_000 } },
      ownerLabel: "test",
      plan: threeFeatures,
      budget,
    });
    const request = t.initiatives.view("second").pendingDecisions.find((d) => d.scope === "initiative");
    if (!request) throw new Error("No pending split approval");
    return t.initiatives.approve(
      "second",
      { commandId: newId(), expectedRevision: t.initiatives.view("second").revision },
      { requestId: request.requestId, digest: request.digest },
    );
  };

  test("a feature whose low estimate cannot fit beside the other reserves stops before it starts", async () => {
    const t = await measured();
    const estimate = t.initiatives.estimate("values");
    const lows = (estimate?.features ?? []).reduce((sum, f) => sum + f.tokens.low, 0);
    let view = await second(t, { maxTotalTokens: Math.floor(lows * 0.8), maxAgentCalls: 400, maxActiveMs: 21_600_000 });
    view = await t.initiatives.drive("second", new AbortController().signal);
    expect(view.next.kind).toBe("blocked");
    expect(view.next.message).toMatch(/^The shared budget is short: core has \d+ tokens available after reserving the other waiting features' low estimates, below its estimate of \d+-\d+\. /);
    expectRecovery(view.next.message, view.next.recovery, "extend");
    expect(view.features.every((f) => f.runId === null)).toBe(true);
  }, 30000);

  test("tokens are shared by estimated need and a run grows only into what the others do not need", async () => {
    const t = await measured();
    const estimate = t.initiatives.estimate("values");
    const highs = (estimate?.features ?? []).reduce((sum, f) => sum + f.tokens.high, 0);
    const view = await second(t, { maxTotalTokens: highs * 2, maxAgentCalls: 400, maxActiveMs: 21_600_000 });
    const [core, api, docs] = ["core", "api", "docs"].map((id) => t.featureOf(view, id));
    for (const f of [core, api, docs]) expect(f?.need).not.toBeNull();
    const total = (core?.need?.high ?? 0) + (api?.need?.high ?? 0) + (docs?.need?.high ?? 0);
    expect(docs?.share?.tokens).toBe(Math.floor((view.budget.remaining.tokens * (docs?.need?.high ?? 0)) / total));
    const reserve = (api?.need?.low ?? 0) + (docs?.need?.low ?? 0);
    const started = await t.initiatives.drive("second", new AbortController().signal);
    const run = t.workflows.store.run(t.featureOf(started, "core").runId ?? "");
    expect(JSON.parse(run.policy_json).sizing.maxRunTokens).toBe(view.budget.remaining.tokens - reserve);
  }, 30000);
  // Bench round 37, ranktally (#1376): a project's first initiative had no finished features of its
  // own, so the path rate of #1354 could not floor the estimate shown at the split approval. The
  // finished features of the stores in sizing.historyStores now count.
  test("a new project's split estimate takes the path rate of another project's finished features", async () => {
    const other = await measured();
    const fresh = setup();
    const shared = { ...policy, sizing: { historyStores: [other.root] } };
    await fresh.start({ plan: threeFeatures, policy: shared });
    const estimate = fresh.initiatives.estimate("values");
    expect(estimate?.perPathSamples).toEqual({ features: 3, shared: 3 });
    expect(estimate?.perPath).not.toBeNull();
    expect(estimate?.notes.some((n) => n.includes("tokens per path of its boundary, as measured on 3 finished features (3 of other projects)"))).toBe(true);
    // Without the shared store the split has nothing to measure a path by.
    const alone = setup();
    await alone.start({ plan: threeFeatures });
    expect(alone.initiatives.estimate("values")).toMatchObject({ perPath: null, perPathSamples: { features: 0, shared: 0 } });
  }, 30000);
  // Bench round 40, tonemath (#1464): core listed the stubs later features filled, so a finished
  // core counted its whole cost against paths it only created placeholders for.
  test("a finished feature's placeholder paths count at their share in the measured path rate", async () => {
    const stubbed = plan([feature("core", [], ["core.txt", "api.txt"]), feature("api", ["core"]), feature("docs")]);
    const other = setup(stubbed, 20_000);
    await other.start({
      plan: stubbed,
      featureAutoApproval: { maxTasks: 5, maxFiles: 5 },
      budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 400, maxActiveMs: 21_600_000 },
    });
    let view = await other.approveSplit();
    for (let i = 0; i < 12 && view.status !== "completed"; i++) view = await other.drive();
    expect(view.status).toBe("completed");
    const spent = Object.fromEntries((other.initiatives.estimate("values")?.features ?? []).map((f) => [f.featureId, f.spent]));
    expect(other.initiatives.estimate("values")?.features.find((f) => f.featureId === "core")).toMatchObject({ paths: 1, placeholders: 1 });
    const fresh = setup();
    await fresh.start({ plan: threeFeatures, policy: { ...policy, sizing: { historyStores: [other.root] } } });
    const rates = [(spent.core ?? 0) / (1 + PLACEHOLDER_SHARE), spent.api ?? 0, spent.docs ?? 0];
    // Core's 140k over one file and one stub is 105k a path, the median; two full paths said 70k.
    const sorted = [...rates].sort((a, b) => a - b);
    expect(fresh.initiatives.estimate("values")?.perPath).toEqual({ low: sorted[0] ?? 0, high: Math.round(sorted[1] ?? 0) });
  }, 30000);
});

// Bench round 32, notesift (#1317): each feature run had its own $8 cap and nothing added the
// dollars up, so the initiative spent $29.15 of the loop's $32 with no signal from the host.
describe("scenario: an initiative dollar budget (#1317)", () => {
  const MODEL = "anthropic/claude-sonnet-4-6";
  const startPriced = (t: ReturnType<typeof setup>, maxCostUsd: number, extra: Partial<InitiativeStartRequest> = {}) =>
    t.start({
      plan: threeFeatures,
      model: MODEL,
      featureAutoApproval: { maxTasks: 5, maxFiles: 5 },
      budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 400, maxActiveMs: 21_600_000 },
      costBudget: { maxCostUsd },
      ...extra,
    });

  test("feature runs share the dollar cap: each starts with its share as its maxCostUsd", async () => {
    const t = setup(threeFeatures, 20_000);
    t.executor.usageStore = t.workflows.store;
    await startPriced(t, 3, { costBudget: { maxCostUsd: 3, costTolerance: 0.1 } });
    const view = await t.approveSplit();
    expect(view.budget.cost).toEqual({ capUsd: 3, tolerance: 0.1, ceilingUsd: 3.3, spentUsd: 0, reservedUsd: 0, remainingUsd: 3, forecastUsd: null, measuredFeatures: 0, forecastBinding: false, forecastNotice: null });
    // Without estimates, dollars follow the size weights: core 2, api 2, docs 1 of 5.
    expect(view.features.map((f) => [f.id, f.size, f.shareUsd])).toEqual([["core", "medium", 1.2], ["api", "medium", 1.2], ["docs", "small", 0.6]]);
    const driven = await t.drive();
    const policy = JSON.parse(t.workflows.store.run(t.featureOf(driven, "core").runId ?? "").policy_json);
    expect([policy.maxCostUsd, policy.costTolerance]).toEqual([1.2, 0.1]);
    expect(t.featureOf(driven, "core").spentUsd).toBeGreaterThan(0);
    expect(driven.budget.cost.spentUsd).toBe(Math.round(driven.features.reduce((sum, f) => sum + f.spentUsd, 0) * 100) / 100);
  }, 30000);

  // Bench rounds 48 to 50 (#1659): every forecast stop came after one or two accepted features
  // and was 1.3 to 3.1 times what the initiative then cost.
  test("a forecast above the cap after one accepted feature advises and the next feature starts", async () => {
    const t = setup(threeFeatures, 20_000);
    t.executor.usageStore = t.workflows.store;
    await startPriced(t, 3);
    await t.approveSplit();
    const view = await t.drive();
    expect(t.featureOf(view, "core").state).toBe("accepted");
    const notes = t.initiatives.events("values").filter((e) => e.type === "cost.forecast_advisory");
    expect(notes).toHaveLength(1);
    const note = notes[0]!.payload as { featureId: string; forecastUsd: number; ceilingUsd: number; measuredFeatures: number; message: string };
    expect(note.forecastUsd).toBeGreaterThan(note.ceilingUsd);
    expect(note.ceilingUsd).toBe(3);
    expect(note.measuredFeatures).toBeGreaterThan(0);
    expect(note.message).toContain("advisory until 5 features are measured");
    // The feature started after the warning, and its own run forecast only advises too.
    const next = t.featureOf(view, note.featureId);
    expect(next.runId).not.toBeNull();
    expect(JSON.parse(t.workflows.store.run(next.runId ?? "").policy_json).costForecast).toBe("advise");
    expect(view.next.message).not.toContain("cost forecast");
  }, 30000);

  test("with forecastStop on, a forecast above the cap stops the next feature until the cap is raised", async () => {
    const t = setup(threeFeatures, 20_000);
    t.executor.usageStore = t.workflows.store;
    await startPriced(t, 3, { forecastStop: true });
    await t.approveSplit();
    let view = await t.drive();
    expect(t.featureOf(view, "core").state).toBe("accepted");
    const accepted = view.features.filter((f) => f.state === "accepted").length;
    const waiting = view.features.filter((f) => f.state !== "accepted");
    expect(accepted).toBeGreaterThan(0);
    expect(waiting.length).toBeGreaterThan(0);
    const forecast = view.budget.cost.forecastUsd ?? 0;
    expect(forecast).toBeGreaterThan(3);
    expect(view.next.kind).toBe("blocked");
    expect(view.next.message).toMatch(/^The initiative's cost forecast is \$\d+\.\d\d, above its \$3\.00 cap: \$\d+\.\d\d spent with \d of 3 features accepted\. Raise the dollar budget to at least \$\d+\.00 with baked workflow initiative extend --budget-usd N/);
    expect(view.next.message).toContain(`spent with ${accepted} of 3 features accepted`);
    expectRecovery(view.next.message, view.next.recovery, "extend");
    expect(initiativeExit(view)).toBe(4);
    expect(waiting.every((f) => f.runId === null)).toBe(true);
    view = await t.initiatives.extendBudget("values", t.id(), { maxCostUsd: Math.ceil(forecast) + 1 });
    expect(view.budget.cost.capUsd).toBe(Math.ceil(forecast) + 1);
    // Raising only the dollars leaves the token limits as they were.
    expect(view.budget.limits.maxTotalTokens).toBe(50_000_000);
    await expect(t.initiatives.extendBudget("values", t.id(), { maxCostUsd: 1 })).rejects.toThrow("can only be raised");
    view = await t.drive();
    expect(t.featureOf(view, waiting[0]!.id).runId).not.toBeNull();
  }, 30000);

  // Bench round 42 (#1505): the re-forecast priced the features still to run at every run's
  // dollars over every run's tokens, the decompose run and unpriced held tokens included.
  test("the re-forecast prices the features left at what the feature runs paid per token", async () => {
    const t = setup(threeFeatures, 20_000);
    t.executor.usageStore = t.workflows.store;
    // Without a given plan the decomposer runs and proposes the split.
    const started = await t.start({ model: MODEL, featureAutoApproval: { maxTasks: 5, maxFiles: 5 }, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 400, maxActiveMs: 21_600_000 }, costBudget: { maxCostUsd: 6 } });
    await t.initiatives.drive("values", new AbortController().signal);
    const store = t.workflows.store;
    // The decompose run is paid once, here all at the output price, and does not repeat.
    const decompose = t.initiatives.view("values").decompose?.runId ?? started.decompose?.runId ?? "";
    const stepId = store.beginStep(decompose, "decompose-extra");
    const attempt = store.reserve(decompose, stepId, MODEL, 1000, JSON.parse(store.run(decompose).policy_json));
    store.transaction(() => {
      store.artifact(decompose, "usage", `attempts/${attempt}/usage.json`, canonical({ schemaVersion: 1, profileId: "decomposer", taskId: null, maxSteps: 10, maxTokens: 1_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: 5_000, steps: [{ step: 1, inputTokens: 0, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }] }));
      store.finishAttempt(decompose, attempt, "completed", 5_000);
    });
    await t.approveSplit();
    // Stop at a measured checkpoint instead of relying on the cost forecast to hold later starts.
    const controller = new AbortController();
    const unwatch = store.observe((event) => {
      if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
    });
    try { await t.initiatives.drive("values", controller.signal); }
    finally { unwatch(); }
    const estimate = t.initiatives.estimate("values");
    const view = t.initiatives.view("values");
    const runs = view.features.map((f) => f.runId).filter((id): id is string => id !== null);
    const usd = runs.reduce((sum, id) => sum + store.costUsage(id).spentUsd, 0);
    const tokens = runs.reduce((sum, id) => sum + store.run(id).token_usage, 0);
    const accepted = new Set(view.features.filter((f) => f.state === "accepted").map((f) => f.id));
    const left = (estimate?.features ?? [])
      .filter((f) => !accepted.has(f.featureId))
      .reduce((sum, f) => sum + Math.max(0, f.expectedTokens - f.spent), 0);
    expect(usd).toBeGreaterThan(0);
    expect(view.budget.cost.spentUsd).toBeGreaterThan(usd);
    const spent = usd + store.costUsage(decompose).spentUsd;
    expect(view.budget.cost.forecastUsd).toBe(Math.round((spent + (usd / tokens) * left) * 100) / 100);
  }, 30000);

  test("costForecast off in the base policy keeps only the shares", async () => {
    const t = setup(threeFeatures, 20_000);
    t.executor.usageStore = t.workflows.store;
    await startPriced(t, 3, { policy: { ...policy, costForecast: "off" } });
    await t.approveSplit();
    const view = await t.drive();
    expect(view.budget.cost.forecastUsd).toBeNull();
    expect(t.featureOf(view, "api").runId).not.toBeNull();
  }, 30000);

  test("a dollar share below one cent stops the feature before it starts", async () => {
    const t = setup(threeFeatures, 20_000);
    await startPriced(t, 0.02);
    await t.approveSplit();
    const view = await t.drive();
    expect(view.next.message).toMatch(/^The shared dollar budget is exhausted: core would start with \$0\.00 of the \$0\.02 cap/);
    expectRecovery(view.next.message, view.next.recovery, "extend");
    expect(view.features.every((f) => f.runId === null)).toBe(true);
  }, 30000);

  test("the CLI takes the dollar cap, its tolerance and raises it with extend", () => {
    const args = parseInitiativeArgs(["start", "big", "--prompt", "x", "--budget-usd", "32.5", "--cost-tolerance", "auto"]);
    expect([args.flags["budget-usd"], args.flags["cost-tolerance"]]).toEqual(["32.5", "auto"]);
    expect(() => parseInitiativeArgs(["start", "big", "--prompt", "x", "--cost-tolerance", "0.2"])).toThrow("only with --budget-usd");
    expect(() => parseInitiativeArgs(["start", "big", "--prompt", "x", "--budget-usd", "0"])).toThrow("positive dollar amount");
    expect(() => parseInitiativeArgs(["start", "big", "--prompt", "x", "--budget-usd", "5", "--cost-tolerance", "0.9"])).toThrow("auto, off or 0 to 0.5");
    expect(parseInitiativeArgs(["extend", "big", "--budget-usd", "40", "--expected-revision", "3"]).flags["budget-usd"]).toBe("40");
    expect(parseInitiativeArgs(["start", "big", "--prompt", "x", "--keep-features"]).flags["keep-features"]).toBe(true);
    expect(initiativeHelp).toContain("--keep-features");
    expect(parseInitiativeArgs(["start", "big", "--prompt", "x", "--split-critical-path"]).flags["split-critical-path"]).toBe(true);
    expect(initiativeHelp).toContain("--split-critical-path");
    expect(initiativeHelp).toContain("--budget-usd N [--cost-tolerance auto|off|0.2]");
    // `auto` widens with the number of features, as a run's widens with its tasks.
    expect([3, 4, 9, 12, 13].map((n) => initiativeCostTolerance("auto", n))).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
  });
});

// Bench round 33, vtsnap (#1327): calls and active time were split by size alone, so the first
// medium feature of a 6 hour, 7 feature initiative got 38 minutes, needed 40 and blocked
// "Active deadline exhausted" with 11.7M ms of the initiative unused.
describe("scenario: a starting feature's calls and time grow into what the others do not need (#1327)", () => {
  test("the first feature gets the remaining time and calls less the waiting features' floors", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 400, maxActiveMs: 21_600_000 } });
    const before = await t.approveSplit();
    const [core, ...others] = ["core", "api", "docs"].map((id) => t.featureOf(before, id));
    const weight = (size: string) => (size === "small" ? 1 : size === "large" ? 4 : 2);
    const floor = (limit: number, pick: (f: (typeof others)[number]) => number) =>
      others.reduce((sum, f) => sum + Math.min(pick(f), (limit * weight(f.size)) / 2), 0);
    const ms = 21_600_000 - floor(policy.maxActiveMs, (f) => f.share?.activeMs ?? 0);
    const calls = 400 - floor(policy.maxAgentCalls, (f) => f.share?.calls ?? 0);
    expect(ms).toBeGreaterThan(core?.share?.activeMs ?? 0);
    expect(calls).toBeGreaterThan(core?.share?.calls ?? 0);
    const view = await t.drive();
    const run = JSON.parse(t.workflows.store.run(t.featureOf(view, "core").runId ?? "").policy_json);
    expect([run.maxActiveMs, run.maxAgentCalls]).toEqual([Math.floor(ms), Math.floor(calls)]);
  }, 30000);

  test("a budget far above the per-run limits leaves each feature its own share", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 40, maxActiveMs: policy.maxActiveMs } });
    const before = await t.approveSplit();
    const share = t.featureOf(before, "core").share;
    const view = await t.drive();
    const run = JSON.parse(t.workflows.store.run(t.featureOf(view, "core").runId ?? "").policy_json);
    // The floors are the other features' whole shares here, so nothing is left to grow into.
    expect([run.maxActiveMs, run.maxAgentCalls]).toEqual([share?.activeMs, share?.calls]);
  }, 30000);
});

describe("initiative runtime", () => {
  test("the decomposer proposes the split; an edit changes the approval digest", async () => {
    const t = setup();
    let view = await t.start();
    expect(view.status).toBe("decomposing");
    view = await t.drive();
    expect(view.status).toBe("awaiting_approval");
    expect(t.executor.calls).toEqual(["initiativePlan"]);
    expect(view.features.map((f) => [f.id, f.state])).toEqual([["core", "proposed"], ["api", "proposed"], ["docs", "proposed"]]);
    const first = view.pendingDecisions.find((d) => d.scope === "initiative");
    expect(first?.digest).toBe(view.planDigest ?? "");

    view = await t.initiatives.edit("values", t.id(), { op: "rename", featureId: "docs", title: "Documentation" });
    const second = view.pendingDecisions.find((d) => d.scope === "initiative");
    expect(view.planRevision).toBe(2);
    expect(second?.digest).not.toBe(first?.digest);
    expect(t.initiatives.store.requests("values").find((r) => r.id === first?.requestId)?.status).toBe("superseded");
    // The old digest no longer approves anything.
    await expect(t.initiatives.approve("values", t.id(), { requestId: first?.requestId ?? "", digest: first?.digest ?? "" })).rejects.toThrow("Pending request not found");
    await expect(t.initiatives.approve("values", t.id(), { requestId: second?.requestId ?? "", digest: first?.digest ?? "" })).rejects.toThrow("digest");
    view = await t.approveSplit();
    expect(view.status).toBe("active");
    expect(view.approvedPlanRevision).toBe(2);
    expect(t.featureOf(view, "docs").title).toBe("Documentation");
  });

  test("the decomposer's one-file siblings are merged into one feature; keepFeatures keeps them apart", async () => {
    // Bench round 35, narrowfit (#1352): six constraint kinds of one file each, all on core, all
    // needed by language, each paid a run's research, spec, plan, analysis and review.
    const kinds = ["alldiff", "sum", "count", "table", "element", "require"];
    const narrowfit = plan([
      { ...feature("core", [], ["internal/core/a.go", "internal/core/b.go", "internal/core/c.go"]), testedBy: "language" },
      ...kinds.map((k) => ({ ...feature(k, ["core"], [`internal/constraint/${k}.go`]), testedBy: "language" })),
      feature("language", ["core", ...kinds], ["internal/lang/a.go", "internal/lang/b.go", "internal/lang/c_test.go"]),
    ]);
    const t = setup(narrowfit);
    await t.start();
    let view = await t.drive();
    expect(view.status).toBe("awaiting_approval");
    expect(view.features.map((f) => f.id)).toEqual(["core", "alldiff", "language"]);
    const merged = t.featureOf(view, "alldiff");
    expect(merged.mergedFrom).toEqual(kinds);
    expect(merged.boundary.paths).toEqual(kinds.map((k) => `internal/constraint/${k}.go`));
    expect(merged.dependsOn).toEqual(["core"]);
    expect(merged.title).toBe(kinds.map((k) => `Feature ${k}`).join(" + "));
    for (const k of kinds) expect(merged.contract).toContain(`${k}.txt holds the value of ${k}`);
    expect(t.featureOf(view, "language").dependsOn).toEqual(["core", "alldiff"]);
    expect(t.featureOf(view, "core").mergedFrom).toEqual([]);
    const events = t.initiatives.store.eventsOfType("values", "split.merged");
    expect(events).toEqual([{ planRevision: 1, merged: [{ featureId: "alldiff", from: kinds }] }]);
    // The merged split is approved and runs like any other.
    view = await t.approveSplit();
    expect(view.status).toBe("active");

    const kept = setup(narrowfit);
    await kept.start({ keepFeatures: true });
    view = await kept.drive();
    expect(view.features.map((f) => f.id)).toEqual(["core", ...kinds, "language"]);
    expect(kept.initiatives.store.eventsOfType("values", "split.merged")).toEqual([]);
  });

  test("a small leaf feature of the decomposer runs the light workflow; keepFeatures keeps its spec workflow", async () => {
    // Bench round 36, seqmill: the documentation leaf ran sdd for $1.42 against about $0.5 for a
    // quick run; nothing pins a leaf's spec.
    const three = (id: string) => [`${id}/a.py`, `${id}/b.py`, `${id}/test_c.py`];
    const seqmill = plan([
      { ...feature("core", [], three("core")), workflow: "sdd" },
      { ...feature("engine", ["core"], three("engine")), workflow: "sdd" },
      { ...feature("docs", ["core", "engine"], ["README.md", "docs/usage.md"]), workflow: "sdd" },
      { ...feature("cli", ["engine"], three("cli")), workflow: "sdd", size: "medium" as const },
    ]);
    const t = setup(seqmill);
    await t.start();
    const view = await t.drive();
    expect(view.status).toBe("awaiting_approval");
    expect(view.features.map((f) => [f.id, f.workflowId])).toEqual([
      ["core", "sdd"],
      ["engine", "sdd"],
      ["docs", "quick"],
      ["cli", "sdd"],
    ]);
    expect(t.initiatives.store.eventsOfType("values", "split.lightened")).toEqual([
      { planRevision: 1, lightened: [{ featureId: "docs", from: "sdd", to: "quick" }] },
    ]);

    const kept = setup(seqmill);
    await kept.start({ keepFeatures: true });
    expect(kept.featureOf(await kept.drive(), "docs").workflowId).toBe("sdd");
  });

  test("under tiered approval a small leaf still runs quick, and its plan is approved within its boundary (#1374)", async () => {
    // Bench round 37, ranktally: with --tiered-approval only schema 1 workflows were feature
    // choices, quick (a shipped schema 2 preset) was not, and the release leaf ran sdd for 1.65M.
    const three = (id: string) => [`${id}.txt`, `${id}/b.txt`, `${id}/c.txt`];
    const ranktally = plan([
      { ...feature("core", [], three("core")), workflow: "sdd" },
      { ...feature("engine", ["core"], three("engine")), workflow: "sdd", size: "medium" as const },
      { ...feature("release", ["engine"], ["release.txt", "LICENSE"]), workflow: "sdd" },
    ]);
    const t = setup(ranktally);
    await t.start({ featureAutoApproval: { maxTasks: 8, maxFiles: 14 } });
    let view = await t.drive();
    expect(view.features.map((f) => [f.id, f.workflowId])).toEqual([
      ["core", "sdd"],
      ["engine", "sdd"],
      ["release", "quick"],
    ]);
    expect(t.initiatives.store.eventsOfType("values", "split.lightened")).toEqual([
      { planRevision: 1, lightened: [{ featureId: "release", from: "sdd", to: "quick" }] },
    ]);
    await t.approveSplit();
    for (let i = 0; i < 6 && view.status !== "completed"; i++) view = await t.drive();
    // No person was asked: quick's plan approval took the feature's tiered limits.
    expect(view.status).toBe("completed");
    const release = t.featureOf(view, "release").runId ?? "";
    const run = t.workflows.store.run(release);
    const definition = JSON.parse(run.definition_json) as { id: string; stages: { id: string; decision?: string }[] };
    expect(definition.id).toBe("quick");
    expect(definition.stages.find((s) => s.id === "approve")?.decision).toBe("auto");
    expect(t.workflows.store.requests(release).find((r) => r.kind === "approval")?.actor).toBe("auto-approval");
    expect(JSON.parse(run.policy_json).autoApproval.limits.allowedPaths).toEqual(["release.txt", "LICENSE"]);
  }, 30000);

  test("glob boundaries are of unknown size: the decomposer's broad features are neither merged nor moved to quick (#1405)", async () => {
    // The decomposer gives boundaries as globs; `src/parser/**` is one entry and any number of
    // files, and counting it as one path merged broad siblings and ran them on quick.
    const broad = plan([
      { ...feature("core", [], ["src/core/**"]), workflow: "sdd" },
      { ...feature("parser", ["core"], ["src/parser/**"]), workflow: "sdd" },
      { ...feature("render", ["core"], ["src/render/**"]), workflow: "sdd" },
      { ...feature("cli", ["parser", "render"], ["src/cli/**"]), workflow: "sdd", size: "large" as const },
      { ...feature("docs", ["cli"], ["docs/**"]), workflow: "sdd" },
    ]);
    const t = setup(broad);
    await t.start();
    const view = await t.drive();
    expect(view.features.map((f) => [f.id, f.workflowId, f.mergedFrom])).toEqual([
      ["core", "sdd", []],
      ["parser", "sdd", []],
      ["render", "sdd", []],
      ["cli", "sdd", []],
      ["docs", "sdd", []],
    ]);
    expect(t.initiatives.store.eventsOfType("values", "split.merged")).toEqual([]);
    expect(t.initiatives.store.eventsOfType("values", "split.lightened")).toEqual([]);
    // A large leaf with literal paths stays on its spec workflow too.
    const choices = [
      { id: "sdd", description: "", schemaVersion: 1 as const, contract: true, execution: "inline" as const, stages: [] },
      { id: "quick", description: "", schemaVersion: 2 as const, contract: false, execution: "inline" as const, stages: [] },
    ];
    const large = plan([
      { ...feature("core", [], ["a", "b", "c"]), workflow: "sdd" },
      { ...feature("big", ["core"], ["x.ts"]), workflow: "sdd", size: "large" as const },
      { ...feature("tiny", ["core"], ["y.ts"]), workflow: "sdd" },
    ]);
    expect(lightenSmallLeaves(large, choices).lightened.map((l) => l.featureId)).toEqual(["tiny"]);
    expect(mergeSmallSiblings(plan([feature("a", [], ["src/a/**"]), feature("b", [], ["src/b/**"]), feature("c"), feature("d")])).merged).toEqual([
      { featureId: "c", from: ["c", "d"] },
    ]);
  });

  test("a quick leaf that shares a file with a later feature stays a leaf, and the initiative completes (#1406)", async () => {
    // Sequencing made cli depend on the lightened docs leaf (both write README.md), and every
    // drive stopped at ARTIFACT_MISSING because quick writes no spec to pin.
    const readme = plan([
      { ...feature("core", [], ["core.txt", "core/b.txt", "core/c.txt"]), workflow: "sdd" },
      { ...feature("docs", ["core"], ["docs.txt", "README.md"]), workflow: "sdd" },
      { ...feature("cli", ["core"], ["cli.txt", "cli/b.txt", "README.md"]), workflow: "sdd", size: "medium" as const },
    ]);
    const t = setup(readme);
    await t.start();
    let view = await t.drive();
    expect(view.features.map((f) => [f.id, f.workflowId, f.dependsOn])).toEqual([
      ["core", "sdd", []],
      ["cli", "sdd", ["core"]],
      ["docs", "quick", ["core", "cli"]],
    ]);
    await t.approveSplit();
    for (let i = 0; i < 12 && view.status !== "completed"; i++) {
      view = await t.drive();
      const waiting = view.pendingDecisions.find((d) => d.scope === "feature" && d.kind === "approval");
      if (waiting?.featureId) await t.approveFeature(waiting.featureId);
    }
    expect(view.status).toBe("completed");
  }, 30000);

  test("with lightContracts a small feature others depend on runs quick, and its dependent pins the host-made contract (#1664)", async () => {
    // Bench round 50, selwhy: one-file command features that the cli feature joined ran sdd, and
    // their fixed stages cost 1.1x to 4.4x their task tokens (plan 156k for a one-task graph).
    const selwhy = plan([
      { ...feature("core", [], ["core.txt", "core/b.txt", "core/c.txt"]), workflow: "sdd" },
      { ...feature("tree", ["core"], ["tree.txt"]), workflow: "sdd" },
      { ...feature("cli", ["tree"], ["cli.txt", "cli/b.txt", "cli/c.txt"]), workflow: "sdd", size: "medium" as const },
    ]);
    const off = setup(selwhy);
    await off.start();
    expect(off.featureOf(await off.drive(), "tree").workflowId).toBe("sdd");
    // The run policy turns it on too, as the bench loop sets its policy.
    const byPolicy = setup(selwhy);
    await byPolicy.start({ policy: { ...policy, lightContracts: "on" } });
    expect(byPolicy.featureOf(await byPolicy.drive(), "tree").workflowId).toBe("quick");

    const t = setup(selwhy);
    await t.start({ lightContracts: true });
    let view = await t.drive();
    expect(view.features.map((f) => [f.id, f.workflowId])).toEqual([
      ["core", "sdd"],
      ["tree", "quick"],
      ["cli", "sdd"],
    ]);
    expect(t.initiatives.store.eventsOfType("values", "split.lightened")).toEqual([
      { planRevision: 1, lightened: [{ featureId: "tree", from: "sdd", to: "quick" }] },
    ]);
    await t.approveSplit();
    for (let i = 0; i < 12 && view.status !== "completed"; i++) {
      view = await t.drive();
      const waiting = view.pendingDecisions.find((d) => d.scope === "feature" && d.kind === "approval");
      if (waiting?.featureId) await t.approveFeature(waiting.featureId);
    }
    expect(view.status).toBe("completed");
    const tree = t.featureOf(view, "tree").runId ?? "";
    const spec = t.workflows.store.state(tree).spec;
    expect(spec?.requirements[0]?.text).toContain("Contract for dependent features: tree.txt holds the value of tree");
    expect(t.workflows.store.latestArtifact(tree, "spec.json")).toBeTruthy();
    const cli = t.featureOf(view, "cli").runId ?? "";
    expect(t.workflows.store.state(cli).spec?.dependencies).toEqual([
      { featureId: "values_tree", contractHash: hashJson(spec) },
    ]);
  }, 60000);

  test("lightContracts counts quick as a contract workflow and moves small features with dependents (#1664)", () => {
    const choices = [
      { id: "sdd", description: "", schemaVersion: 1 as const, contract: true, execution: "inline" as const, stages: [] },
      { id: "quick", description: "", schemaVersion: 2 as const, contract: false, execution: "inline" as const, stages: [] },
    ];
    const contracts = choices.map((c) => withLightContract(c, true) ?? c);
    expect(contracts.map((c) => c.contract)).toEqual([true, true]);
    expect(withLightContract(choices[1] ?? null, false)?.contract).toBe(false);
    const split = plan([
      { ...feature("core", [], ["a", "b", "c"]), workflow: "sdd" },
      { ...feature("tree", ["core"], ["tree.go"]), workflow: "sdd" },
      { ...feature("login", ["core"], ["src/auth.ts"]), workflow: "sdd" },
      { ...feature("cli", ["tree", "login"], ["x", "y", "z"]), workflow: "sdd", size: "medium" as const },
    ]);
    // Off: tree has a dependent and stays; on: it moves, a risky path still stays.
    expect(lightenSmallLeaves(split, choices).lightened).toEqual([]);
    const moved = lightenSmallLeaves(split, contracts, new Set(), { withDependents: true });
    expect(moved.lightened).toEqual([{ featureId: "tree", from: "sdd", to: "quick" }]);
    expect(planWorkflowProblems(moved.plan, contracts)).toEqual([]);
    expect(restoreContractWorkflows(moved.plan, contracts, "sdd").restored).toEqual([]);
    // Without the setting the same plan is refused for its dependents.
    expect(planWorkflowProblems(moved.plan, choices)).toHaveLength(1);
  });

  test("a light feature that still gains a dependent is moved back to a spec workflow (#1406)", () => {
    const choices = [
      { id: "sdd", description: "", schemaVersion: 1 as const, contract: true, execution: "inline" as const, stages: [] },
      { id: "quick", description: "", schemaVersion: 2 as const, contract: false, execution: "inline" as const, stages: [] },
    ];
    const both = plan([
      feature("core", [], ["a", "b", "c"]),
      { ...feature("x", ["core"], ["shared.md"]), workflow: "quick" },
      { ...feature("y", ["core"], ["shared.md", "y.md"]), workflow: "quick" },
    ]);
    // Both are light, so the later depends on the earlier, which then needs a spec.
    const sequenced = sequenceSharedPaths(both, new Set(), new Set(["x", "y"]));
    expect(sequenced.added).toEqual([{ featureId: "y", dependsOn: "x", paths: ["shared.md"] }]);
    const repaired = restoreContractWorkflows(sequenced.plan, choices, "sdd");
    expect(repaired.restored).toEqual([{ featureId: "x", from: "quick", to: "sdd" }]);
    expect(planWorkflowProblems(repaired.plan, choices)).toEqual([]);
  });

  test("a small leaf that writes a risky path keeps its spec workflow", () => {
    const choices = [
      { id: "sdd", description: "", schemaVersion: 1 as const, contract: true, execution: "inline" as const, stages: [] },
      { id: "quick", description: "", schemaVersion: 2 as const, contract: false, execution: "inline" as const, stages: [] },
    ];
    const leaves = plan([
      { ...feature("core", [], ["a", "b", "c"]), workflow: "sdd" },
      { ...feature("release", ["core"], ["README.md", "LICENSE"]), workflow: "sdd" },
      { ...feature("store", ["core"], ["db/migrations/002.sql"]), workflow: "sdd" },
      { ...feature("login", ["core"], ["src/auth.ts"]), workflow: "sdd" },
      { ...feature("ci", ["core"], [".github/workflows/ci.yml"]), workflow: "sdd" },
    ]);
    const result = lightenSmallLeaves(leaves, choices);
    expect(result.lightened.map((l) => l.featureId)).toEqual(["release"]);
    // Without quick among the choices the leaf is reported instead of skipped silently.
    expect(lightenSmallLeaves(leaves, choices.slice(0, 1)).unavailable).toEqual(["release"]);
  });

  test("a quick run outside an initiative keeps its human plan approval", async () => {
    const t = setup();
    const run = await t.workflows.start({
      commandId: newId(), workflowId: "quick", featureId: "solo", prompt: "Add solo.txt", ownerLabel: "test",
      policy: { ...policy, autoApproval: { renewal: false, limits: { maxTasks: 5, maxFiles: 5, allowedPaths: ["solo.txt"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: 100000 } } },
    });
    const definition = JSON.parse(t.workflows.store.run(run.runId).definition_json) as { stages: { id: string; decision?: string }[] };
    expect(definition.stages.find((s) => s.id === "approve")?.decision).toBe("human");
  });

  test("small siblings merge only with the same dependencies, up to the path cap and the feature minimum", () => {
    const one = (id: string, deps: string[] = []) => feature(id, deps, [`${id}.txt`]);
    // Different dependencies, a feature without paths and a three-path feature stay apart.
    const mixed = plan([
      feature("core", [], ["a", "b", "c"]),
      one("x", ["core"]),
      one("y", ["core"]),
      one("z"),
      feature("open", ["core"], []),
      feature("big", ["core"], ["d", "e", "f"]),
    ]);
    const result = mergeSmallSiblings(mixed);
    expect(result.merged).toEqual([{ featureId: "x", from: ["x", "y"] }]);
    expect(result.plan.features.map((f) => f.id)).toEqual(["core", "x", "z", "open", "big"]);
    expect(validateInitiativePlan(result.plan)).toEqual([]);
    // A required feature is not merged with an optional one.
    const optional = plan([feature("core", [], ["a", "b", "c"]), one("x", ["core"]), { ...one("y", ["core"]), mandatory: false }, one("w", ["core"])]);
    expect(mergeSmallSiblings(optional).merged).toEqual([{ featureId: "x", from: ["x", "w"] }]);
    // Twelve one-file siblings become features of at most MAX_MERGED_PATHS paths.
    const many = plan([feature("core", [], ["a", "b", "c"]), ...Array.from({ length: 12 }, (_, i) => one(`k${i}`, ["core"]))]);
    const chunked = mergeSmallSiblings(many);
    expect(chunked.merged.map((m) => m.from.length)).toEqual([MAX_MERGED_PATHS, 12 - MAX_MERGED_PATHS]);
    // The split never drops below three features.
    const three = mergeSmallSiblings(plan([one("a"), one("b"), one("c"), one("d")]));
    expect(three.plan.features.map((f) => f.id)).toEqual(["a", "c", "d"]);
    expect(three.merged).toEqual([{ featureId: "a", from: ["a", "b"] }]);
    expect(mergeSmallSiblings(threeFeatures).merged).toEqual([]);
  });

  test("a decomposer split above twelve features is refused with a message to split into stages", async () => {
    // Three paths each, so no feature is small enough to be merged into a sibling.
    const paths = (id: string) => [`${id}/a.txt`, `${id}/b.txt`, `${id}/c.txt`];
    const t = setup(plan(Array.from({ length: 13 }, (_, i) => feature(`f${i}`, [], paths(`f${i}`)))));
    await t.start();
    const view = await t.drive();
    expect(view.status).toBe("refused");
    expect(view.reason).toContain("Split the request into stages");
    expect(view.planRevision).toBe(0);
    await expect(t.start({ initiativeId: "other", plan: plan(Array.from({ length: 13 }, (_, i) => feature(`f${i}`))) })).rejects.toThrow("stages");
  });

  test("a dependent feature waits for a contract, is re-approved after the upstream changes, and the initiative completes only then", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures });
    await t.approveSplit();

    // core runs first and stops at its spec approval; api waits for core's contract.
    let view = await t.drive();
    expect(t.featureOf(view, "core").state).toBe("needs_decision");
    expect(t.featureOf(view, "api").state).toBe("waiting");
    expect(t.featureOf(view, "api").blockers[0]).toContain("waits for core's contract");
    expect(t.featureOf(view, "docs").state).toBe("ready");
    expect(view.next.kind).toBe("decide");

    await t.approveFeature("core");
    view = await t.drive();
    const core = t.featureOf(view, "core");
    expect(core.state).toBe("accepted");
    expect(t.featureOf(view, "api").state).toBe("needs_decision");
    // api is pinned to core's accepted contract hash.
    expect(t.featureOf(view, "api").pinned).toEqual([{ featureId: runFeatureId("values", "core"), contractHash: core.contractHash ?? "" }]);
    const firstApproval = await t.approveFeature("api");
    view = await t.drive();
    const apiRun = t.featureOf(view, "api").runId ?? "";
    expect(t.featureOf(view, "api").state).toBe("accepted");
    expect(t.featureOf(view, "docs").state).toBe("needs_decision");
    expect(view.status).toBe("active");

    // Pause, change core's contract by re-planning it, resume.
    view = await t.initiatives.pause("values", t.id());
    expect(view.status).toBe("paused");
    expect((await t.drive()).next.kind).toBe("paused");
    t.executor.contracts.core = "v2";
    await t.initiatives.replan("values", t.id(), "core");
    view = await t.initiatives.resume("values", t.id());
    expect(view.status).toBe("active");
    expect(t.featureOf(view, "core").state).toBe("ready");
    // api keeps its finished result but cannot count it until core is accepted again.
    expect(t.featureOf(view, "api").state).toBe("waiting");

    // docs' run is still open and waits for its approval; one feature run is open at a time.
    view = await t.drive();
    expect(view.next.kind).toBe("decide");
    expect(view.next.featureId).toBe("docs");
    expect(t.featureOf(view, "core").state).toBe("ready");
    await t.approveFeature("docs");
    view = await t.drive();
    expect(t.featureOf(view, "docs").state).toBe("accepted");
    expect(t.featureOf(view, "core").state).toBe("needs_decision");
    await t.approveFeature("core");
    view = await t.drive();
    const newCore = t.featureOf(view, "core");
    expect(newCore.state).toBe("accepted");
    expect(newCore.contractHash).not.toBe(core.contractHash);
    // api's result is invalidated and a rebased run waits for a new approval of its plan.
    const api = t.featureOf(view, "api");
    expect(api.state).toBe("needs_decision");
    expect(api.runId).not.toBe(apiRun);
    expect(api.pinned[0]?.contractHash).toBe(newCore.contractHash ?? "");
    expect(t.workflows.store.evidence(apiRun).every((e) => e.validity !== "current")).toBe(true);
    expect(t.initiatives.events("values").some((e) => e.type === "feature.invalidated")).toBe(true);
    expect(view.status).toBe("active");
    const reapproval = await t.approveFeature("api");
    expect(reapproval.digest).not.toBe(firstApproval.digest);
    expect(t.workflows.store.requests(api.runId ?? "").find((r) => r.id === reapproval.requestId)?.actor).toBe("user");

    view = await t.drive();
    expect(view.features.every((f) => f.state === "accepted")).toBe(true);
    expect(view.status).toBe("completed");
    expect(readFileSync(join(t.root, "core.txt"), "utf8")).toStartWith("ready v2");
    // Every run of the initiative is linked: three originals, the re-plan of core and the rebase of api.
    expect(t.initiatives.store.links("values").map((l) => `${l.feature_id}:${l.origin}`)).toEqual([
      "core:start",
      "api:start",
      "docs:start",
      "core:replan",
      "api:rebase",
    ]);
  }, 30000);

  test("the shared budget is split equally between features of the same size", async () => {
    // One workflow for all three, so their estimates, and so their token shares, are the same.
    const medium = plan(threeFeatures.features.map((f) => ({ ...f, size: "medium" as const, workflow: "sdd" })));
    const t = setup(medium, 1000);
    // A share must hold a plan step's reservation (its prompt plus the profile's output cap,
    // about 28000 tokens), with room for the profiles' instructions to grow.
    const budget = { maxTotalTokens: 180000, maxAgentCalls: 90, maxActiveMs: 900000 };
    let view = await t.start({ plan: medium, budget });
    expect(view.budget.limits).toEqual(budget);
    await t.approveSplit();
    view = t.initiatives.view("values");
    expect(view.budget.unstartedFeatures).toBe(3);
    expect(view.budget.nextShare).toEqual({ tokens: 60000, calls: 30, activeMs: 300000 });
    view = await t.drive();
    const coreRun = t.featureOf(view, "core").runId ?? "";
    const corePolicy = JSON.parse(t.workflows.store.run(coreRun).policy_json) as RunPolicy;
    expect(corePolicy.maxTotalTokens).toBe(60000);
    expect(corePolicy.maxAgentCalls).toBe(30);
    expect(corePolicy.autoApproval ?? null).toBeNull();
    await t.approveFeature("core");
    view = await t.drive();
    // core finished: its usage counts. api's run is open: its whole limit is held back.
    const core = t.featureOf(view, "core").usage;
    expect(core.tokens).toBeGreaterThan(0);
    const apiRun = t.featureOf(view, "api").runId ?? "";
    const apiPolicy = JSON.parse(t.workflows.store.run(apiRun).policy_json) as RunPolicy;
    expect(apiPolicy.maxTotalTokens).toBe(Math.floor((budget.maxTotalTokens - core.tokens) / 2));
    // Calls grow past the equal share into what docs does not need: its floor is the policy's
    // 40 calls per medium run (#1327).
    const left = budget.maxAgentCalls - core.calls;
    expect(apiPolicy.maxAgentCalls).toBe(Math.max(Math.floor(left / 2), left - Math.min(Math.floor(left / 2), policy.maxAgentCalls)));
    const api = t.featureOf(view, "api").usage;
    expect(view.budget.used).toEqual({
      tokens: core.tokens + api.tokens,
      calls: core.calls + api.calls,
      activeMs: core.activeMs + api.activeMs,
    });
    expect(view.budget.reserved.tokens).toBe(apiPolicy.maxTotalTokens - api.tokens);
    expect(view.budget.remaining.tokens).toBe(budget.maxTotalTokens - core.tokens - apiPolicy.maxTotalTokens);
    expect(view.budget.nextShare?.tokens).toBe(view.budget.remaining.tokens);
  });

  test("a feature cannot start when the shared budget is exhausted until it is extended", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures, budget: { maxTotalTokens: 2000, maxAgentCalls: 2, maxActiveMs: 900000 } });
    await t.approveSplit();
    let view = await t.drive();
    expect(view.next.kind).toBe("blocked");
    expect(view.next.message).toContain("shared budget is exhausted");
    expectRecovery(view.next.message, view.next.recovery, "extend");
    expect(view.features.every((f) => f.runId === null)).toBe(true);
    view = await t.initiatives.extendBudget("values", t.id(), { maxTotalTokens: 300000, maxAgentCalls: 90 });
    expect(view.next.kind).toBe("start");
    await expect(t.initiatives.extendBudget("values", t.id(), { maxAgentCalls: 1 })).rejects.toThrow("only be raised");
  });

  test("tiered approval auto-approves a feature spec that stays within its boundary only", async () => {
    const t = setup();
    t.executor.extraWrites.api = "outside.txt";
    await t.start({ plan: threeFeatures, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    await t.approveSplit();
    // core and the rest stay inside their boundary paths: no person is asked.
    let view = await t.drive();
    const coreRun = t.featureOf(view, "core").runId ?? "";
    expect(t.featureOf(view, "core").state).toBe("accepted");
    expect(t.workflows.store.requests(coreRun).find((r) => r.kind === "approval")?.actor).toBe("auto-approval");
    // api plans a write outside its boundary, so its approval goes to a person.
    const api = t.featureOf(view, "api");
    expect(api.state).toBe("needs_decision");
    const pending = t.workflows.store.requests(api.runId ?? "").find((r) => r.kind === "approval" && r.status === "pending");
    expect(pending?.body_json).toContain("outside.txt");
    await t.approveFeature("api");
    view = await t.drive();
    expect(view.status).toBe("completed");
  }, 30000);

  test("a tiered feature without boundary paths asks a person and says why (#1467)", async () => {
    const pathless = plan([feature("core", [], []), feature("api", ["core"]), feature("docs")]);
    const t = setup(pathless);
    await t.start({ plan: pathless, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    await t.approveSplit();
    const view = await t.drive();
    const core = t.featureOf(view, "core");
    expect(core.state).toBe("needs_decision");
    const pending = t.workflows.store.requests(core.runId ?? "").find((r) => r.kind === "approval" && r.status === "pending");
    expect(JSON.parse(pending?.body_json ?? "{}").autoApproval).toEqual({
      declined: ["The approved split names no boundary paths for feature core, so tiered approval has no paths to allow and a person approves its plan."],
    });
    expect(JSON.parse(t.workflows.store.run(core.runId ?? "").policy_json).autoApproval).toBeNull();
  }, 30000);

  test("a rebased tiered feature's decline reason is stored with its run (#1467)", () => {
    const settings = { basePolicy: policy, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } } as unknown as InitiativeSettings;
    const share = { tokens: 2_000_000, calls: 200, activeMs: 3_600_000 };
    const api = feature("api", ["core"]);
    const rebased = featurePolicy(settings, share, api, true);
    expect(rebased.autoApproval).toBeNull();
    expect(featureApprovalDeclined(settings, api, true, rebased)).toBe(
      "Feature api was rebased onto new upstream results, so a person approves its plan again; tiered approval covers only the feature's first run.",
    );
    // A first run within its boundary has auto approval, and tiered approval off gives no reason.
    expect(featureApprovalDeclined(settings, api, false, featurePolicy(settings, share, api, false))).toBeNull();
    const off = { ...settings, featureAutoApproval: null } as unknown as InitiativeSettings;
    expect(featureApprovalDeclined(off, api, true, featurePolicy(off, share, api, true))).toBeNull();
  });

  // Bench round 39, dieodds (#1394): the cli feature depends on others, so its approval matched the
  // csproj its boundary names against the empty deliverables text and asked a person.
  test("tiered approval auto-approves a dependent feature's edit of a manifest its boundary names", async () => {
    const csproj = "src/Api/Api.csproj";
    const split = plan([feature("core"), feature("api", ["core"], ["api.txt", csproj]), feature("docs")]);
    const t = setup(split);
    mkdirSync(join(t.root, "src", "Api"), { recursive: true });
    writeFileSync(join(t.root, csproj), "<Project />\n");
    // Source code in the workspace: a scaffold's manifests are edited without a person anyway.
    writeFileSync(join(t.root, "src", "Api", "Program.cs"), "return 0;\n");
    t.executor.extraWrites.api = csproj;
    await t.start({ plan: split, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    await t.approveSplit();
    let view = await t.drive();
    for (let i = 0; i < 4 && view.status !== "completed"; i++) view = await t.drive();
    const apiRun = t.featureOf(view, "api").runId ?? "";
    const approval = t.workflows.store.requests(apiRun).find((r) => r.kind === "approval");
    expect(approval?.actor).toBe("auto-approval");
    expect(view.status).toBe("completed");
  }, 30000);

  // Bench round 40, tonemath core (#1458): a boundary of 22 files is more than a definition's auto
  // approval accepts, so the feature's tiered approval was dropped without a reason and a person
  // waited 14 minutes for a plan inside the approved boundary.
  test("tiered approval auto-approves a feature whose boundary names more than 20 files", async () => {
    const modules = Array.from({ length: 21 }, (_, i) => `core-m${String(i + 1).padStart(2, "0")}.txt`);
    const split = plan([feature("core", [], ["core.txt", ...modules]), feature("api", ["core"]), feature("docs")]);
    const t = setup(split);
    t.executor.extraTasks.core = modules;
    await t.start({ plan: split, featureAutoApproval: { maxTasks: 8, maxFiles: 14 } });
    await t.approveSplit();
    let view = await t.drive();
    for (let i = 0; i < 4 && view.status !== "completed"; i++) view = await t.drive();
    const coreRun = t.featureOf(view, "core").runId ?? "";
    expect(JSON.parse(t.workflows.store.run(coreRun).policy_json).autoApproval?.limits).toMatchObject({ maxTasks: 24, maxFiles: 22 });
    expect(t.workflows.store.requests(coreRun).find((r) => r.kind === "approval")?.actor).toBe("auto-approval");
    expect(view.status).toBe("completed");
  }, 30000);

  // Bench round 42, fecsmith front (#1504): a boundary of globs and a few files counted only its
  // literal paths, so a 19-file plan inside it went to a person under 8-task, 14-file limits.
  test("tiered approval auto-approves a plan inside a glob boundary that is larger than the limits", async () => {
    const modules = Array.from({ length: 18 }, (_, i) => `core-m${String(i + 1).padStart(2, "0")}.txt`);
    const split = plan([feature("core", [], ["core.txt", "core-*.txt"]), feature("api", ["core"]), feature("docs")]);
    const t = setup(split);
    t.executor.extraTasks.core = modules;
    await t.start({ plan: split, featureAutoApproval: { maxTasks: 8, maxFiles: 14 } });
    await t.approveSplit();
    let view = await t.drive();
    for (let i = 0; i < 4 && view.status !== "completed"; i++) view = await t.drive();
    const coreRun = t.featureOf(view, "core").runId ?? "";
    expect(t.workflows.store.state(coreRun).graph?.tasks.length).toBe(19);
    expect(t.workflows.store.requests(coreRun).find((r) => r.kind === "approval")?.actor).toBe("auto-approval");
    expect(view.status).toBe("completed");
  }, 30000);

  test("an initiative whose features run in worktrees is refused at start in a folder without Git (#1345)", async () => {
    const t = setup();
    const worktreePolicy: RunPolicy = { ...policy, executionMode: "worktree" };
    let fault: unknown = null;
    try {
      await t.start({ policy: worktreePolicy });
    } catch (error) {
      fault = error;
    }
    // A temporary folder inside a repository is not a folder without Git; nothing to check there.
    if (fault === null) return;
    expect(fault).toBeInstanceOf(WorkflowFault);
    expect((fault as WorkflowFault).details).toMatchObject({ reason: "git_required", gitInit: true });
    expect(t.initiatives.list()).toEqual([]);
  });

  test("in worktrees, independent features run side by side and a dependent one starts from their merged results", async () => {
    const joined = plan([feature("a"), feature("b"), feature("c", ["a", "b"])]);
    const t = setup(joined);
    repository(t.root);
    t.executor.rendezvous = 2;
    const worktreePolicy: RunPolicy = { ...policy, executionMode: "worktree" };
    await t.start({ plan: joined, policy: worktreePolicy, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    let view = await t.approveSplit();
    expect(view.parallelRuns).toBe(2);
    expect(view.next.kind).toBe("start");

    view = await t.drive();
    expect(view.status).toBe("completed");
    // a and b were implemented at the same time; c waited for both.
    expect(t.executor.maxActive).toBe(2);
    expect(t.executor.seen.a).toEqual([]);
    expect(t.executor.seen.b).toEqual([]);
    // c's worktree started from HEAD merged with a's and b's accepted results.
    expect(t.executor.seen.c).toEqual(["a.txt", "b.txt"]);
    const cRun = t.featureOf(view, "c").runId ?? "";
    const base = t.workflows.store.state(cRun).worktree?.baseHead ?? "";
    expect(git(t.root, "show", `${base}:a.txt`)).toStartWith("ready");
    expect(git(t.root, "show", `${base}:b.txt`)).toStartWith("ready");
    expect(git(t.root, "show", `baked/wf/${cRun}:c.txt`)).toStartWith("ready");
    // The working copy is never written.
    expect(existsSync(join(t.root, "a.txt"))).toBe(false);
    expect(git(t.root, "status", "--porcelain")).toBe("");
  }, 30000);

  // Bench round 44, cayleykit (#1535): features started in waves behind Promise.allSettled, so a
  // freed slot stayed empty until the slowest sibling stopped (8.3 slot-minutes), and the ready
  // feature on the critical path waited behind one earlier in plan order.
  describe("dispatch on every stop, longest remaining path first (#1535)", () => {
    class TimedExecutor extends InitiativeExecutor {
      /** A feature's implementation holds until these features have started theirs, or 30 s pass. */
      waits: Record<string, string[]> = {};
      starts: string[] = [];
      /** `start:NAME` and `end:NAME` in the order they happened. */
      events: string[] = [];
      override async execute(request: ExecutionRequest) {
        const name = request.task?.writes[0]?.path.replace(/\.txt$/, "");
        if (request.profile.output !== "implementation" || !name) return super.execute(request);
        this.starts.push(name);
        this.events.push(`start:${name}`);
        const deadline = Date.now() + 30_000;
        while (!(this.waits[name] ?? []).every((other) => this.starts.includes(other)) && Date.now() < deadline)
          await Bun.sleep(20);
        try {
          return await super.execute(request);
        } finally {
          this.events.push(`end:${name}`);
        }
      }
    }
    const cayley = plan([
      feature("chain"),
      feature("finite"),
      feature("perm", ["chain"]),
      feature("chainc", ["chain"]),
      feature("finitec", ["chain", "finite"]),
      feature("entry", ["finitec"]),
    ]);

    async function run(maxParallelRuns: number) {
      const t = setup(cayley, 100, (root) => new TimedExecutor(root, cayley));
      repository(t.root);
      // As in the round, finite outlasts chain and the command features outlast finite. A feature
      // holds until the ones that should start while it runs have started, so the order does not
      // depend on the machine's speed; before the fix they could not start and it held 30 s.
      t.executor.waits =
        maxParallelRuns === 2
          ? { finite: ["perm"], perm: ["finitec"] }
          : { finite: ["perm", "chainc"], perm: ["finitec"] };
      if (t.workflows.config.workflows) t.workflows.config.workflows.maxParallelRuns = maxParallelRuns;
      const worktreePolicy: RunPolicy = { ...policy, executionMode: "worktree" };
      await t.start({ plan: cayley, policy: worktreePolicy, featureAutoApproval: { maxTasks: 5, maxFiles: 5 }, budget: { maxTotalTokens: 6_000_000, maxAgentCalls: 2000, maxActiveMs: 6_000_000 } });
      const approved = await t.approveSplit();
      expect(approved.parallelRuns).toBe(maxParallelRuns);
      const view = await t.drive();
      expect(view.status).toBe("completed");
      return t.executor;
    }

    test("with two slots, a freed slot is refilled at once and the critical-path feature goes first", async () => {
      const executor = await run(2);
      // perm starts when chain stops, while finite still runs; before, it waited for finite too.
      // chain and finite start together, in either order.
      expect(executor.starts.slice(0, 2).sort()).toEqual(["chain", "finite"]);
      expect(executor.starts[2]).toBe("perm");
      expect(executor.events.indexOf("start:perm")).toBeLessThan(executor.events.indexOf("end:finite"));
      // When finite stops, finitec (on the path to entry) starts before chainc, which is earlier in plan order.
      expect(executor.starts.indexOf("finitec")).toBeLessThan(executor.starts.indexOf("chainc"));
      expect(executor.maxActive).toBeLessThanOrEqual(2);
    }, 120_000);

    test("with three slots, every ready feature starts as soon as a slot frees", async () => {
      const executor = await run(3);
      expect(executor.starts.slice(0, 2).sort()).toEqual(["chain", "finite"]);
      expect(executor.starts.slice(2, 4).sort()).toEqual(["chainc", "perm"]);
      // Both start when chain stops, while finite still runs.
      expect(executor.events.indexOf("start:chainc")).toBeLessThan(executor.events.indexOf("end:finite"));
      // finitec takes the slot finite frees while perm and chainc still run.
      expect(executor.events.indexOf("start:finitec")).toBeLessThan(executor.events.indexOf("end:perm"));
      expect(executor.maxActive).toBeLessThanOrEqual(3);
    }, 120_000);
  });

  test("a small worktree initiative bounds Git process creation (#1589)", async () => {
    const t = setup();
    repository(t.root);
    const spawns = spyOn(Bun, "spawn");
    try {
      await t.start({ plan: threeFeatures, policy: { ...policy, executionMode: "worktree" }, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
      await t.approveSplit();
      expect((await t.drive()).status).toBe("completed");
      const calls = spawns.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd[0] === "git");
      // The original runtime started over 350 Git processes for these three one-file features.
      expect(calls.length).toBeLessThanOrEqual(200);
    } finally {
      spawns.mockRestore();
    }
  }, 30000);

  test("siblings that share a file run in order, so a dependent's merge of their results succeeds (#1336)", async () => {
    // Bench round 34, sketchfold: hll, frequent, hist and member each added a `pub mod` line to
    // src/lib.rs with no dependency between them; their accepted results conflicted when sketch
    // started, and 3.8M tokens of their runs were redone. Siblings sharing a file now run in order.
    const shared = plan([feature("a", [], ["a.txt", "shared.txt"]), feature("b", [], ["b.txt", "shared.txt"]), feature("c", ["a", "b"])]);
    const t = setup(shared);
    repository(t.root);
    t.executor.extraWrites = { a: "shared.txt", b: "shared.txt" };
    const worktreePolicy: RunPolicy = { ...policy, executionMode: "worktree" };
    await t.start({ plan: shared, policy: worktreePolicy, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    let view = await t.approveSplit();
    expect(t.featureOf(view, "b").dependsOn).toEqual(["a"]);
    expect(t.initiatives.events("values").find((e) => e.type === "split.sequenced")?.payload).toMatchObject({
      added: [{ featureId: "b", dependsOn: "a", paths: ["shared.txt"] }],
    });
    view = await t.drive();
    expect(view.status).toBe("completed");
    // b started from a's result and changed its shared.txt; c merged both without a conflict.
    expect(t.executor.seen.b).toEqual(["a.txt", "shared.txt"]);
    const cRun = t.featureOf(view, "c").runId ?? "";
    expect(git(t.root, "show", `baked/wf/${cRun}:shared.txt`)).toBe("ready v1 (write 2)");
  }, 30000);

  test("conflicting upstream results block the dependent feature with the repair instead of failing every drive (#1336)", async () => {
    // Different globs are not compared, so these siblings still run side by side.
    const overlapping = plan([feature("a", [], ["a.txt", "s*.txt"]), feature("b", [], ["b.txt", "sh*.txt"]), feature("c", ["a", "b"])]);
    const t = setup(overlapping);
    repository(t.root);
    t.executor.extraWrites = { a: "shared.txt", b: "shared.txt" };
    const worktreePolicy: RunPolicy = { ...policy, executionMode: "worktree" };
    await t.start({ plan: overlapping, policy: worktreePolicy, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    await t.approveSplit();
    let view = await t.drive();
    expect(t.featureOf(view, "a").state).toBe("accepted");
    expect(t.featureOf(view, "b").state).toBe("accepted");
    const c = t.featureOf(view, "c");
    expect(c.state).toBe("blocked");
    expect(c.runId).toBeNull();
    expect(c.blockers[0]).toContain("conflict in shared.txt");
    expect(c.blockers[0]).toContain("baked workflow initiative merge --features a,b");
    expect(view.next).toMatchObject({ kind: "blocked" });
    expect(view.next.message).toContain("conflict in shared.txt");
    // Driving again reports the same block; nothing is thrown and nothing starts.
    view = await t.drive();
    expect(t.featureOf(view, "c").state).toBe("blocked");
    expect(t.initiatives.events("values").filter((e) => e.type === "feature.upstream_conflict").length).toBe(1);
  }, 30000);

  test("upstream results merge onto HEAD the same way every time, and conflicting ones are named", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-merged-base-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    repository(root);
    const head = git(root, "rev-parse", "HEAD");
    const commit = (branch: string, file: string, text: string) => {
      git(root, "checkout", "-q", "-b", branch, head);
      writeFileSync(join(root, file), text);
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", branch);
      return git(root, "rev-parse", "HEAD");
    };
    const a = commit("a", "a.txt", "a");
    const b = commit("b", "b.txt", "b");
    const x = commit("x", "README.md", "x");
    const y = commit("y", "README.md", "y");
    git(root, "checkout", "-q", "main");
    expect(await mergedBase(root, [a], 1700000000)).toEqual({ commit: a });
    const merged = await mergedBase(root, [a, b], 1700000000);
    if (!("commit" in merged)) throw new Error("expected a merge");
    expect(git(root, "show", `${merged.commit}:a.txt`)).toBe("a");
    expect(git(root, "show", `${merged.commit}:b.txt`)).toBe("b");
    expect(await mergedBase(root, [a, b], 1700000000)).toEqual(merged);
    expect(await mergedBase(root, [x, y], 1700000000)).toEqual({ conflicts: ["README.md"], between: [x, y] });
  });

  test("inline, feature runs stay one at a time", async () => {
    const t = setup();
    // A second implementation would begin while the first waits; inline, none does.
    t.executor.rendezvous = 2;
    t.executor.rendezvousMs = 300;
    await t.start({ plan: threeFeatures, featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
    const view = await t.approveSplit();
    expect(view.parallelRuns).toBe(1);
    expect((await t.drive()).status).toBe("completed");
    expect(t.executor.maxActive).toBe(1);
  }, 30000);

  test("tiered approval is refused for a v2 feature workflow, whose auto approval is its own", async () => {
    const t = setup();
    await expect(
      t.start({ plan: threeFeatures, workflowId: "standard", featureAutoApproval: { maxTasks: 5, maxFiles: 5 } }),
    ).rejects.toThrow("Tiered approval needs a schema 1 feature workflow");
    expect(t.initiatives.list()).toEqual([]);
  });

  test("auto approval is off by default", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures });
    await t.approveSplit();
    const view = await t.drive();
    const runId = t.featureOf(view, "core").runId ?? "";
    expect(JSON.parse(t.workflows.store.run(runId).policy_json).autoApproval ?? null).toBeNull();
    expect(t.featureOf(view, "core").state).toBe("needs_decision");
  });

  test("a feature with an issue starts its run from it, so delivery closes it; the plan digest stays the same", async () => {
    const issue = { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/issues/7", title: "Core values" };
    const plain = setup();
    const without = await plain.start({ plan: threeFeatures });
    const t = setup();
    const view0 = await t.start({ plan: threeFeatures, featureIssues: { core: issue } });
    expect(view0.planDigest).toBe(without.planDigest);
    await t.approveSplit();
    const view = await t.drive();
    const runId = t.featureOf(view, "core").runId ?? "";
    expect(t.workflows.store.state(runId).issue).toEqual(issue);
    await expect(t.start({ initiativeId: "other", plan: threeFeatures, featureIssues: { nope: issue } })).rejects.toThrow("nope");
    await expect(t.start({ initiativeId: "third", featureIssues: { core: issue } })).rejects.toThrow("plan");
  });

  test("re-planning the split after approval keeps unchanged finished features", async () => {
    const t = setup();
    await t.start({ plan: plan([feature("core"), feature("api", ["core"]), feature("docs"), feature("extra")]) });
    await t.approveSplit();
    await t.drive();
    await t.approveFeature("core");
    let view = await t.drive();
    const coreRun = t.featureOf(view, "core").runId;
    expect(t.featureOf(view, "core").state).toBe("accepted");
    await expect(t.initiatives.edit("values", t.id(), { op: "remove", featureId: "extra" })).rejects.toThrow("Pause");
    await t.initiatives.pause("values", t.id());
    view = await t.initiatives.edit("values", t.id(), { op: "remove", featureId: "extra" });
    expect(view.status).toBe("awaiting_approval");
    view = await t.initiatives.edit("values", t.id(), { op: "rename", featureId: "core", title: "Core values" });
    view = await t.approveSplit();
    expect(view.status).toBe("active");
    expect(view.features.map((f) => f.id)).toEqual(["core", "api", "docs"]);
    // A rename keeps core's accepted result; api's open run keeps going.
    expect(t.featureOf(view, "core").runId).toBe(coreRun);
    expect(t.featureOf(view, "core").state).toBe("accepted");
    expect(t.featureOf(view, "api").state).toBe("needs_decision");
  });
});

describe("initiative CLI", () => {
  test("parses subcommands with the workflow CLI conventions", () => {
    const args = parseInitiativeArgs(["start", "values", "--prompt", "Add values", "--tiered-approval", "--max-tasks", "3"]);
    expect(args).toEqual({ command: "start", positional: ["values"], flags: { prompt: "Add values", "tiered-approval": true, "max-tasks": "3" } });
    expect(() => parseInitiativeArgs(["start", "values"])).toThrow("exactly one of --prompt");
    expect(() => parseInitiativeArgs(["start", "values", "--prompt", "x", "--max-files", "2"])).toThrow("--tiered-approval");
    expect(() => parseInitiativeArgs(["start", "values", "--prompt", "x", "--budget-tokens", "9"])).toThrow("all of --budget-tokens");
    expect(() => parseInitiativeArgs(["pause", "values", "--expected-revision", "x"])).toThrow("integer");
    expect(() => parseInitiativeArgs(["pause", "values", "--digest", "x"])).toThrow("invalid option --digest");
    expect(() => parseInitiativeArgs(["approve"])).toThrow("expects 1 positional");
    expect(() => parseInitiativeArgs(["launch", "values"])).toThrow("Unknown initiative command");
    expect(workflowHelp).toContain("initiative <command>");
    expect(parseInitiativeArgs(["reroute", "values", "--model", "spare/model", "--resume", "--expected-revision", "4"]).flags).toEqual({
      model: "spare/model",
      resume: true,
      "expected-revision": "4",
    });
    for (const command of ["start", "merge", "split", "remove", "rename", "approve", "drive", "pause", "resume", "replan", "extend", "reroute"])
      expect(initiativeHelp).toContain(command);
  });

  test("starts from a plan file, edits and approves the split, and reports exit codes", async () => {
    const t = setup();
    writeFileSync(join(t.root, "split.json"), JSON.stringify(threeFeatures));
    const signal = new AbortController().signal;
    const run = (argv: string[]) => executeInitiativeCommand(t.initiatives, parseInitiativeArgs(argv), signal);
    let view = (await run(["start", "values", "--prompt", "Add values", "--plan", "split.json"])) as InitiativeView;
    expect(view.status).toBe("awaiting_approval");
    expect(initiativeExit(view)).toBe(3);
    const first = view.planDigest;
    view = (await run(["rename", "values", "--feature", "docs", "--title", "Docs", "--expected-revision", String(view.revision)])) as InitiativeView;
    expect(view.planDigest).not.toBe(first);
    const request = view.pendingDecisions.find((d) => d.scope === "initiative");
    view = (await run(["approve", "values", "--request", request?.requestId ?? "", "--digest", request?.digest ?? "", "--expected-revision", String(view.revision)])) as InitiativeView;
    expect(view.status).toBe("active");
    expect(view.next.kind).toBe("decide");
    expect(initiativeExit(view)).toBe(3);
    view = (await run(["pause", "values", "--expected-revision", String(view.revision)])) as InitiativeView;
    expect(initiativeExit(view)).toBe(130);
    const listed = (await run(["list"])) as { initiativeId: string; status: string }[];
    expect(listed.map((i) => [i.initiativeId, i.status])).toEqual([["values", "paused"]]);
    const events = (await run(["events", "values"])) as { type: string }[];
    expect(events.map((e) => e.type)).toContain("plan.revised");
  });
});

describe("scenario: a bench initiative records its model calls (#1715)", () => {
  test("--record-model-calls carries into the feature runs' policies", async () => {
    const t = setup();
    writeFileSync(join(t.root, "split.json"), JSON.stringify(threeFeatures));
    const signal = new AbortController().signal;
    const run = (argv: string[]) => executeInitiativeCommand(t.initiatives, parseInitiativeArgs(argv), signal);
    let view = (await run(["start", "values", "--prompt", "Add values", "--plan", "split.json", "--record-model-calls"])) as InitiativeView;
    const request = view.pendingDecisions.find((d) => d.scope === "initiative");
    view = (await run(["approve", "values", "--request", request?.requestId ?? "", "--digest", request?.digest ?? "", "--expected-revision", String(view.revision)])) as InitiativeView;
    const runIds = view.features.flatMap((f) => (f.runId ? [f.runId] : []));
    expect(runIds.length).toBeGreaterThan(0);
    for (const runId of runIds)
      expect(JSON.parse(t.workflows.store.run(runId).policy_json).modelCalls).toEqual({ record: true });
    expect(initiativeHelp).toContain("--record-model-calls");
  });
});

describe("initiative reroute", () => {
  const runModel = (workflows: NativeWorkflowService, runId: string): string => {
    const row = workflows.store.latestArtifact(runId, "routing.json");
    if (!row) throw new Error("No routing record");
    return RoutingRecordSchema.parse(JSON.parse(workflows.store.readArtifact(runId, row.id))).runModel;
  };

  test("moves stopped runs and the features started later to the new model", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures });
    await t.approveSplit();
    let view = await t.drive();
    const core = t.featureOf(view, "core");
    expect(core.state).toBe("needs_decision");
    expect(runModel(t.workflows, core.runId ?? "")).toBe("fixture/model");

    view = await t.initiatives.reroute("values", t.id(), { model: "spare/model" });
    expect(view.model).toBe("spare/model");
    expect(runModel(t.workflows, core.runId ?? "")).toBe("spare/model");
    const runEvent = t.workflows.store.events(core.runId ?? "").find((e) => e.type === "run.rerouted");
    expect(runEvent?.type === "run.rerouted" && runEvent.payload.runModel).toEqual({ from: "fixture/model", to: "spare/model" });
    const event = t.initiatives.events("values").find((e) => e.type === "initiative.rerouted");
    expect(event?.payload).toEqual({
      model: { from: null, to: "spare/model" },
      runs: [{ featureId: "core", runId: core.runId, result: "rerouted", from: "fixture/model" }],
    });
    // The approved split stays approved; only the model changed.
    expect(view.status).toBe("active");
    expect(view.approvedPlanRevision).toBe(1);

    await t.approveFeature("core");
    view = await t.drive();
    const later = view.features.filter((f) => f.id !== "core" && f.runId);
    expect(later.length).toBeGreaterThan(0);
    for (const feature of later) expect(runModel(t.workflows, feature.runId ?? "")).toBe("spare/model");

    await expect(t.initiatives.reroute("values", t.id(), { model: "spare/model" })).rejects.toThrow("already uses this model");
  });

  test("a feature blocked by its provider continues on the new model with --resume", async () => {
    const t = setup();
    t.executor.refused.add("fixture/model");
    await t.start({ plan: threeFeatures });
    await t.approveSplit();
    await t.drive();
    await t.approveFeature("core");
    let view = await t.drive();
    const core = t.featureOf(view, "core");
    expect(core.runStatus).toBe("blocked");
    expect(core.runReason).toBe("provider_account");
    view = await t.initiatives.reroute("values", t.id(), { model: "spare/model", resume: true });
    expect(t.workflows.store.run(core.runId ?? "").status).not.toBe("blocked");
    view = await t.drive();
    expect(t.featureOf(view, "core").state).toBe("accepted");
  });

  // dieodds R39 (#1395): the Codex usage limit reset five days later, and the initiative said only
  // "blocked (provider_unavailable)" after 1, 3 and 9 minute resumes.
  test("a feature stopped by a usage limit names the limit and its reset in the initiative", async () => {
    const t = setup();
    t.executor.refused.add("fixture/model");
    t.executor.refusal =
      "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 10:55 AM.";
    await t.start({ plan: threeFeatures });
    await t.approveSplit();
    await t.drive();
    await t.approveFeature("core");
    const view = await t.drive();
    const core = t.featureOf(view, "core");
    expect(core.runReason).toBe("provider_account");
    expect(core.blockers[0]).toContain("reached its usage limit until Oct 22nd, 2026 10:55 AM");
    expect(core.blockers[0]).toContain("baked workflow reroute");
    expect(view.next).toMatchObject({ kind: "blocked" });
    expect(JSON.stringify(view.next)).toContain("usage limit");
  });

  test("a split waiting for approval is proposed again, since its digest covers the model", async () => {
    const t = setup();
    let view = await t.start({ plan: threeFeatures });
    const first = view.pendingDecisions.find((d) => d.scope === "initiative");
    view = await t.initiatives.reroute("values", t.id(), { model: "spare/model" });
    const second = view.pendingDecisions.find((d) => d.scope === "initiative");
    expect(view.planRevision).toBe(2);
    expect(second?.digest).not.toBe(first?.digest);
    expect(t.initiatives.store.requests("values").find((r) => r.id === first?.requestId)?.status).toBe("superseded");
    view = await t.approveSplit();
    view = await t.drive();
    expect(runModel(t.workflows, t.featureOf(view, "core").runId ?? "")).toBe("spare/model");
  });

  test("refuses while a run executes, after completion, on a stale revision, and replays a repeated command", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures });
    await t.approveSplit();
    const view = await t.drive();
    const runId = t.featureOf(view, "core").runId ?? "";
    await expect(t.initiatives.reroute("values", { commandId: newId(), expectedRevision: view.revision - 1 }, { model: "spare/model" })).rejects.toThrow("revision changed");
    await expect(t.initiatives.reroute("values", t.id(), { model: "none" })).rejects.toThrow("Select a model");
    const status = t.workflows.store.run(runId).status;
    t.workflows.store.transition(runId, "running");
    await expect(t.initiatives.reroute("values", t.id(), { model: "spare/model" })).rejects.toThrow("pause the initiative");
    expect(runModel(t.workflows, runId)).toBe("fixture/model");
    t.workflows.store.transition(runId, status);

    const command = t.id();
    const first = await t.initiatives.reroute("values", command, { model: "spare/model" });
    const again = await t.initiatives.reroute("values", command, { model: "spare/model" });
    expect(again.revision).toBe(first.revision);
    expect(t.initiatives.events("values").filter((e) => e.type === "initiative.rerouted")).toHaveLength(1);

    t.initiatives.store.setStatus("values", "completed");
    await expect(t.initiatives.reroute("values", t.id(), { model: "other/model" })).rejects.toThrow("completed cannot switch");
  });

  test("--resume continues a paused initiative through the CLI", async () => {
    const t = setup();
    await t.start({ plan: threeFeatures });
    await t.approveSplit();
    let view = await t.drive();
    view = await t.initiatives.pause("values", t.id());
    expect(view.status).toBe("paused");
    const args = parseInitiativeArgs(["reroute", "values", "--model", "spare/model", "--resume", "--expected-revision", String(view.revision)]);
    view = (await executeInitiativeCommand(t.initiatives, args, new AbortController().signal)) as InitiativeView;
    expect(view.status).toBe("active");
    expect(view.model).toBe("spare/model");
    expect(initiativeExit(view)).toBe(3);
  });
});

describe("scenario: a split that fixes a crate skeleton (#1461)", () => {
  // Bench round 40, tonemath: the brief fixed 20 module stubs and a lib.rs of their mod lines.
  // The decomposer now lists them as the first feature's skeleton, and that feature's run writes
  // them in the host instead of an agent task per stub.
  const skeleton = [
    { path: "src/lib.rs", content: "pub mod a;\npub mod b;\n" },
    { path: "src/a.rs", content: "// a: filled by api.\n" },
    { path: "src/b.rs", content: "// b: filled by docs.\n" },
  ];
  const split = plan([
    { ...feature("core", [], ["core.txt", "src/lib.rs", "src/a.rs", "src/b.rs"]), skeleton },
    feature("api", ["core"]),
    feature("docs", ["core"]),
  ]);

  /**
   * A planner that writes the host files in a task of its own. With `ignore`, its first plan
   * leaves them out and gets the submission problems back, as submit_result returns them.
   */
  class SkeletonPlanner extends InitiativeExecutor {
    ignore = 0;
    hostPrompts: string[] = [];
    problems: string[] = [];
    override async execute(request: ExecutionRequest) {
      const result = await super.execute(request);
      if (request.profile.output !== "plan") return result;
      const [documents, attempt] = request.prompt.split("\n").slice(-2);
      const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { extra?: { hostFiles?: { files: typeof skeleton } } };
      const hostFiles = data.extra?.hostFiles;
      if (!hostFiles) return result;
      this.hostPrompts.push(request.prompt);
      if (this.ignore-- > 0) {
        this.problems = request.validate?.(result.output) ?? [];
        if (!this.problems.length) return result;
      }
      const output = result.output as { taskGraph: { tasks: { id: string; dependsOn: string[]; writes: unknown[] }[] } };
      const [own] = output.taskGraph.tasks;
      if (!own) return result;
      output.taskGraph.tasks = [
        { ...own, id: "T001", title: "Lay down the crate skeleton", writes: hostFiles.files.map((f) => ({ path: f.path, action: "create", content: f.content })) },
        { ...own, id: "T002", dependsOn: ["T001"] },
      ];
      return result;
    }
  }

  const skeletonSetup = () => setup(split, 100, (root) => new SkeletonPlanner(root, split));

  async function complete(t: ReturnType<typeof skeletonSetup>) {
    await t.start({ plan: split, keepFeatures: true });
    let view = await t.approveSplit();
    for (let i = 0; i < 16 && view.status !== "completed"; i++) {
      view = await t.drive();
      const waiting = view.pendingDecisions.find((d) => d.scope === "feature" && d.kind === "approval");
      if (waiting?.featureId) await t.approveFeature(waiting.featureId);
    }
    return view;
  }

  test("the first feature's run writes the skeleton in the host, and the initiative completes", async () => {
    const t = skeletonSetup();
    const view = await complete(t);
    expect(view.status).toBe("completed");
    expect(t.featureOf(view, "core").skeleton).toEqual(skeleton);
    for (const file of skeleton) expect(readFileSync(join(t.root, file.path), "utf8")).toBe(file.content);
    // No implementer wrote a skeleton file: only the features' own value files.
    expect(Object.keys(t.executor.writes).sort()).toEqual(["api.txt", "core.txt", "docs.txt"]);
    // Only the core run was told about the skeleton.
    expect(t.executor.hostPrompts).toHaveLength(1);
    expect(t.executor.hostPrompts[0]).toContain("The split fixes the whole content of src/lib.rs, src/a.rs, src/b.rs");
    const coreRun = t.featureOf(view, "core").runId ?? "";
    expect(t.workflows.store.state(coreRun).hostFiles).toEqual(skeleton);
    // #1550: the host-written task ran no agent, so the run's history counts only the agent task.
    expect(t.workflows.store.tasks(coreRun).map((task) => task.id)).toEqual(["T001", "T002"]);
    expect(t.workflows.store.history(coreRun)[0]?.taskCount).toBe(1);
  }, 60000);

  test("a plan that does not write the skeleton in the host goes back to the planner", async () => {
    const t = skeletonSetup();
    t.executor.ignore = 1;
    const view = await complete(t);
    expect(view.status).toBe("completed");
    expect(t.executor.problems.join("\n")).toContain("write all of them in one task whose writes carry exactly that content; src/lib.rs, src/a.rs, src/b.rs are not written that way");
    expect(t.executor.problems.join("\n")).not.toContain("Task T001 creates");
    for (const file of skeleton) expect(readFileSync(join(t.root, file.path), "utf8")).toBe(file.content);
    expect(Object.keys(t.executor.writes).sort()).toEqual(["api.txt", "core.txt", "docs.txt"]);
  }, 60000);

  test("a skeleton file is one literal path of its feature's boundary, in one feature only", () => {
    expect(planStructureProblems(split)).toEqual([]);
    const outside = plan([{ ...feature("core"), skeleton: [{ path: "src/lib.rs", content: "" }] }, feature("api"), feature("docs")]);
    expect(planStructureProblems(outside)).toEqual(["core's skeleton file src/lib.rs is outside its boundary paths"]);
    const glob = plan([{ ...feature("core", [], ["src/**"]), skeleton: [{ path: "src/*.rs", content: "" }] }, feature("api"), feature("docs")]);
    expect(planStructureProblems(glob)[0]).toContain("names a glob src/*.rs");
    const twice = plan([
      { ...feature("core", [], ["src/lib.rs"]), skeleton: [{ path: "src/lib.rs", content: "" }] },
      { ...feature("api", [], ["src/**"]), skeleton: [{ path: "src/lib.rs", content: "" }] },
      feature("docs"),
    ]);
    expect(planStructureProblems(twice)).toEqual(["src/lib.rs is in the skeleton of both core and api"]);
    // The skeleton is part of what a run is bound to; a feature without one keeps its digest.
    const core = split.features[0];
    if (!core) throw new Error("no core");
    const { skeleton: _, ...bare } = core;
    expect(featureDigest(core)).not.toBe(featureDigest(bare));
    expect(featureDigest(feature("api"))).toBe(featureDigest({ ...feature("api"), skeleton: [] }));
    // The estimate prices core's own file, not the host-written skeleton: no placeholder either (#1550).
    expect(boundaryPathCounts(split).get("core")).toEqual({ paths: 1, placeholders: 0, skeleton: 3 });
  });

  test("merging keeps every skeleton file, and a split gives each file to the first part that names it", () => {
    const four = plan([...split.features, feature("cli", ["core"])]);
    const merged = applySplitEdit(four, { op: "merge", featureIds: ["core", "api"], id: "core" });
    expect(merged.features.find((f) => f.id === "core")?.skeleton).toEqual(skeleton);
    const parts = applySplitEdit(split, {
      op: "split",
      featureId: "core",
      into: [
        { id: "core", title: "Core", paths: ["core.txt", "src/lib.rs"] },
        { id: "mods", title: "Modules", paths: ["src/a.rs", "src/b.rs", "src/lib.rs", "tests/mods.rs"] },
      ],
    });
    expect(parts.features.find((f) => f.id === "core")?.skeleton?.map((f) => f.path)).toEqual(["src/lib.rs"]);
    expect(parts.features.find((f) => f.id === "mods")?.skeleton?.map((f) => f.path)).toEqual(["src/a.rs", "src/b.rs"]);
    expect(planStructureProblems(parts)).toEqual([]);
  });
});
