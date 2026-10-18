import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import type { CoordinatorWorkflowClient } from "../chat/coordinator-host.js";
import { InitiativeStore } from "../workflows/initiatives/store.js";
import { recordWorkerExit } from "../workflows/leases.js";
import { NativeWorkflowService } from "../workflows/service.js";
import { stallSettings } from "../workflows/stall.js";
import { newId, WorkflowStore } from "../workflows/store.js";
import { DEFAULT_SUPERVISOR, StallDetector } from "../workflows/supervisor.js";
import { WorkflowClient } from "./workflow-client.js";

export interface CoordinatorWorker extends CoordinatorWorkflowClient {
  readonly leaseOwner: string | null;
  stopWorker(): Promise<void>;
  close(): void;
}

export interface CoordinatorSupervisorOptions {
  createClient?: () => CoordinatorWorker;
  pollMs?: number;
  graceMs?: number;
}

/** A stable coordinator client that replaces a worker whose leases stop renewing. */
export class SupervisedCoordinatorClient implements CoordinatorWorkflowClient {
  private client: CoordinatorWorker;
  private readonly createClient: () => CoordinatorWorker;
  private watched: WorkflowStore | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private recovery: Promise<void> | null = null;
  private failure: unknown;
  private closed = false;

  constructor(
    private readonly workspace: string,
    private readonly config: AppConfig,
    options: CoordinatorSupervisorOptions = {},
  ) {
    this.createClient = options.createClient ?? (() => new WorkflowClient(workspace, config));
    this.client = this.createClient();
    const graceMs = options.graceMs ?? stallSettings(config).supervisorGraceMs;
    if (graceMs === 0) return;
    const pollMs = options.pollMs ?? DEFAULT_SUPERVISOR.pollMs;
    const detector = new StallDetector({ graceMs, pollMs });
    this.timer = setInterval(() => {
      if (this.recovery || this.closed || !this.client.leaseOwner) return;
      let runs: string[];
      try {
        if (!this.watched && existsSync(join(workspace, ".baked", "workflows.sqlite")))
          this.watched = new WorkflowStore(workspace, true);
        const leases = (this.watched?.leases() ?? []).filter(
          (lease) => lease.owner_id === this.client.leaseOwner,
        );
        runs = detector.check(leases, process.pid);
      } catch {
        // A missing or busy database is read again on the next poll.
        return;
      }
      if (!runs.length) return;
      // Stopping one worker interrupts every run it owns, including healthy siblings.
      this.recovery = this.recover()
        .catch((error: unknown) => {
          this.failure = error;
        })
        .finally(() => {
          this.recovery = null;
        });
    }, pollMs);
    this.timer.unref();
  }

  private async recover(): Promise<void> {
    const old = this.client;
    const owner = old.leaseOwner;
    await old.stopWorker();
    if (!owner) return;
    const service = new NativeWorkflowService(this.workspace, this.config);
    const commands: string[][] = [];
    const driving = new Map<string, string[]>();
    try {
      // Read ownership after close, including runs the worker acquired while it was stopping.
      const runIds = [
        ...new Set(
          service.store
            .leases()
            .flatMap((lease) => (lease.owner_id === owner && lease.run_id ? [lease.run_id] : [])),
        ),
      ];
      recordWorkerExit(service.store, owner);
      const initiatives = new InitiativeStore(service.store);
      for (const runId of runIds) {
        if (!(await service.takeOverStalledDriver(runId, process.pid, owner))) continue;
        const initiative =
          initiatives.initiativeOfRun(runId) ??
          initiatives.list().find((row) => row.decompose_run_id === runId)?.id;
        if (initiative) {
          const runs = driving.get(initiative) ?? [];
          runs.push(runId);
          driving.set(initiative, runs);
        } else {
          commands.push([
            "resume",
            runId,
            "--expected-revision",
            String(service.store.run(runId).revision),
          ]);
        }
      }
    } finally {
      service.close();
    }
    if (this.closed) return;
    this.client = this.createClient();
    for (const [id, runIds] of driving)
      void this.client.initiativeAction(id, { kind: "drive" }).catch((error: unknown) => {
        for (const runId of runIds) this.reportDriveError(runId, error);
      });
    for (const argv of commands) {
      // Resume durable state; never replay the command whose outcome became uncertain.
      void this.client.command(argv, new AbortController().signal).catch((error: unknown) => {
        const runId = argv[1];
        if (runId) this.reportDriveError(runId, error);
      });
    }
  }

  private reportDriveError(runId: string, error: unknown): void {
    if (this.closed) return;
    let store: WorkflowStore | undefined;
    try {
      store = new WorkflowStore(this.workspace);
      store.artifact(
        runId,
        "diagnostic",
        `errors/${newId()}.txt`,
        `Could not drive the run after worker takeover: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // A diagnostic write must not disable unrelated coordinator operations.
    } finally {
      store?.close();
    }
  }

  private async current(): Promise<CoordinatorWorker> {
    await this.recovery;
    if (this.closed) throw new Error("Coordinator workflow client is closed");
    if (this.failure) throw this.failure;
    return this.client;
  }

  async command(...args: Parameters<CoordinatorWorkflowClient["command"]>): Promise<unknown> {
    return (await this.current()).command(...args);
  }
  async startInitiative(...args: Parameters<CoordinatorWorkflowClient["startInitiative"]>) {
    return (await this.current()).startInitiative(...args);
  }
  async initiativeAction(...args: Parameters<CoordinatorWorkflowClient["initiativeAction"]>) {
    return (await this.current()).initiativeAction(...args);
  }
  async action(runId: string, action: "cancel"): Promise<unknown> {
    const client = await this.current();
    if (!client.action) throw new Error("Workflow client cannot cancel runs");
    return client.action(runId, action);
  }
  async updateGates(...args: Parameters<NonNullable<CoordinatorWorkflowClient["updateGates"]>>) {
    const client = await this.current();
    if (!client.updateGates) throw new Error("Workflow client cannot update gates");
    return client.updateGates(...args);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.recovery;
    this.client.close();
    this.watched?.close();
    this.watched = null;
  }
}
