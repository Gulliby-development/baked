import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import type { Check } from "../../src/core/workflows/types.js";
import { stopWorkflowSessions, workflowGatesApi, workflowSession } from "../../src/hooks/useWorkflow.js";

const workspace = process.env.BAKED_WORKFLOW_FIXTURE_ROOT!;
const gate = (id: string, code: string, patch: Partial<Check> = {}): Check => ({
  id, executable: "bun", args: ["-e", code], cwd: ".", timeoutMs: 20000, required: true, scope: "feature", envNames: [], writes: [], ...patch,
});
const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/no-provider", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: { ...defaultWorkflowPolicy, checks: [gate("old", "0")] } } };
mkdirSync(join(workspace, ".baked"), { recursive: true });
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify({ ...config, theme: { name: "kept" } }));
const client = workflowSession(workspace);
try {
  // The command runs in the worker while the UI thread keeps ticking.
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks++; }, 10);
  const started = performance.now();
  const passed = await client.runGate(gate("slow", "await Bun.sleep(400); console.log('worker says hi')"), new AbortController().signal);
  clearInterval(heartbeat);
  assert.equal(passed.status, "passed");
  assert.equal(passed.outputTail, "worker says hi");
  assert(passed.durationMs >= 350 && performance.now() - started >= 350);
  assert(ticks >= 15, `main thread stalled while the gate ran: ${ticks} ticks`);

  const failed = await client.runGate(gate("fails", "console.error('boom'); process.exit(7)"), new AbortController().signal);
  assert.deepEqual([failed.status, failed.exitCode, failed.outputTail], ["failed", 7, "boom"]);

  // Aborting from the UI stops the process tree in the worker.
  const controller = new AbortController();
  const hung = client.runGate(gate("hung", "setInterval(() => {}, 1000)"), controller.signal);
  setTimeout(() => controller.abort(), 300);
  assert.equal((await hung).status, "cancelled");

  // The api writes the project config without losing settings and updates the live worker.
  const api = workflowGatesApi(workspace);
  assert.deepEqual(api.load().map((c) => c.id), ["old"]);
  await api.save([gate("added", "0"), gate("another", "0", { required: false })]);
  const saved = JSON.parse(readFileSync(join(workspace, ".baked", "config.json"), "utf8"));
  assert.deepEqual(saved.workflows.policy.checks.map((c: Check) => c.id), ["added", "another"]);
  assert.equal(saved.theme.name, "kept");
  assert.equal(saved.defaultModel, "fixture/no-provider");
  assert.deepEqual((await client.info()).policy.checks.map((c) => c.id), ["added", "another"]);

  // A started run keeps the gates it began with; a run started now uses the new list.
  const writer = new NativeWorkflowService(workspace, { ...config, workflows: { ...config.workflows, policy: { ...config.workflows.policy, checks: [gate("old", "0")] } } });
  const frozen = await writer.start({ commandId: "frozen", workflowId: "sdd", featureId: "frozen", prompt: "x", policy: config.workflows.policy, ownerLabel: "test" });
  await api.save([gate("newest", "0")]);
  assert.deepEqual(JSON.parse(writer.store.run(frozen.runId).policy_json).checks.map((c: Check) => c.id), ["old"]);
  const fresh = await client.start({ workflowId: "sdd", featureId: "fresh", prompt: "x", model: "fixture/no-provider", budget: "standard" });
  const freshPolicy = JSON.parse(writer.store.run(fresh.runId).policy_json);
  assert.deepEqual(freshPolicy.checks.map((c: Check) => c.id), ["newest"]);
  assert.deepEqual(JSON.parse(writer.store.run(frozen.runId).policy_json).checks.map((c: Check) => c.id), ["old"]);
  await client.action(fresh.runId, "pause");

  // A live run that holds the workspace blocks a gate run, which could change its evidence.
  const owner = Reflect.get(client, "owner") as string;
  writer.store.putLease({ resource: "execution", owner_id: owner, owner_epoch: 1, run_id: frozen.runId, expires_at: Date.now() + 15000, process_identity_json: JSON.stringify({ pid: process.pid }) });
  await assert.rejects(client.runGate(gate("blocked", "0"), new AbortController().signal), /holds the workspace/);
  writer.store.releaseLease("execution", owner, 1);
  assert.equal((await client.runGate(gate("free", "0"), new AbortController().signal)).status, "passed");
  writer.close();
  console.log(JSON.stringify({ gatesWorker: "passed", ticks }));
} finally { await stopWorkflowSessions(); }
process.exit(0);
