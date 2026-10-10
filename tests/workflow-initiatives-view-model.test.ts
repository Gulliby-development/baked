import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { type FeatureView, InitiativeService, type InitiativeView } from "../src/core/workflows/initiatives/service.js";
import { featureView, initiativeView } from "./helpers/initiative-views.js";
import {
  applyInitiativeAction,
  initiativeActions,
  initiativeBlockers,
  orderInitiatives,
  pendingSplitApproval,
  summarizeInitiative,
} from "../src/core/workflows/initiatives/view-model.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";
import { builtinPresets } from "../src/core/workflows/v2/definitions.js";
import { worktreeRefusal } from "../src/core/workflows/v2/definition.js";
import { clampWriters, executionRequest, initialExecution, type WorkflowInfo } from "../src/core/workflows/view.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("initiative view model", () => {
  test("summarizes progress, budget, decisions and blockers", () => {
    const view = initiativeView({
      features: [
        featureView("core", { state: "accepted", runId: "r1", runStatus: "completed" }),
        featureView("api", { state: "blocked", dependsOn: ["core"], runId: "r2", runStatus: "blocked", blockers: ["checks failed"] }),
        featureView("docs", { state: "needs_decision", runId: "r3", runStatus: "waiting", pendingRequests: [{ scope: "feature", featureId: "docs", runId: "r3", requestId: "q", kind: "approval", digest: "x" }] }),
        featureView("extra", { mandatory: false }),
      ],
      pendingDecisions: [{ scope: "feature", featureId: "docs", runId: "r3", requestId: "q", kind: "approval", digest: "x" }],
      next: { kind: "blocked", featureId: "api", runId: "r2", message: "Feature api: checks failed" },
    });
    expect(summarizeInitiative(view)).toMatchObject({ accepted: 1, total: 3, tokensUsed: 12000, tokensLimit: 400000, pending: 1, blockers: 1, needsYou: true });
    // The next step repeats the feature's blocker, so it is listed once.
    expect(initiativeBlockers(view)).toEqual(["api: checks failed"]);
    expect(initiativeBlockers({ ...view, features: [] })).toEqual(["Feature api: checks failed"]);
    const done = initiativeView({ status: "completed", next: { kind: "done", featureId: null, runId: null, message: "" } });
    expect(summarizeInitiative(done)).toMatchObject({ needsYou: false, blockers: 0 });
  });

  test("orders initiatives that need a person first and finished ones last", () => {
    const done = initiativeView({ initiativeId: "done", status: "completed", next: { kind: "done", featureId: null, runId: null, message: "" } });
    const running = initiativeView({ initiativeId: "running" });
    const paused = initiativeView({ initiativeId: "paused", status: "paused", next: { kind: "paused", featureId: null, runId: null, message: "" } });
    expect(orderInitiatives([done, running, paused]).map((v) => v.initiativeId)).toEqual(["paused", "running", "done"]);
  });

  test("offers only the commands the core accepts in each state", () => {
    const keys = (view: InitiativeView, driving = false, feature: FeatureView | null = null) =>
      initiativeActions(view, driving, feature).map((a) => a.action.kind);
    const awaiting = initiativeView({
      status: "awaiting_approval", approvedPlanRevision: null,
      pendingDecisions: [{ scope: "initiative", featureId: null, runId: null, requestId: "split-1", kind: "split_approval", digest: "e".repeat(64) }],
      next: { kind: "await_split_approval", featureId: null, runId: null, message: "Approve the split" },
    });
    expect(keys(awaiting)).toEqual(["approve"]);
    const approve = initiativeActions(awaiting, false)[0];
    expect(approve?.action).toEqual({ kind: "approve", expectedRevision: 3, requestId: "split-1", digest: "e".repeat(64) });
    expect(approve?.confirm).toContain("Approve plan revision 1");
    expect(pendingSplitApproval(awaiting)?.requestId).toBe("split-1");
    expect(keys(initiativeView())).toEqual(["drive", "pause"]);
    expect(keys(initiativeView(), true)).toEqual(["pause"]);
    const withRun = featureView("core", { runId: "r1", runStatus: "waiting", state: "needs_decision" });
    const replan = initiativeActions(initiativeView(), true, withRun).find((a) => a.action.kind === "replan");
    expect(replan?.confirm).toContain("Re-plan core");
    expect(keys(initiativeView({ status: "paused" }), false, withRun)).toEqual(["resume", "replan"]);
    expect(keys(initiativeView({ status: "completed" }), false, withRun)).toEqual([]);
    expect(keys(initiativeView({ next: { kind: "decide", featureId: "core", runId: "r1", message: "" } }))).toEqual(["pause"]);
  });
});

