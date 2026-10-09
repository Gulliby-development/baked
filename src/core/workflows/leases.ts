import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { processTreeAlive } from "../platform/index.js";
import { canonical } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import { type LeaseResource, type LeaseRow, newId, WorkflowStore } from "./store.js";

/**
 * The mutation lease that guards writes under `root`: the project lease for the project root,
 * otherwise the lease of that worktree, named by its path relative to the project root.
 */
export function mutationLeaseFor(workspace: string, root: string): LeaseResource {
  const path = relative(workspace, root).replaceAll("\\", "/");
  return path === "" ? "mutation" : `worktree:${path}`;
}
/** True when the run executes in its own worktree, so the project working copy stays free. */
function runInWorktree(store: WorkflowStore, runId: string | null): boolean {
  if (!runId) return false;
  try {
    const policy = JSON.parse(store.run(runId).policy_json) as { executionMode?: string };
    return policy.executionMode === "worktree";
  } catch {
    return false;
  }
}
/** The execution lease when it blocks edits of the project working copy, otherwise null. */
function blockingExecution(store: WorkflowStore): LeaseRow | null {
  const execution = store.lease("execution");
  return execution && !runInWorktree(store, execution.run_id) ? execution : null;
}

const identity = {
  pid: process.pid,
  startedAt: Date.now() - process.uptime() * 1000,
  instance: newId(),
};
const currentOwner = new AsyncLocalStorage<string>();
export const hasWorkspaceMutationContext = (): boolean => currentOwner.getStore() !== undefined;
export const withinWorkflow = <T>(owner: string, action: () => T): T =>
  currentOwner.run(owner, action);
export function processAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
}
export function leaseOwnerAlive(lease: LeaseRow): boolean | null {
  const owner = JSON.parse(lease.process_identity_json) as typeof identity & {
    exitedWorkerOwner?: string;
  };
  return owner.exitedWorkerOwner === lease.owner_id ? false : processAlive(owner.pid);
}

/** A command of unknown outcome whose process is not proven stopped blocks any takeover. */
/**
 * A command effect may still have running processes unless its PID is recorded and neither the
 * process nor a descendant started after it is alive. An unreadable process table counts as alive.
 */
export function commandProcessMayRun(intentJson: string, createdAt = 0): boolean {
  const intent = JSON.parse(intentJson) as { pid?: number; spawnedAt?: number; scope?: string };
  if (intent.pid === undefined) return true;
  return processTreeAlive(intent.pid, intent.spawnedAt ?? createdAt, intent.scope) !== false;
}
export function commandMayBeRunning(store: WorkflowStore, runId: string): boolean {
  return store
    .effects(runId)
    .some(
      (e) =>
        e.kind === "command" &&
        ["prepared", "unknown"].includes(e.status) &&
        commandProcessMayRun(e.intent_json),
    );
}
/**
 * Releases this run's leases when their owner process is proven gone and no owned command may
 * still run; the same conditions under which acquire() would take them over. Call inside a
 * store transaction. Returns the released resources.
 */
