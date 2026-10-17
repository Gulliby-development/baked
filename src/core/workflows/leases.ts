import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { processTreeAlive } from "../platform/index.js";
import { canonical } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import { DEFAULT_STALL_SETTINGS, silentMs } from "./stall.js";
import { type LeaseResource, type LeaseRow, newId, WorkflowStore } from "./store.js";
import { transientSqliteError } from "./transient-sqlite.js";

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
/**
 * The execution lease a run holds while it executes: its own (`execution:` and the run id) when it
 * runs in a worktree, so worktree runs execute side by side, otherwise the workspace-wide one.
 */
export function executionLeaseFor(store: WorkflowStore, runId: string): LeaseResource {
  return runInWorktree(store, runId) ? `execution:${runId}` : "execution";
}
export function isExecutionLease(resource: string): boolean {
  return resource === "execution" || resource.startsWith("execution:");
}
/** The execution leases whose owner may still be alive: the runs executing in this workspace. */
export function executingLeases(store: WorkflowStore): LeaseRow[] {
  return store
    .leases()
    .filter((lease) => isExecutionLease(lease.resource) && leaseOwnerAlive(lease) !== false);
}
/** The execution lease when it blocks edits of the project working copy, otherwise null. */
function blockingExecution(store: WorkflowStore): LeaseRow | null {
  const execution = store.lease("execution");
  return execution && !runInWorktree(store, execution.run_id) ? execution : null;
}

/**
 * A lease whose owner stopped renewing because its run showed no progress (`stalledSince` in the
 * owner identity) may be taken over by another owner once it has been expired this long. The
 * epoch fences the old owner: its next `assert` fails and it stops writing.
 */
export const STALL_TAKEOVER_GRACE_MS = 30_000;
const stalledOwner = (lease: LeaseRow): boolean => {
  try {
    const owner = JSON.parse(lease.process_identity_json) as { stalledSince?: number };
    return (
      typeof owner.stalledSince === "number" &&
      lease.expires_at + STALL_TAKEOVER_GRACE_MS < Date.now()
    );
  } catch {
    return false;
  }
};

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
/** How long a lease lasts without renewal, and how often its owner renews it. */
const LEASE_TTL_MS = 15_000;
const HEARTBEAT_MS = 5_000;

