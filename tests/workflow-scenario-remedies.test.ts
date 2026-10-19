import { afterEach, describe, expect, test } from "bun:test";
import { featureRow } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { initiativeBlockers } from "../src/core/workflows/initiatives/view-model.js";
import { newId } from "../src/core/workflows/store.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class ScriptedExecutor extends FixtureExecutor {
  constructor(root: string, private failure: "invalid_output" | "provider_account") { super(root); }
  override async execute(request: ExecutionRequest) {
    if (this.failure === "provider_account") throw Object.assign(new Error("You have no credits remaining. Add credits to continue."), { statusCode: 429 });
    if (request.profile.output) throw new WorkflowFault("OUTPUT_INVALID", "Scripted invalid output");
    return super.execute(request);
  }
}

function fixture(failure: "invalid_output" | "provider_account" = "invalid_output") {
  const f = workflowFixture({ executor: (root) => new ScriptedExecutor(root, failure) });
  const initiatives = new InitiativeService(f.service);
  cleanups.push(f.dispose);
  return { ...f, initiatives };
}

const plan = {
  schemaVersion: 1 as const, title: "Values", goals: ["Values exist"], completionCriteria: ["Values are ready"],
  features: ["core", "api", "docs"].map((id) => ({ id, title: `Feature ${id}`, boundary: { scope: id, paths: [`${id}.txt`] }, contract: `${id}.txt exists`, dependsOn: [], mandatory: true })),
};

describe("scenario: initiative recovery advice stays in the app (#1578)", () => {
  test.each(["invalid_output", "provider_account"] as const)("a feature blocked by %s names its run action", async (failure) => {
    const f = fixture(failure);
    let view = await f.initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Create values", plan, keepFeatures: true, policy: fixturePolicy, budget: { maxTotalTokens: 2_000_000, maxAgentCalls: 400, maxActiveMs: 3_600_000 }, ownerLabel: "test" });
    const approval = view.pendingDecisions.find((d) => d.scope === "initiative");
    if (!approval) throw new Error("No split approval");
    await f.initiatives.approve("values", { commandId: newId(), expectedRevision: view.revision }, { requestId: approval.requestId, digest: approval.digest });
    view = await f.initiatives.drive("values", new AbortController().signal);
    const feature = view.features.find((x) => x.state === "blocked");
    expect(feature).toBeDefined();
    if (!feature?.runId) throw new Error("No blocked feature run");
    expect(feature.runReason).toBe(failure);
    expect(feature.blockers.join(" ")).toContain("baked workflow resume");
    const tui = initiativeBlockers(view, tuiRecoveryText).join(" ");
    const desktop = featureRow(feature).label;
    for (const text of [tui, desktop, desktopRecoveryText(view.next.message, view.next.recovery)]) {
      expect(text).not.toContain("baked workflow");
      expect(text).toContain(feature.runId);
    }
    expect(tui).toContain(failure === "provider_account" ? "press M" : "press R");
    expect(desktop).toContain(failure === "provider_account" ? "Switch model" : "Retry");
    if (failure === "provider_account") {
      const advice = stopRecovery(f.service.store, feature.runId);
      expect(advice?.remedies).toEqual([{ action: "reroute", runId: feature.runId }]);
      const details = readWorkflowView(f.service, feature.runId).details;
      expect(tuiRecoveryText(details?.lastError ?? "", details?.recovery)).toContain("press M");
      const status = await executeWorkflowCommand(f.service, parseWorkflowArgs(["status", feature.runId])) as { stopDetail: string; recovery: unknown };
      expect(status.stopDetail).toContain("baked workflow reroute");
      expect(status.recovery).toEqual(advice);
      f.service.store.artifact(feature.runId, "diagnostic", "errors/later-stop.txt", "A different error stopped the run");
      expect(stopRecovery(f.service.store, feature.runId)).toBeUndefined();
      expect(readWorkflowView(f.service, feature.runId).details?.recovery).toBeUndefined();
    }
  });

  test.each(["invalid_output", "provider_account"] as const)("a decompose run blocked by %s names its run action", async (failure) => {
    const f = fixture(failure);
    await f.initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Create values", policy: fixturePolicy, ownerLabel: "test" });
    const view = await f.initiatives.drive("values", new AbortController().signal);
    expect(view.next.kind).toBe("blocked");
    expect(view.next.recovery?.remedies).toEqual([{ action: failure === "provider_account" ? "reroute" : "resume", runId: view.decompose?.runId }]);
    expect(tuiRecoveryText(view.next.message, view.next.recovery)).toContain(failure === "provider_account" ? "press M" : "press R");
    expect(desktopRecoveryText(view.next.message, view.next.recovery)).not.toContain("baked workflow");
  });
});
