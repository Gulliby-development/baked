import { randomUUID as newId } from "node:crypto";
import type { AppConfig } from "../../types/index.js";
import type { PastRun } from "../workflows/estimate.js";
import type { GateRunResult } from "../workflows/gates.js";
import type { InitiativeView } from "../workflows/initiatives/service.js";
import type { InitiativeAction, InitiativeListView } from "../workflows/initiatives/view-model.js";
import type { RollbackReport } from "../workflows/rollback.js";
import type { RunFileDiff } from "../workflows/run-diff.js";
import type { Decision, RunSnapshot } from "../workflows/schemas.js";
import type { Check } from "../workflows/types.js";
import type { RunSummary, StartRunInput, WorkflowInfo, WorkflowView } from "../workflows/view.js";
import { workerPath } from "./path.js";
import { WorkerClient } from "./rpc.js";

/** `reroute` moves a stopped run to another run model and continues it in one decision. */
export type WorkflowAction =
  | "resume"
  | "pause"
  | "cancel"
  | "fork"
  | "extend"
  | { reroute: string }
  | Decision;
/** The run after an undo, and the `workspace-rollback` report it wrote; null when nothing was undone. */
export interface UndoResult {
  snapshot: RunSnapshot;
  report: RollbackReport | null;
}

export class WorkflowClient extends WorkerClient {
  private views = new Map<string, WorkflowView>();
  private driving = new Set<string>();
  private driveErrors = new Map<string, string>();
  private commandCallbacks = new Map<string, (runId: string) => void>();
  private owner: string | null = null;
  private changeListeners = new Set<(runId: string) => void>();
  closed = false;
  get exitedOwner(): string | null {
    return this.closed ? this.owner : null;
  }
  constructor(workspace: string, config: AppConfig, exitedOwners: string[] = []) {
    super(
      workerPath("workflow", import.meta.url, import.meta.dir),
      { workspace, config, exitedOwners },
      { smol: true },
    );
    this.on("owner", (owner) => {
      if (typeof owner === "string") this.owner = owner;
    });
    this.worker.addEventListener("close", () => {
      this.closed = true;
      this.driving.clear();
    });
    this.on("drive", (value) => {
      const event = value as { id: string; runId: string };
      this.driving.add(event.runId);
      this.driveErrors.delete(event.runId);
      this.commandCallbacks.get(event.id)?.(event.runId);
    });
    this.on("changed", (value) => {
      const { runId } = value as { runId: string };
      for (const listener of this.changeListeners) listener(runId);
    });
    this.on("driven", (value) => {
      this.driving.delete((value as { runId: string }).runId);
    });
    this.on("drive-error", (value) => {
      const event = value as { runId: string; message: string };
      this.driveErrors.set(event.runId, event.message);
    });
  }
  // Never restart or replay workflow mutations after an uncertain worker exit.
  protected override tryRestart(): boolean {
    return false;
  }
  isRunning(runId: string): boolean {
    if (this.closed) return false;
    return this.driving.has(runId) || this.views.get(runId)?.snapshot.status === "running";
  }
  /** True when this process is actively executing the run, as opposed to only observing it. */
  isDriving(runId: string): boolean {
    return !this.closed && this.driving.has(runId);
  }
  /** Runs this process is executing now. */
  drivingRuns(): string[] {
    return this.closed ? [] : [...this.driving];
  }
  driveError(runId: string): string | null {
    return this.driveErrors.get(runId) ?? null;
  }
  async refresh(runId: string): Promise<WorkflowView> {
    const cached = this.views.get(runId);
    const view = await this.call<WorkflowView | null>("view", runId, cached?.stamp ?? null);
    if (view) this.views.set(runId, view);
    const result = view ?? cached;
    if (!result) throw new Error(`Workflow view unavailable for ${runId}`);
    return result;
  }
  /** Notifies after the worker appends events for a run. Returns an unsubscribe function. */
  onChange(listener: (runId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  diff(runId: string, path: string): Promise<RunFileDiff> {
    return this.call<RunFileDiff>("diff", runId, path);
  }
  list(limit = 50): Promise<RunSummary[]> {
    return this.call<RunSummary[]>("list", limit);
  }
  /** Every initiative of the project, with what this worker is driving. */
  initiatives(): Promise<InitiativeListView> {
    return this.call<InitiativeListView>("initiatives");
  }
  /** Runs one initiative command; approve, resume and continue keep driving in the worker. */
  initiativeAction(initiativeId: string, action: InitiativeAction): Promise<InitiativeView> {
    return this.callWithTimeout<InitiativeView>(null, "initiativeAction", initiativeId, action);
  }
  info(): Promise<WorkflowInfo> {
    return this.call<WorkflowInfo>("info");
  }
  /** What earlier runs of this project spent, per stage; the input of the editor's estimate. */
  history(): Promise<PastRun[]> {
    return this.call<PastRun[]>("history");
  }
  start(input: StartRunInput): Promise<RunSnapshot> {
    return this.callWithTimeout<RunSnapshot>(null, "start", newId(), input);
  }
  /** Runs a gate in the worker. Aborting the signal stops the gate's process tree. */
  async runGate(check: Check, signal: AbortSignal): Promise<GateRunResult> {
    signal.throwIfAborted();
    const id = newId();
    const abort = (): void => this.fire("abort", id);
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.callWithTimeout<GateRunResult>(null, "gateRun", id, check);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  /** Gives new runs the saved gate list without restarting the worker. */
  updateGates(checks: Check[]): Promise<void> {
    return this.call<void>("gatesUpdate", checks);
  }
  readonly store = {
    snapshot: (id: string) => this.views.get(id)?.snapshot ?? null,
    details: (id: string) => this.views.get(id)?.details ?? null,
    stages: (id: string) => this.views.get(id)?.stages ?? [],
    budget: (id: string) => this.views.get(id)?.budget ?? null,
    estimate: (id: string) => this.views.get(id)?.estimate ?? null,
    events: (id: string) => this.views.get(id)?.events ?? [],
    tasks: (id: string) => this.views.get(id)?.tasks ?? [],
    checks: (id: string) => this.views.get(id)?.checks ?? [],
    checkDetails: (id: string) => this.views.get(id)?.checkDetails ?? [],
    changes: (id: string) => this.views.get(id)?.changes ?? [],
    configuredChecks: (id: string) => this.views.get(id)?.configuredChecks ?? [],
    findings: (id: string) => this.views.get(id)?.findings ?? [],
    requests: (id: string) => this.views.get(id)?.requests ?? [],
    runModel: (id: string) => this.views.get(id)?.runModel ?? null,
  };
  async command(
    argv: string[],
    signal: AbortSignal,
    onDrive?: (runId: string) => void,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const id = newId();
    let driven: string | undefined;
    this.commandCallbacks.set(id, (runId) => {
      driven = runId;
      onDrive?.(runId);
    });
    const abort = (): void => this.fire("abort", id);
    signal.addEventListener("abort", abort, { once: true });
    try {
      // Scheduler enforces the persisted run policy, including revisions and custom policy files.
      return await this.callWithTimeout(null, "command", id, argv);
    } finally {
      this.commandCallbacks.delete(id);
      signal.removeEventListener("abort", abort);
      if (driven) this.driving.delete(driven);
    }
  }
  async action(runId: string, action: WorkflowAction): Promise<RunSnapshot> {
    const drives = action === "resume" || action === "extend" || typeof action !== "string";
    if (drives) this.driving.add(runId);
    try {
      return await this.callWithTimeout<RunSnapshot>(null, "action", runId, action);
    } finally {
      if (drives) this.driving.delete(runId);
    }
  }
  /** Undoes the run's uncommitted task edits; the run must not be running. */
  undo(runId: string): Promise<UndoResult> {
    return this.callWithTimeout<UndoResult>(null, "undo", runId);
  }
  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.callWithTimeout(30000, "shutdown");
  }
  close(): void {
    this.dispose();
  }
}
