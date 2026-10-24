import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { estimateFit } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { startApiServer } from "../src/core/api/server.js";
import { estimateSummary } from "../src/core/workflows/initiatives/estimate.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { growthLimit, InitiativeService, type InitiativeView, rebaseView } from "../src/core/workflows/initiatives/service.js";
import { initiativeActions } from "../src/core/workflows/initiatives/view-model.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1605: high-end weights put an early feature below its low estimate even though the pool
// covers every low estimate. The same split is used at start, resume, replan and rebase.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Pictures", goals: ["Create the value files"],
  completionCriteria: ["All value files exist"],
  features: ["core", "pictures", "docs"].map((id, index) => ({
    id, title: id, size: index === 2 ? "large" : "small", workflow: "sdd",
    boundary: { scope: `The ${id} value`, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: index ? [index === 1 ? "core" : "pictures"] : [], mandatory: true,
  })),
};

class ScriptedExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      inputHash: string; snapshotHash: string; spec: Spec | null; extra: { featureId: string; evidence?: { id: string }[] };
    };
    const spec: Spec = data.spec ?? { ...fixtureSpec, featureId: data.extra.featureId };
    const name = spec.featureId?.split("_").at(-1) ?? "core";
    const path = `${name}.txt`;
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
      default: return super.execute(request);
    }
    this.calls.push(request.profile.output);
    return { output, inputTokens: 50, outputTokens: 50 };
  }
}

async function scenario() {
  // Two real completed runs price overhead consistently but task work with a broad range.
  const histories = [];
  const signal = new AbortController().signal;
  for (const taskTokens of [10_000, 100_000]) {
    const history = workflowFixture({ tokensPerCall: (output) => output === "implementation" ? taskTokens : 20_000 });
    cleanups.push(history.dispose);
    const run = await history.start();
    await history.service.drive(run.runId, signal);
    await history.approve(run.runId);
    expect((await history.service.drive(run.runId, signal)).status).toBe("completed");
    histories.push(history.root);
  }
  const fixture = workflowFixture({ executor: (root) => new ScriptedExecutor(root) });
  cleanups.push(fixture.dispose);
  const initiatives = new InitiativeService(fixture.service);
  const policy = { ...fixturePolicy, clarification: "assume" as const, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }], sizing: { maxRunTokens: 50_000_000, historyStores: histories } };
  let view = await initiatives.start({ commandId: newId(), initiativeId: "pictures", prompt: "Create three values", ownerLabel: "test", policy, keepFeatures: true, featureAutoApproval: { maxTasks: 5, maxFiles: 5 }, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 400, maxActiveMs: 21_600_000 } });
  view = await initiatives.drive("pictures", signal);
  expect(view.status).toBe("awaiting_approval");
  const estimate = initiatives.estimate("pictures")!;
  const lows = estimate.tokens.low;
  expect(estimate.tokens.high).toBeGreaterThan(lows);
  // Budget changes are increases only, so start a second initiative with exactly the low total.
  view = await initiatives.start({ commandId: newId(), initiativeId: "tight", prompt: "Create three values", ownerLabel: "test", plan, policy, keepFeatures: true, featureAutoApproval: { maxTasks: 5, maxFiles: 5 }, budget: { maxTotalTokens: lows, maxAgentCalls: 400, maxActiveMs: 21_600_000 } });
  const tightId = () => ({ commandId: newId(), expectedRevision: initiatives.view("tight").revision });
  const driveOne = async () => {
    const controller = new AbortController();
    const unwatch = fixture.service.store.observe((event) => {
      if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
    });
    try {
      return await initiatives.drive("tight", controller.signal);
    } finally {
      unwatch();
    }
  };
  return { fixture, initiatives, signal, view, tightId, driveOne };
}

