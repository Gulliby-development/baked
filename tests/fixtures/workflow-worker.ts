import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import { workflowSession, stopWorkflowSessions } from "../../src/hooks/useWorkflow.js";
import type { RunSnapshot } from "../../src/core/workflows/schemas.js";

const workspace = process.env.BAKED_WORKFLOW_FIXTURE_ROOT!;
const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/no-provider", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy } };
mkdirSync(join(workspace, ".baked"), { recursive: true });
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify(config));
const service = new NativeWorkflowService(workspace, config);
const run = await service.start({ commandId: "worker-fixture", workflowId: "sdd", featureId: "worker", prompt: "No model is called", policy: defaultWorkflowPolicy, ownerLabel: "test" });
const path = service.store.path;
service.close();
const previousCwd = process.cwd();
let client = workflowSession(workspace);
try {
  assert.equal((await client.refresh(run.runId)).snapshot.revision, run.revision);
  assert.equal(process.cwd(), previousCwd, "worker must not change the UI process cwd");
  const status = await client.command(["status", run.runId, "--json"], new AbortController().signal) as RunSnapshot;
  assert.equal(status.eventSeq, run.eventSeq);
  const blocker = new Database(path);
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks++; }, 10);
  blocker.exec("BEGIN IMMEDIATE");
  const release = setTimeout(() => blocker.exec("ROLLBACK"), 250);
  try {
    await client.action(run.runId, "pause");
    assert(ticks >= 10, `main thread stalled during SQLite contention: ${ticks} ticks`);
  } finally { clearTimeout(release); clearInterval(heartbeat); blocker.close(); }
  const view = await client.refresh(run.runId);
  assert.equal(view.snapshot.status, "paused");
  assert(view.snapshot.eventSeq > run.eventSeq);
  const writer = new NativeWorkflowService(workspace, config);
  const owner = Reflect.get(client, "owner") as string;
  assert(owner);
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    const step = writer.store.beginStep(run.runId, "crashed-check");
    const attempt = writer.store.reserve(run.runId, step, null, 0, defaultWorkflowPolicy);
    const effectId = writer.store.prepareEffect(run.runId, attempt, "command", { checkId: "crash", pid: child.pid }, null, null);
    for (const resource of ["execution", "mutation"] as const)
      writer.store.putLease({ resource, owner_id: owner, owner_epoch: 1, run_id: run.runId, expires_at: Date.now() + 15000, process_identity_json: JSON.stringify({ pid: process.pid }) });
    const worker = Reflect.get(client, "worker") as Worker;
    const closed = new Promise<void>((resolve) => worker.addEventListener("close", () => resolve(), { once: true }));
    worker.terminate();
    await closed;
    const reopened = workflowSession(workspace);
    assert.notEqual(reopened, client);
    client = reopened;
    await client.refresh(run.runId);
    await client.action(run.runId, "resume");
    const recovered = await client.refresh(run.runId);
    assert.equal(recovered.snapshot.status, "waiting");
    const request = recovered.requests.find((entry) => entry.kind === "recovery" && entry.status === "pending")!;
    const decision = { kind: "recovery" as const, requestId: request.id, effectId, resolution: "cancel" as const, evidence: "Fixture child and descendants confirmed stopped" };
    await assert.rejects(client.action(run.runId, decision), /command process/);
    child.kill(); await child.exited;
    await client.action(run.runId, decision);
    assert.equal((await client.refresh(run.runId)).snapshot.status, "cancelled");
    assert.equal(writer.store.effects(run.runId).find((effect) => effect.id === effectId)?.status, "prepared");
    assert.equal(writer.store.lease("mutation"), null);
    console.log(JSON.stringify({ worker: "passed", contentionTicks: ticks, crashRecovery: "passed", liveChildGate: "passed", modelCalls: 0 }));
  } finally { child.kill(); await child.exited; writer.close(); }
} finally { await stopWorkflowSessions(); }
process.exit(0);