describe("initiative commands through the view model", () => {
  test("approve, pause and resume reach the service with the revision the person saw", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-initiative-tui-"));
    const executor: AgentExecutor = { execute: async () => { throw new Error("no agent runs in this test"); } };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "0"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const workflows = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } }, executor);
    cleanups.push(() => { workflows.close(); rmSync(root, { recursive: true, force: true }); });
    const initiatives = new InitiativeService(workflows);
    const feature = (id: string, dependsOn: string[] = []) => ({ id, title: `Feature ${id}`, boundary: { scope: id, paths: [`${id}.txt`] }, contract: `${id}.txt exists`, dependsOn, mandatory: true });
    const plan: InitiativePlan = { schemaVersion: 1, title: "Values", goals: ["Values"], completionCriteria: ["Values exist"], features: [feature("core"), feature("api", ["core"]), feature("docs")] };
    await initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Add values", plan, policy, ownerLabel: "test" });
    let view = initiatives.view("values");
    expect(view.features.map((f) => f.id)).toEqual(["core", "api", "docs"]);
    const approve = initiativeActions(view, false).find((a) => a.action.kind === "approve");
    if (!approve) throw new Error("no approve action");
    // A stale revision is refused by the core, not by the view model.
    await expect(applyInitiativeAction(initiatives, "values", { ...approve.action, expectedRevision: view.revision - 1 })).rejects.toThrow();
    const approved = await applyInitiativeAction(initiatives, "values", approve.action);
    expect(approved.drive).toBe(true);
    expect(approved.view.status).toBe("active");
    view = initiatives.view("values");
    const pause = initiativeActions(view, false).find((a) => a.action.kind === "pause");
    if (!pause) throw new Error("no pause action");
    expect((await applyInitiativeAction(initiatives, "values", pause.action)).view.status).toBe("paused");
    view = initiatives.view("values");
    const resume = initiativeActions(view, false).find((a) => a.action.kind === "resume");
    if (!resume) throw new Error("no resume action");
    const resumed = await applyInitiativeAction(initiatives, "values", resume.action);
    expect(resumed).toMatchObject({ drive: true, view: { status: "active" } });
    await expect(applyInitiativeAction(initiatives, "values", { kind: "unknown" })).rejects.toThrow();
  });
});

describe("new-run execution controls", () => {
  const info = (definitions: WorkflowInfo["definitions"], writers = 1): WorkflowInfo => ({
    estimate: { tokens: { low: 1, high: 2 }, basis: "defaults", samples: 0, label: "" }, enabled: true, defaultWorkflow: "sdd",
    workflows: ["sdd"], definitions, policy: { ...defaultWorkflowPolicy, maxConcurrentWriters: writers },
    presets: {} as WorkflowInfo["presets"],
  });
  test("start from the definition's mode, then the policy's", () => {
    expect(initialExecution(null, "sdd")).toEqual({ worktree: false, writers: 1 });
    expect(initialExecution(info({ wt: { stages: [], writes: true, problems: [], execution: "worktree" } }, 3), "wt")).toEqual({ worktree: true, writers: 3 });
    expect(initialExecution(info({ sdd: { stages: [], writes: true, problems: [] } }), "sdd").worktree).toBe(false);
  });
  test("map to the same request as --worktree --writers N", () => {
    expect(executionRequest({ worktree: false, writers: 3 })).toEqual({ executionMode: "inline" });
    expect(executionRequest({ worktree: true, writers: 3 })).toEqual({ executionMode: "worktree", maxConcurrentWriters: 3 });
    expect(executionRequest({ worktree: true, writers: 9 }).maxConcurrentWriters).toBe(4);
    expect([clampWriters(0), clampWriters(2.7), clampWriters(5)]).toEqual([1, 2, 4]);
  });
  test("the review-only preset carries the core's worktree refusal", () => {
    const reviewOnly = builtinPresets.get("review-only");
    if (!reviewOnly) throw new Error("missing preset");
    expect(worktreeRefusal(reviewOnly)).toContain("runs inline");
    const standard = builtinPresets.get("standard");
    if (!standard) throw new Error("missing preset");
    expect(worktreeRefusal(standard)).toBeNull();
  });
});
