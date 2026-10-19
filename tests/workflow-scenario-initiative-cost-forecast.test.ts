import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { costText } from "../src/core/workflows/initiatives/forms.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { startApiServer } from "../src/core/api/server.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService, type InitiativeView } from "../src/core/workflows/initiatives/service.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

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
  constructor(root: string, private cached: boolean) { super(root); }
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      spec: Spec | null; extra: { featureId: string };
    };
    const spec: Spec = data.spec ?? { ...fixtureSpec, featureId: data.extra.featureId };
    const path = `${spec.featureId?.split("_").at(-1) ?? "f1"}.txt`;
    let output: unknown;
    switch (request.profile.output) {
      case "initiativePlan": output = plan; break;
      case "spec": output = spec; break;
      case "plan": {
        const markdown = `# Plan\n## Context\nCreate ${path}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${path}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        output = { schemaVersion: 1, markdown, taskGraph: {
          schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: `Create ${path}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: existsSync(join(request.root, path)) ? "modify" : "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        } };
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
    const inputTokens = decompose ? 0 : this.cached ? 120_000 : 18_000;
    const outputTokens = decompose ? 36_000 : this.cached ? 1_000 : 18_000;
    const cacheReadTokens = !decompose && this.cached ? 100_000 : 0;
    const totalTokens = inputTokens + outputTokens;
    this.store?.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
      schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null,
      maxSteps: 10, maxTokens: 1_000_000, stopReason: "submitted", finalizedBy: null, totalTokens,
      steps: [{ step: 1, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
    }));
    return { output, inputTokens, outputTokens };
  }
}

async function scenario(cached = false, decompose = false) {
  const fixture = workflowFixture({ executor: (root) => new ScriptedExecutor(root, cached) });
  cleanups.push(fixture.dispose);
  fixture.executor.store = fixture.service.store;
  const initiatives = new InitiativeService(fixture.service);
  const signal = new AbortController().signal;
  const policy = { ...fixturePolicy, clarification: "assume" as const,
    checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }],
    sizing: { maxRunTokens: 50_000_000 },
  };
  let view = await initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Create twelve values", ownerLabel: "test", model: MODEL,
    ...(!decompose ? { plan } : {}), policy, keepFeatures: true, featureAutoApproval: { maxTasks: 5, maxFiles: 5 },
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
    try { return await initiatives.drive("values", controller.signal); }
    finally { unwatch(); }
  };
  await driveOne();
  view = await driveOne();
  return { fixture, initiatives, view, driveOne, identity, signal };
}

describe("scenario: initiative forecast follows accepted features' measured spend (#1607)", () => {
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
