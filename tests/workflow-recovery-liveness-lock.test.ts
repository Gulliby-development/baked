import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { processProbe, WorkspaceLeases } from "../src/core/workflows/leases.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";

// A recovery decision read the Windows process table (seconds of PowerShell) inside the store
// transaction, so the SQLite write lock was held the whole time and every other writer waited.
// The stubbed read below is slow and, while it runs, takes the write lock from a second
// connection without waiting: that fails while a transaction of the service holds it.

const realProbe = processProbe.treeAlive;
const cleanups: (() => void)[] = [];
afterEach(() => {
  processProbe.treeAlive = realProbe;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const DEAD_PID = 2147483647;
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [] };
const idle: AgentExecutor = {
  execute: async () => {
    throw new Error("No model call is expected");
  },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "baked-liveness-lock-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    ...DEFAULT_CONFIG,
    defaultModel: "fixture/model",
    workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy },
  };
  const service = new NativeWorkflowService(root, config, idle);
  cleanups.push(() => service.close());
  return service;
}

/** Replaces the process-table read with a slow one that records whether the lock was free. */
function slowProbe(path: string) {
  const other = new Database(path);
  other.exec("PRAGMA busy_timeout=0");
  cleanups.push(() => other.close());
  const reads: { pid: number; lockFree: boolean }[] = [];
  processProbe.treeAlive = (pid) => {
    Bun.sleepSync(25);
    let lockFree = true;
    try {
      other.exec("BEGIN IMMEDIATE");
      other.exec("ROLLBACK");
    } catch {
      lockFree = false;
    }
    reads.push({ pid, lockFree });
    return false;
  };
  return reads;
}

async function crashedRun(service: NativeWorkflowService) {
  const run = await service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt: "Fixture",
    ownerLabel: "test",
    policy,
  });
  const step = service.store.beginStep(run.runId, "crashed-check");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const spawnedAt = Date.now();
  const check = service.store.prepareEffect(
    run.runId,
    attempt,
    "command",
    { checkId: "check", pid: DEAD_PID, spawnedAt },
    null,
    null,
  );
  service.store.prepareEffect(
    run.runId,
    attempt,
    "command",
    { executable: "bun", pid: DEAD_PID - 1, spawnedAt },
    null,
    null,
  );
  service.store.putLease({
    resource: "execution",
    owner_id: "dead-owner",
    owner_epoch: 1,
    run_id: run.runId,
    expires_at: 0,
    process_identity_json: JSON.stringify({ pid: DEAD_PID }),
  });
  return { runId: run.runId, check };
}

test("resume and a recovery decision read command processes outside the store transaction", async () => {
  const service = setup();
  const { runId, check } = await crashedRun(service);
  const reads = slowProbe(service.store.path);
  const resumed = await service.resume(runId, {
    commandId: newId(),
    expectedRevision: (await service.get(runId)).revision,
  });
  const request = service.store
    .requests(runId)
    .find((r) => r.kind === "recovery" && JSON.parse(r.body_json).effectId === check);
  expect(request).toBeDefined();
  const decided = await service.decide(
    runId,
    { commandId: newId(), expectedRevision: resumed.revision },
    {
      kind: "recovery",
      requestId: request!.id,
      effectId: check,
      resolution: "cancel",
      evidence: "Both processes are gone",
    },
  );
  expect(decided.status).toBe("cancelled");
  // Both commands were checked, and no read held the write lock.
  expect(new Set(reads.map((r) => r.pid))).toEqual(new Set([DEAD_PID, DEAD_PID - 1]));
  expect(reads.filter((r) => !r.lockFree)).toEqual([]);
});

test("pausing a crashed run reads its command processes before releasing its leases", async () => {
  const service = setup();
  const { runId } = await crashedRun(service);
  service.store.putLease({
    resource: "mutation",
    owner_id: "dead-owner",
    owner_epoch: 1,
    run_id: runId,
    expires_at: 0,
    process_identity_json: JSON.stringify({ pid: DEAD_PID }),
  });
  const reads = slowProbe(service.store.path);
  await service.cancel(runId, {
    commandId: newId(),
    expectedRevision: (await service.get(runId)).revision,
  });
  expect(service.store.leases().filter((lease) => lease.run_id === runId)).toEqual([]);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.filter((r) => !r.lockFree)).toEqual([]);
});

test("a lease takeover reads the dead owner's command processes outside the transaction", async () => {
  const service = setup();
  const { runId } = await crashedRun(service);
  const reads = slowProbe(service.store.path);
  const leases = new WorkspaceLeases(service.store);
  cleanups.push(() => leases.release());
  leases.acquire("execution", runId);
  expect(service.store.lease("execution")?.owner_id).toBe(leases.owner);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.filter((r) => !r.lockFree)).toEqual([]);
});
