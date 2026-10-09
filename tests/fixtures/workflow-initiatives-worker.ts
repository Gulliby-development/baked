import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { InitiativeService } from "../../src/core/workflows/initiatives/service.js";
import { initiativeActions } from "../../src/core/workflows/initiatives/view-model.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import { newId } from "../../src/core/workflows/store.js";
import { executionRequest } from "../../src/core/workflows/view.js";
import { stopWorkflowSessions, workflowInitiativesApi, workflowSession } from "../../src/hooks/useWorkflow.js";

const workspace = process.env.BAKED_WORKFLOW_FIXTURE_ROOT!;
const policy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "0"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [] }] };
const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/no-provider", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } };
mkdirSync(join(workspace, ".baked"), { recursive: true });
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify(config));

// Another process (the CLI) starts an initiative with a given split; the TUI reads it through the worker.
const writer = new NativeWorkflowService(workspace, config);
const feature = (id: string, dependsOn: string[] = []) => ({ id, title: `Feature ${id}`, boundary: { scope: id, paths: [`${id}.txt`] }, contract: `${id}.txt exists`, dependsOn, mandatory: true });
await new InitiativeService(writer).start({
  commandId: newId(), initiativeId: "values", prompt: "Add the value files", policy, ownerLabel: "CLI",
  plan: { schemaVersion: 1, title: "Values", goals: ["Values exist"], completionCriteria: ["Each value file exists"], features: [feature("core"), feature("api", ["core"]), feature("docs")] },
});
writer.close();

const api = workflowInitiativesApi(workspace);
try {
  const listed = await api.load();
  assert(listed, "workflows are enabled");
  const [view] = listed.initiatives;
  assert.equal(view?.initiativeId, "values");
  assert.equal(view?.status, "awaiting_approval");
  assert.deepEqual(view?.features.map((f) => f.id), ["core", "api", "docs"]);
  assert.deepEqual(listed.driving, []);

  // A stale revision is refused by the core in the worker.
  const approve = initiativeActions(view, false).find((a) => a.action.kind === "approve");
  assert(approve && approve.action.kind === "approve");
  await assert.rejects(api.act("values", { ...approve.action, expectedRevision: view.revision + 5 }));
  const approved = await api.act("values", approve.action);
  assert.equal(approved.status, "active");
  // Approval drives in the background; pausing stops it, whatever the drive reached.
  const active = (await api.load())?.initiatives[0];
  assert(active);
  const pause = initiativeActions(active, true).find((a) => a.action.kind === "pause");
  assert(pause);
  assert.equal((await api.act("values", pause.action)).status, "paused");

  // The new-run form's execution controls reach the core's own checks through the worker.
  const client = workflowSession(workspace);
  const start = (workflowId: string, worktree: boolean, writers: number) =>
    client.start({ workflowId, featureId: `f-${newId().slice(0, 8)}`, prompt: "x", model: "fixture/no-provider", budget: "standard", ...executionRequest({ worktree, writers }) });
  await assert.rejects(start("review-only", true, 1), /runs inline; a worktree would not contain that diff/);
  await assert.rejects(start("sdd", true, 2), /Worktree execution needs/);
  await assert.rejects(client.start({ workflowId: "sdd", featureId: "inline-writers", prompt: "x", model: "fixture/no-provider", budget: "standard", executionMode: "inline", maxConcurrentWriters: 2 }), /needs worktree execution/);
  console.log(JSON.stringify({ initiativesWorker: "passed" }));
} finally {
  await stopWorkflowSessions();
}
process.exit(0);