export function releaseDeadOwnerLeases(store: WorkflowStore, runId: string): string[] {
  const stale = store.leases().filter((lease) => lease.run_id === runId);
  if (!stale.length || stale.some((lease) => leaseOwnerAlive(lease) !== false)) return [];
  if (commandMayBeRunning(store, runId)) return [];
  store.artifact(
    runId,
    "recovery",
    `released-leases/${newId()}.json`,
    canonical({ leases: stale, observedByPid: process.pid, observedAt: Date.now() }),
  );
  for (const lease of stale) store.releaseLease(lease.resource, lease.owner_id, lease.owner_epoch);
  return stale.map((lease) => lease.resource);
}
/** Only the owning host, after the exact Worker's close event, supplies these owner IDs. */
export function recordWorkerExit(store: WorkflowStore, ownerId: string): void {
  store.transaction(() => {
    for (const lease of store.leases()) {
      if (lease.owner_id !== ownerId) continue;
      const resource = lease.resource;
      const owner = JSON.parse(lease.process_identity_json) as typeof identity & {
        exitedWorkerOwner?: string;
      };
      if (owner.exitedWorkerOwner === ownerId) continue;
      if (owner.pid !== process.pid)
        throw new WorkflowFault("WORKSPACE_BUSY", "Worker belongs to another host process");
      if (lease.run_id)
        store.artifact(
          lease.run_id,
          "worker-exit",
          `worker-exits/${ownerId}/${resource.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`,
          canonical({ lease, observedByPid: process.pid, observedAt: Date.now() }),
        );
      // Preserve the lease and uncertain effects; recovery still checks every command PID.
      store.putLease({
        ...lease,
        process_identity_json: canonical({ ...owner, exitedWorkerOwner: ownerId }),
      });
    }
  });
}
export class WorkspaceLeases {
  readonly owner = newId();
  private held = new Map<LeaseRow["resource"], LeaseRow>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lost = new AbortController();
  get signal(): AbortSignal {
    return this.lost.signal;
  }
  constructor(private store: WorkflowStore) {}
  acquire(resource: LeaseRow["resource"], runId: string | null): void {
    this.store.transaction(() => {
      const previous = this.store.lease(resource);
      if (previous?.owner_id === this.owner && previous.run_id !== runId)
        throw new WorkflowFault("WORKSPACE_BUSY", "Another run is executing in this service");
      if (previous && previous.owner_id !== this.owner) {
        // PID reuse is conservative: a live PID is never taken over on TTL alone.
        if (leaseOwnerAlive(previous) !== false)
          throw new WorkflowFault(
            "WORKSPACE_BUSY",
            `Workspace ${resource} is owned by ${previous.run_id ?? previous.owner_id}`,
          );
        if (previous.run_id && commandMayBeRunning(this.store, previous.run_id))
          throw new WorkflowFault(
            "RECOVERY_REQUIRED",
            `Owner exited with a command of unknown outcome: ${previous.run_id}`,
          );
      }
      const row: LeaseRow = {
        resource,
        owner_id: this.owner,
        owner_epoch: (previous?.owner_epoch ?? 0) + 1,
        run_id: runId,
        expires_at: Date.now() + 15000,
        process_identity_json: canonical(identity),
      };
      this.store.putLease(row);
      this.held.set(resource, row);
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.heartbeat(), 5000);
      this.timer.unref();
    }
  }
  assert(resource: LeaseRow["resource"]): void {
    this.lost.signal.throwIfAborted();
    const held = this.held.get(resource);
    const actual = this.store.lease(resource);
    if (
      !held ||
      !actual ||
      actual.owner_id !== this.owner ||
      actual.owner_epoch !== held.owner_epoch
    )
      throw new WorkflowFault("WORKSPACE_BUSY", "Workspace lease ownership changed");
  }
  private heartbeat(): void {
    try {
      this.store.transaction(() => {
        for (const [resource, held] of this.held) {
          this.assert(resource);
          const renewed = { ...held, expires_at: Date.now() + 15000 };
          this.store.putLease(renewed);
          this.held.set(resource, renewed);
        }
      });
    } catch (error) {
      // The owner must stop its processes before releasing the durable lease.
      // A failed renewal alone never proves that its effects have stopped.
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.lost.abort(error);
    }
  }
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const [resource, held] of this.held)
      this.store.releaseLease(resource, this.owner, held.owner_epoch);
    this.held.clear();
    this.lost = new AbortController();
  }
}

/** Called before legacy mutation paths and before their hooks execute. */
export function assertWorkspaceMutationAllowed(workspace: string): void {
  if (!existsSync(join(workspace, ".baked", "workflows.sqlite"))) return;
  const store = new WorkflowStore(workspace, true);
  try {
    // A run in its own worktree holds that worktree's lease; the project copy stays editable.
    const lease = store.lease("mutation") ?? blockingExecution(store);
    if (lease && lease.owner_id !== currentOwner.getStore())
      throw new WorkflowFault(
        "WORKSPACE_BUSY",
        `Workflow ${lease.run_id ?? lease.owner_id} owns this workspace. Pause or recover it before editing.`,
      );
  } finally {
    store.close();
  }
}

export async function withWorkspaceMutation<T>(
  workspace: string,
  action: () => Promise<T>,
): Promise<T> {
  if (currentOwner.getStore()) {
    assertWorkspaceMutationAllowed(workspace);
    return action();
  }
  const store = new WorkflowStore(workspace);
  const leases = new WorkspaceLeases(store);
  try {
    const execution = blockingExecution(store);
    if (execution)
      throw new WorkflowFault("WORKSPACE_BUSY", `Workflow ${execution.run_id} owns the workspace`);
    leases.acquire("mutation", null);
    return await withinWorkflow(leases.owner, action);
  } finally {
    leases.release();
    store.close();
  }
}
