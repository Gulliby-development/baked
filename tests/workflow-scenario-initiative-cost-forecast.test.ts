import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { costText } from "../src/core/workflows/initiatives/forms.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { startApiServer } from "../src/core/api/server.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService, type InitiativeView, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { attemptSpend } from "../src/core/workflows/usage.js";
import { upgradeWorkflowV1 } from "../src/core/workflows/v2/upgrade.js";
import { listDefinitions } from "../src/core/workflows/v2/definitions.js";
import { findPricing } from "../src/core/llm/pricing.js";

// #1607, recmill R48: about $4.51 spent on two of twelve features at a steady rate should
// project about $27, within a $30 cap and its $37.50 ceiling. A 25% minimum calibration ratio
// inflated the token estimate when accepted features used less than a quarter of their prior.
const MODEL = "anthropic/claude-sonnet-4-6";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Twelve values", goals: ["Create the value files"],
  completionCriteria: ["All twelve value files exist"],
  features: Array.from({ length: 12 }, (_, i) => ({
    id: `f${i + 1}`, title: `Value ${i + 1}`, size: "medium", workflow: "sdd",
    boundary: { scope: `Value ${i + 1}`, paths: [`f${i + 1}.txt`] },
    contract: `f${i + 1}.txt contains ready`, dependsOn: i ? [`f${i}`] : [], mandatory: true,
  })),
};

class ScriptedExecutor extends FixtureExecutor {
  store: WorkflowStore | null = null;
  constructor(root: string, private cached: boolean, private staged = false, private split = plan, private scale = 1) { super(root); }
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      spec: Spec | null; extra: { featureId: string; hostFiles?: { files: { path: string; content: string }[] } };
    };
    const spec: Spec = data.spec ?? { ...fixtureSpec, featureId: data.extra.featureId };
    const path = `${spec.featureId?.split("_").at(-1) ?? "f1"}.txt`;
    let output: unknown;
    switch (request.profile.output) {
      case "initiativePlan": output = this.split; break;
      case "spec": output = spec; break;
      case "plan": {
        const markdown = `# Plan\n## Context\nCreate ${path}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${path}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        output = { schemaVersion: 1, markdown, taskGraph: {
          schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: `Create ${path}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: existsSync(join(request.root, path)) ? "modify" : "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        } };
        if (data.extra.hostFiles) {
          const graph = (output as { taskGraph: { tasks: { id: string; dependsOn: string[]; writes: unknown[] }[] } }).taskGraph;
          const own = graph.tasks[0]!;
          graph.tasks = [
            { ...own, id: "T001", title: "Write the host skeleton", writes: data.extra.hostFiles.files.map((f) => ({ ...f, action: "create" })) },
            { ...own, id: "T002", dependsOn: ["T001"] },
          ];
        }
        break;
      }
      case "implementation":
        for (const write of request.task?.writes ?? []) writeFileSync(join(request.root, write.path), "ready");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      default: output = (await super.execute(request)).output;
    }
    // Real usage artifacts price the provider's input, output and cache reads. The decomposer
    // pays the output price once; cached feature calls cost less per token than that split.
    const decompose = request.profile.output === "initiativePlan";
    const dear = this.staged && request.profile.output === "research";
    const inputTokens = (decompose || dear ? 0 : this.staged ? 36_000 : this.cached ? 120_000 : 18_000) * this.scale;
    const outputTokens = (decompose || dear ? 36_000 : this.staged ? 0 : this.cached ? 1_000 : 18_000) * this.scale;
    const cacheReadTokens = this.staged && !dear ? 32_000 : !decompose && this.cached ? 100_000 : 0;
    const totalTokens = inputTokens + outputTokens;
    this.store?.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
      schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null,
      maxSteps: 10, maxTokens: 1_000_000, stopReason: "submitted", finalizedBy: null, totalTokens,
      steps: [{ step: 1, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
    }));
    return { output, inputTokens, outputTokens };
  }
}