describe("scenario: initiative lows fit but high-end weighted shares do not (#1605)", () => {
  test("the split offers extension before approval in CLI, TUI, desktop and the API view", async () => {
    const { fixture, initiatives, signal, view } = await scenario();
    expect(view.next.kind).toBe("await_split_approval");
    expect(view.next.message).toContain("high end");
    expect(view.next.message).toContain("baked workflow initiative extend tight --tokens");
    // #2042: the remedy carries the amount the command names, so B and the desktop apply it.
    const suggestedTokens = view.next.recovery?.remedies.find((r) => r.action === "extend")?.suggestedTokens;
    expect(view.next.recovery?.remedies).toContainEqual({ action: "extend", initiativeId: "tight", suggestedTokens });
    expect(view.next.message).toContain(`baked workflow initiative extend tight --tokens ${suggestedTokens} --expected-revision`);
    expect(tuiRecoveryText(view.next.message, view.next.recovery)).toContain("Press B to extend budget");
    expect(desktopRecoveryText(view.next.message, view.next.recovery)).toContain(`Choose Extend to ${(suggestedTokens! / 1e6).toFixed(1)}M tokens`);
    expect(initiativeActions(view, false).some((a) => a.action.kind === "extend")).toBe(true);
    const cli = await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "tight"]), signal);
    expect(cli).toEqual(view);
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => { await server.stop(); });
    const response = await fetch(`${server.url}/v1/initiatives/tight`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    expect((await response.json() as InitiativeView).next).toEqual(view.next);
    const estimate = initiatives.estimate("tight")!;
    expect(estimate.label).toContain("high end exceeds the shared budget");
    expect(estimateSummary(estimate)).toContain("high end exceeds the shared budget");
    expect(estimateFit(estimate).text).toContain("high end exceeds the shared budget");
  });

  test("starts with reserved lows, then continues after acceptance, resume and replan", async () => {
    const { fixture, initiatives, view: proposed, tightId, driveOne } = await scenario();
    const request = proposed.pendingDecisions.find((d) => d.scope === "initiative")!;
    let view = await initiatives.approve("tight", tightId(), { requestId: request.requestId, digest: request.digest });
    expect(view.next.kind).toBe("start");
    for (const feature of view.features) expect(feature.share?.tokens).toBeGreaterThanOrEqual(feature.need?.low ?? 0);
    expect(view.features.reduce((sum, f) => sum + (f.share?.tokens ?? 0), 0)).toBeLessThanOrEqual(view.budget.remaining.tokens);
    view = await driveOne();
    expect(view.features.find((f) => f.id === "core")?.state).toBe("accepted");
    expect(view.next.kind).toBe("start");
    expect(view.next.featureId).toBe("pictures");
    const pictures = view.features.find((f) => f.id === "pictures")!;
    expect(pictures.share?.tokens).toBeGreaterThanOrEqual(pictures.need?.low ?? 0);
    await initiatives.pause("tight", tightId());
    view = await initiatives.resume("tight", tightId());
    expect(view.next.kind).toBe("start");
    view = await driveOne();
    expect(view.features.find((f) => f.id === "pictures")?.state).toBe("accepted");
    const runId = view.features.find((f) => f.id === "pictures")!.runId!;
    expect(JSON.parse(fixture.service.store.run(runId).policy_json).maxTotalTokens).toBeGreaterThanOrEqual(pictures.need?.low ?? 0);
    view = await initiatives.replan("tight", tightId(), "pictures");
    expect(view.next.kind).toBe("start");
    expect(view.features.find((f) => f.id === "pictures")?.share?.tokens).toBeGreaterThanOrEqual(view.features.find((f) => f.id === "pictures")?.need?.low ?? 0);
  });

  test("rebase reserves another waiting feature's low end without overallocating", () => {
    const before = { budget: { remaining: { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 }, cost: { remainingUsd: null } }, features: [
      { id: "pictures", size: "small", share: null, need: null },
      { id: "docs", size: "large", share: { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 }, need: { low: 200_000, high: 1_000_000 } },
    ] } as unknown as InitiativeView;
    const view = rebaseView(before, "pictures", { low: 700_000, high: 800_000 });
    expect(view.features.find((f) => f.id === "pictures")?.share?.tokens).toBe(700_000);
    expect(view.features.find((f) => f.id === "docs")?.share?.tokens).toBe(300_000);
    expect(growthLimit(view, "pictures")).toBe(800_000);
  });
});