export class WorkspaceLeases {
  readonly owner = newId();
  private held = new Map<LeaseRow["resource"], LeaseRow>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lost = new AbortController();
  /**
   * A run that journals no progress for this long stops renewing its leases, so a hung but alive
   * owner expires and another process can take the run over (`workflows.stall.stepStallMs`).
   */
  progressWindowMs = Math.ceil(DEFAULT_STALL_SETTINGS.stepStallMs * 1.5);
  private markedStalled = new Set<LeaseRow["resource"]>();
  /** When renewals began to fail with a transient SQLite error, or null while they succeed. */
  private failingSince: number | null = null;
  /** Leases whose loss stops only the work under them (a task worktree), not the whole owner. */
  private isolated = new Map<LeaseRow["resource"], AbortController>();
  get signal(): AbortSignal {
    return this.lost.signal;
  }
  /** Aborted when this lease is lost: an isolated lease's own signal, otherwise the owner's. */
  signalOf(resource: LeaseRow["resource"]): AbortSignal {
    return this.isolated.get(resource)?.signal ?? this.lost.signal;
  }
  constructor(private store: WorkflowStore) {}
  /**
   * Takes a lease. An isolated lease (a task worktree of a run with several writers) is renewed
   * with the others, but losing it aborts only `signalOf(resource)`, so one lost task does not
   * stop the tasks beside it. `maxExecuting` caps an execution lease: it is refused while that
   * many other runs already execute in the workspace.
   */
  acquire(
    resource: LeaseRow["resource"],
    runId: string | null,
    options: { isolated?: boolean; maxExecuting?: number } = {},
  ): void {
    this.store.transaction(() => {
      if (options.maxExecuting !== undefined && isExecutionLease(resource)) {
        const others = executingLeases(this.store).filter((lease) => lease.run_id !== runId);
        if (others.length >= options.maxExecuting)
          throw new WorkflowFault(
            "WORKSPACE_BUSY",
            `${others.length} run${others.length === 1 ? " is" : "s are"} already executing in this workspace (workflows.maxParallelRuns is ${options.maxExecuting}): ${others.map((lease) => lease.run_id ?? lease.owner_id).join(", ")}`,
          );
      }
      const previous = this.store.lease(resource);
      if (previous?.owner_id === this.owner && previous.run_id !== runId)
        throw new WorkflowFault("WORKSPACE_BUSY", "Another run is executing in this service");
      if (previous && previous.owner_id !== this.owner) {
        // PID reuse is conservative: a live PID is never taken over on TTL alone. The exception
        // is an owner that stopped renewing because its run made no progress.
        if (leaseOwnerAlive(previous) !== false && !stalledOwner(previous))
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
        expires_at: Date.now() + LEASE_TTL_MS,
        process_identity_json: canonical(identity),
      };
      this.store.putLease(row);
      this.held.set(resource, row);
      if (options.isolated) this.isolated.set(resource, new AbortController());
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      this.timer.unref();
    }
  }
  assert(resource: LeaseRow["resource"]): void {
    this.lost.signal.throwIfAborted();
    this.isolated.get(resource)?.signal.throwIfAborted();
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
  /**
   * The row a heartbeat writes: renewed while the lease's run makes progress, otherwise left to
   * expire after one write that marks the owner as stalled.
   */
  private renewal(resource: LeaseRow["resource"], held: LeaseRow): LeaseRow {
    const stalled = held.run_id !== null && silentMs(held.run_id) > this.progressWindowMs;
    if (!stalled) {
      if (this.markedStalled.delete(resource))
        return {
          ...held,
          expires_at: Date.now() + LEASE_TTL_MS,
          process_identity_json: canonical(identity),
        };
      return { ...held, expires_at: Date.now() + LEASE_TTL_MS };
    }
    if (this.markedStalled.has(resource)) return held;
    this.markedStalled.add(resource);
    return { ...held, process_identity_json: canonical({ ...identity, stalledSince: Date.now() }) };
  }
  private heartbeat(): void {
    for (const [resource, controller] of this.isolated) {
      const held = this.held.get(resource);
      if (!held || controller.signal.aborted) continue;
      try {
        this.store.transaction(() => {
          this.assert(resource);
          const renewed = this.renewal(resource, held);
          this.store.putLease(renewed);
          this.held.set(resource, renewed);
        });
      } catch (error) {
        if (this.tolerable(error)) continue;
        // Another owner holds it now: only the work under this lease stops, and the durable
        // lease is left to its new owner.
        this.held.delete(resource);
        controller.abort(error);
      }
    }
    try {
      this.store.transaction(() => {
        for (const [resource, held] of this.held) {
          if (this.isolated.has(resource)) continue;
          this.assert(resource);
          const renewed = this.renewal(resource, held);
          this.store.putLease(renewed);
          this.held.set(resource, renewed);
        }
      });
      this.failingSince = null;
    } catch (error) {
      if (this.tolerable(error)) return;
      // The owner must stop its processes before releasing the durable lease.
      // A failed renewal alone never proves that its effects have stopped.
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.lost.abort(error);
    }
  }
  /**
   * A transient SQLite error (a disk I/O error after the host slept, a busy database) is not a
   * lost lease: the next heartbeat renews it, as long as that is still before the lease expires
   * (#1410). Past that, another owner may have taken it, and the failure counts as a loss.
   */
  private tolerable(error: unknown): boolean {
    if (!transientSqliteError(error)) return false;
    const now = Date.now();
    this.failingSince ??= now;
    return now - this.failingSince < LEASE_TTL_MS - HEARTBEAT_MS;
  }
  /** Releases one lease and keeps the others, as a task worktree's lease after its integration. */
  releaseOne(resource: LeaseRow["resource"]): void {
    const held = this.held.get(resource);
    if (held) this.store.releaseLease(resource, this.owner, held.owner_epoch);
    this.held.delete(resource);
    this.isolated.delete(resource);
    this.markedStalled.delete(resource);
  }
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const [resource, held] of this.held)
      this.store.releaseLease(resource, this.owner, held.owner_epoch);
    this.held.clear();
    this.isolated.clear();
    this.markedStalled.clear();
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

/**
 * The tail of the mutations this process runs per workspace. A tool call that mutates waits for
 * the ones before it instead of failing on their lease: parallel tool calls of one chat and
 * parallel chats of one project run in the same process.
 */
const localMutations = new Map<string, Promise<void>>();

export async function withWorkspaceMutation<T>(
  workspace: string,
  action: () => Promise<T>,
): Promise<T> {
  if (currentOwner.getStore()) {
    assertWorkspaceMutationAllowed(workspace);
    return action();
  }
  const key = resolve(workspace);
  const previous = localMutations.get(key) ?? Promise.resolve();
  let finish = () => {};
  const gate = new Promise<void>((done) => {
    finish = done;
  });
  const tail = previous.then(() => gate);
  localMutations.set(key, tail);
  try {
    await previous;
    return await leasedMutation(workspace, action);
  } finally {
    finish();
    if (localMutations.get(key) === tail) localMutations.delete(key);
  }
}

async function leasedMutation<T>(workspace: string, action: () => Promise<T>): Promise<T> {
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