async function scenario(cached = false, decompose = false, staged = false, lean = staged, skeleton = false) {
  const hostFiles = Array.from({ length: 24 }, (_, i) => ({ path: `stub${i}.txt`, content: "// filled by later features\n" }));
  const base: InitiativePlan = skeleton ? { ...plan, features: plan.features.map((f, i) => ({
    ...f, size: i ? "large" : "small",
    ...(!i ? { skeleton: hostFiles, boundary: { ...f.boundary, paths: [...f.boundary.paths, ...hostFiles.map((file) => file.path)] } } : {}),
  })) } : plan;
  const fixture = workflowFixture({ executor: (root) => new ScriptedExecutor(root, cached, staged, base, skeleton ? 0.65 : 1) });
  cleanups.push(fixture.dispose);
  fixture.executor.store = fixture.service.store;
  if (staged) {
    mkdirSync(join(fixture.root, "baked", "workflows"), { recursive: true });
    const workflow = upgradeWorkflowV1(sddWorkflow, fixturePolicy);
    writeFileSync(join(fixture.root, "baked", "workflows", "lean.json"), JSON.stringify({
      ...workflow, id: "lean", entry: "specify",
      stages: workflow.stages.filter((s) => s.id !== "research")
        .map((s) => ({ ...s, consumes: s.consumes.filter((c) => c !== "research") })),
      transitions: workflow.transitions.filter((t) => t.from !== "research"),
    }));
  }
  const split = lean ? { ...base, features: base.features.map((f, i) => ({
    ...f, workflow: i < 2 ? "sdd" : "lean",
  })) } : base;
  const initiatives = new InitiativeService(fixture.service);
  const signal = new AbortController().signal;
  const policy = { ...fixturePolicy, clarification: "assume" as const,
    checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }],
    sizing: { maxRunTokens: 50_000_000 },
  };
  if (staged) expect(listDefinitions(fixture.root, policy).find((d) => d.id === "lean")?.problems).toEqual([]);
  let view = await initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Create twelve values", ownerLabel: "test", model: MODEL,
    ...(!decompose ? { plan: split } : {}), policy, keepFeatures: true,
    ...(!staged && !skeleton ? { featureAutoApproval: { maxTasks: 5, maxFiles: 5 } } : {}),
    budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 },
    costBudget: { maxCostUsd: cached ? 10 : 30, costTolerance: "auto" },
  });
  if (decompose) view = await initiatives.drive("values", signal);
  const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
  const identity = () => ({ commandId: newId(), expectedRevision: initiatives.view("values").revision });
  view = await initiatives.approve("values", identity(), { requestId: request.requestId, digest: request.digest });
  const driveOne = async () => {
    const controller = new AbortController();
    const unwatch = fixture.service.store.observe((event) => {
      if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
    });
    try {
      let result = await initiatives.drive("values", controller.signal);
      while ((staged || skeleton) && !controller.signal.aborted) {
        const feature = result.features.find((f) => f.state === "needs_decision");
        if (!feature?.runId) break;
        await fixture.approve(feature.runId);
        result = await initiatives.drive("values", controller.signal);
      }
      return result;
    }
    finally { unwatch(); }
  };
  await driveOne();
  view = skeleton ? initiatives.view("values") : await driveOne();
  return { fixture, initiatives, view, driveOne, identity, signal };
}

