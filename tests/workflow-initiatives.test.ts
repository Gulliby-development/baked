import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  applySplitEdit,
  featureDigest,
  type InitiativePlan,
  planSizeProblem,
  planStructureProblems,
  topologicalOrder,
  validateInitiativePlan,
} from "../src/core/workflows/initiatives/plan.js";
import {
  type InitiativeStartRequest,
  InitiativeService,
  type InitiativeView,
  runFeatureId,
} from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { RoutingRecordSchema } from "../src/core/llm/model-routing.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import {
  executeInitiativeCommand,
  initiativeExit,
  initiativeHelp,
  parseInitiativeArgs,
} from "../src/headless/workflow-initiative.js";
import { workflowHelp } from "../src/headless/workflow-parse.js";
import { mergedBase } from "../src/core/workflows/worktree.js";

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
  writes: Record<string, number> = {};
  /** Models whose implementation calls fail as an account without credits. */
  refused = new Set<string>();
  /** The files in each feature's root when it was implemented. */
  seen: Record<string, string[]> = {};
  /** Implementation calls in flight, and the most at once. */
  active = 0;
  maxActive = 0;
  /** An implementation waits (up to `rendezvousMs`) until this many implementations have begun. */
  rendezvous = 0;
  rendezvousMs = 5000;
  private arrived = 0;
  constructor(private root: string, public split: unknown = threeFeatures, private tokens = 100) {}
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
      throw Object.assign(new Error("You have no credits remaining. Add credits to continue."), { statusCode: 429 });
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
            tasks: [{ id: "T001", title: `Create ${path}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
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

function setup(split: unknown = threeFeatures, tokens = 100) {
  const root = mkdtempSync(join(tmpdir(), "baked-initiative-"));
  const executor = new InitiativeExecutor(root, split, tokens);
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

  test("a decomposer split above twelve features is refused with a message to split into stages", async () => {
    const t = setup(plan(Array.from({ length: 13 }, (_, i) => feature(`f${i}`))));
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
    const medium = plan(threeFeatures.features.map((f) => ({ ...f, size: "medium" as const })));
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
    expect(apiPolicy.maxAgentCalls).toBe(Math.floor((budget.maxAgentCalls - core.calls) / 2));
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
