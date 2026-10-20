import assert from "node:assert/strict";
import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import { WorkflowClient } from "../../src/core/workers/workflow-client.js";
import { ManualSupervisorClock } from "../helpers/supervisor-clock.js";

const clock = new ManualSupervisorClock();
class TimedClient extends WorkflowClient {
  constructor(...args: ConstructorParameters<typeof WorkflowClient>) {
    const [workspace, config, exitedOwners, intelligence, options] = args;
    super(workspace, config, exitedOwners, intelligence, {
      ...options, supervisor: { ...options?.supervisor, clock },
    });
  }
}
mock.module("../../src/core/workers/workflow-client.js", () => ({ WorkflowClient: TimedClient }));
const { stopWorkflowSessions, workflowSession } = await import("../../src/hooks/useWorkflow.js");

// #1541: the terminal UI drives runs in its workflow worker. A worker whose thread stopped leaves
// its leases expired while the UI thread runs; the UI stops it and the next worker takes over.
const workspace = process.env.BAKED_WORKFLOW_FIXTURE_ROOT!;
const config = {
  ...DEFAULT_CONFIG,
  defaultModel: "fixture/no-provider",
  // Indexing and provider-outage retries are separate scenarios. This one ends at provider_unavailable.
  repoMap: false,
  workflows: {
    enabled: true,
    importsEnabled: false,
    defaultWorkflow: "sdd",
    policy: defaultWorkflowPolicy,
    stall: { supervisorGraceMs: 400, autoResumes: 1, providerResumes: 0 },
  },
};
mkdirSync(join(workspace, ".baked"), { recursive: true });
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify(config));
const writer = new NativeWorkflowService(workspace, config);
const run = await writer.start({ commandId: "stall-fixture", workflowId: "sdd", featureId: "stall", prompt: "No model is called", policy: defaultWorkflowPolicy, ownerLabel: "test" });
const client = workflowSession(workspace);
try {
  await client.refresh(run.runId);
  const owner = Reflect.get(client, "owner") as string | null;
  assert(owner, "the worker reports its lease owner");
  // The worker was driving the run when its thread stopped: its execution lease is no longer renewed.
  writer.store.transition(run.runId, "running");
  writer.store.putLease({ resource: "execution", owner_id: owner, owner_epoch: 1, run_id: run.runId, expires_at: Date.now() - 1_000, process_identity_json: JSON.stringify({ pid: process.pid }) });
  const worker = Reflect.get(client, "worker") as Worker;
  const closed = new Promise<void>((resolve) => worker.addEventListener("close", () => resolve(), { once: true }));
  clock.wall = Date.now();
  // Four polls cover the expired lease but not its full grace period. The fifth stops it.
  clock.advance(400);
  assert.equal(Reflect.get(client, "stalled"), null, "the grace period is not shortened");
  clock.advance(100);
  assert.equal(Reflect.get(client, "stalled"), owner, "the supervisor stops it at the controlled deadline");
  await closed;
  const deadline = Date.now() + 20_000;
  assert(client.closed, "the UI stops a worker whose leases stay expired");
  assert.equal(client.stalledOwner, owner);
  let takeover: string | null = null;
  while (!takeover && Date.now() < deadline) {
    const artifact = writer.store.latestArtifact(run.runId, "stalled/takeover-1.json");
    takeover = artifact ? writer.store.readArtifact(run.runId, artifact.id) : null;
    if (!takeover) await Bun.sleep(20);
  }
  assert(takeover, "the next worker takes the run over");
  const record = JSON.parse(takeover) as { owner?: string; pid: number; resumed: boolean };
  assert.deepEqual([record.owner, record.pid, record.resumed], [owner, process.pid, true]);
  const replaced = workflowSession(workspace);
  assert.notEqual(replaced, client);
  assert.equal(writer.store.state(run.runId).stallResumes, 1);
  // The new worker drives the resumed run, here until it needs a model this fixture has none of.
  while (["paused", "running"].includes(writer.store.run(run.runId).status) && Date.now() < deadline) await Bun.sleep(20);
  assert.equal(writer.store.run(run.runId).reason, "provider_unavailable");
  console.log(JSON.stringify({ stall: "passed", status: writer.store.run(run.runId).status }));
} finally {
  await stopWorkflowSessions();
  writer.close();
}
process.exit(0);