describe("scenario: initiative forecast follows accepted features' measured spend (#1607)", () => {
  test("R50: one accepted skeleton keeps planned remaining costs and the next feature starts (#1631)", async () => {
    const { fixture, initiatives, view, driveOne, identity } = await scenario(false, false, false, false, true);
    expect(view.features.filter((f) => f.state === "accepted")).toHaveLength(1);
    expect(view.features[0]!.skeleton).toHaveLength(24);
    for (const file of view.features[0]!.skeleton!) expect(readFileSync(join(fixture.root, file.path), "utf8")).toBe(file.content);
    expect(view.budget.cost.ceilingUsd).toBe(37.5);
    expect(view.budget.cost.forecastUsd).toBeLessThan(37.5);
    expect(view.next).toMatchObject({ kind: "start", featureId: "f2" });
    const estimate = initiatives.estimate("values")!;
    expect(estimate.progress.ratio).toBeNull();
    expect(estimate.progress.bySize).toEqual({});
    expect(estimate.features.slice(1).every((f) => f.basis !== "calibrated")).toBe(true);
    const plannedUsd = estimate.features.slice(1).reduce((sum, f) => sum + (f.costUsd!.low + f.costUsd!.high) / 2, 0);
    expect(view.budget.cost.forecastUsd).toBeCloseTo(view.budget.cost.spentUsd + plannedUsd, 2);
    expect(view.features[1]!.needUsd).toEqual(estimate.features[1]!.costUsd);
    await initiatives.pause("values", identity());
    expect((await initiatives.resume("values", identity())).next.kind).toBe("start");
    expect((await driveOne()).features[1]!.state).toBe("accepted");
  }, 60000);

  test("R48: switching the remaining model reprices its stages without repricing spent dollars", async () => {
    const { fixture, initiatives, view, identity } = await scenario();
    const cheap = "anthropic/claude-haiku-4-5";
    await initiatives.pause("values", identity());
    const switched = await initiatives.reroute("values", identity(), { model: cheap });
    expect(switched.budget.cost.spentUsd).toBe(view.budget.cost.spentUsd);
    // Haiku's input, cache and output prices are each one third of this Sonnet model's.
    const store = fixture.service.store;
    const runs = view.features.filter((f) => f.state === "accepted").map((f) => f.runId!);
    const spent = runs.reduce((sum, id) => sum + store.costUsage(id).spentUsd, 0);
    expect(switched.budget.cost.forecastUsd).toBeCloseTo(spent + spent * 5 / 3, 2);
    expect(switched.budget.cost.forecastUsd).toBeLessThan(view.budget.cost.forecastUsd!);
  }, 60000);

  test("R48: an active feature removes its completed dear planning stage", async () => {
    const { fixture, initiatives, view } = await scenario(false, false, true, false);
    const store = fixture.service.store;
    const finished = new Set(view.features.filter((f) => f.state === "accepted").map((f) => f.runId));
    const controller = new AbortController();
    const unwatch = store.observe((event) => {
      if (event.type !== "stage.finished" || finished.has(event.runId)) return;
      const step = store.steps(event.runId).find((s) => s.id === event.payload.stepId);
      if (step?.stage_id === "plan" && event.payload.status === "completed") controller.abort();
    });
    try { await initiatives.drive("values", controller.signal); }
    finally { unwatch(); }
    const active = initiatives.view("values");
    expect(active.features[2]?.runId).toBeTruthy();
    expect(store.steps(active.features[2]!.runId!).some((s) => s.stage_id === "research" && s.status === "completed")).toBe(true);
    const estimate = initiatives.estimate("values", 0);
    const measuredUsd = [...finished].reduce((sum, id) => sum + store.costUsage(id!).spentUsd, 0);
    const measuredTokens = estimate.features.filter((f) => f.basis === "measured")
      .reduce((sum, f) => sum + f.spent, 0);
    const full = measuredUsd / measuredTokens;
    const price = findPricing(MODEL)!.pricing;
    const cheap = (price.input * 4_000 + price.cacheRead * 32_000) / 36_000 / 1e6;
    const left = estimate.features.filter((f) => f.basis !== "measured");
    const spent = active.features.reduce((sum, f) => sum + (f.runId ? store.costUsage(f.runId).spentUsd : 0), 0);
    const expected = spent + left.reduce((sum, f) => sum +
      (f.expectedTokens - f.spent) * (f.featureId === "f3" ? cheap : full), 0);
    expect(active.budget.cost.forecastUsd).toBeCloseTo(expected, 2);
  }, 60000);

  test("R48: remaining workflows omit the dear stage, so the forecast fits and starts after resume", async () => {
    const { fixture, initiatives, view, driveOne, identity } = await scenario(false, false, true);
    const store = fixture.service.store;
    const accepted = view.features.filter((f) => f.state === "accepted");
    expect(accepted).toHaveLength(2);
    let leanUsd = 0;
    let leanTokens = 0;
    let tokens = 0;
    for (const feature of accepted) {
      const steps = new Map(store.steps(feature.runId!).map((s) => [s.id, s]));
      for (const a of store.attempts(feature.runId!)) {
        tokens += a.used_tokens ?? 0;
        if (steps.get(a.step_id)?.stage_id === "research") continue;
        leanTokens += a.used_tokens ?? 0;
        leanUsd += attemptSpend(store, feature.runId!, a.id, a.model_id)?.costUsd ?? 0;
      }
    }
    const estimate = initiatives.estimate("values", 0);
    const remaining = estimate.features.filter((f) => f.basis !== "measured")
      .reduce((sum, f) => sum + f.expectedTokens - f.spent, 0);
    const spent = accepted.reduce((sum, f) => sum + store.costUsage(f.runId!).spentUsd, 0);
    expect(view.budget.cost.forecastUsd).toBeCloseTo(spent + remaining * leanUsd / leanTokens, 2);
    const blended = spent + remaining * spent / tokens;
    expect(view.budget.cost.forecastUsd).toBeLessThan(blended / 2);
    // Put the ceiling between the two projections and exercise the actual feature-start gate.
    const ceiling = (blended + view.budget.cost.forecastUsd!) / 2;
    const gate = { ...view, budget: { ...view.budget, cost: {
      ...view.budget.cost, capUsd: ceiling / 1.25, ceilingUsd: ceiling,
    } } };
    expect(shareShortfall(gate, view.features[2]!)).toBeNull();
    expect(shareShortfall({ ...gate, budget: { ...gate.budget, cost: {
      ...gate.budget.cost, forecastUsd: blended,
    } } }, view.features[2]!)).not.toBeNull();
    expect(view.next).toMatchObject({ kind: "start", featureId: "f3" });
    await initiatives.pause("values", identity());
    expect((await initiatives.resume("values", identity())).next.kind).toBe("start");
    expect((await driveOne()).features.find((f) => f.id === "f3")?.state).toBe("accepted");
  }, 60000);

  test("two accepted features project about $27 and the third starts, including after resume", async () => {
    const { fixture, initiatives, view, driveOne, identity, signal } = await scenario();
    expect(view.budget.cost.ceilingUsd).toBe(37.5);
    expect(view.budget.cost.forecastUsd).toBeLessThan(30);
    expect(view.features.filter((f) => f.state === "accepted")).toHaveLength(2);
    expect(view.budget.cost.spentUsd).toBeCloseTo(4.54, 2);
    expect(view.budget.cost.forecastUsd).toBeCloseTo(27.22, 2);
    expect(view.next).toMatchObject({ kind: "start", featureId: "f3" });
    // The same view drives CLI, TUI and desktop rendering through the local API.
    expect(costText(view.budget.cost)).toContain("forecast $27.22");
    expect(costLine(view)).toBe(costText(view.budget.cost));
    expect(await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "values"]), signal)).toEqual(view);
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => { await server.stop(); });
    const response = await fetch(`${server.url}/v1/initiatives/values`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    const api = await response.json() as InitiativeView;
    expect(api.budget.cost).toEqual(view.budget.cost);
    expect(api.next).toEqual(view.next);
    await initiatives.pause("values", identity());
    expect((await initiatives.resume("values", identity())).next.kind).toBe("start");
    const next = await driveOne();
    expect(next.features.find((f) => f.id === "f3")?.state).toBe("accepted");
  }, 60000);

  test("cached feature prices exclude the one-time decompose price and count its spend once", async () => {
    const { fixture, view } = await scenario(true, true);
    expect(view.features.filter((f) => f.state === "accepted")).toHaveLength(2);
    const store = fixture.service.store;
    const runs = view.features.filter((f) => f.state === "accepted").map((f) => f.runId!);
    const spent = runs.reduce((sum, id) => sum + store.costUsage(id).spentUsd, 0);
    const decompose = store.costUsage(view.decompose!.runId).spentUsd;
    // Equal features have equal projected spend, regardless of provider cache discounts.
    expect(view.budget.cost.forecastUsd).toBeCloseTo(decompose + spent * 6, 2);
    expect(view.next).toMatchObject({ kind: "start", featureId: "f3" });
  }, 60000);
});
