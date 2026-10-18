import type { AppConfig } from "../../types/index.js";
import type { CoordinatorWorkflowClient } from "../chat/coordinator-host.js";
import { WorkflowClient, type WorkflowClientOptions } from "./workflow-client.js";

export interface CoordinatorWorker extends CoordinatorWorkflowClient {
  readonly exitedOwner: string | null;
  readonly stalledOwner: string | null;
  onStalled: (() => void) | null;
  close(): void;
}

export interface CoordinatorSupervisorOptions {
  createClient?: (exitedOwners: string[], options: WorkflowClientOptions) => CoordinatorWorker;
  pollMs?: number;
  graceMs?: number;
}

/** Keeps the coordinator's launcher connected when WorkflowClient replaces a stalled worker. */
export class SupervisedCoordinatorClient implements CoordinatorWorkflowClient {
  private client: CoordinatorWorker;
  private readonly createClient: NonNullable<CoordinatorSupervisorOptions["createClient"]>;
  private failure: unknown;
  private closed = false;

  constructor(
    workspace: string,
    config: AppConfig,
    private readonly options: CoordinatorSupervisorOptions = {},
  ) {
    this.createClient =
      options.createClient ??
      ((exitedOwners, clientOptions) =>
        new WorkflowClient(workspace, config, exitedOwners, undefined, clientOptions));
    this.client = this.replace();
  }

  private replace(old?: CoordinatorWorker): CoordinatorWorker {
    const exited = old?.exitedOwner;
    const stalled = old?.stalledOwner;
    old?.close();
    const client = this.createClient(exited ? [exited] : [], {
      stalledOwners: stalled ? [stalled] : [],
      supervisor: { graceMs: this.options.graceMs, pollMs: this.options.pollMs },
    });
    // WorkflowClient calls this only after the stalled worker has exited. The new worker
    // takes over durable state through takeOverDriver, without replaying uncertain commands.
    client.onStalled = () => {
      if (this.closed || this.client !== client) return;
      try {
        this.client = this.replace(client);
      } catch (error) {
        this.failure = error;
      }
    };
    return client;
  }

  private current(): CoordinatorWorker {
    if (this.closed) throw new Error("Coordinator workflow client is closed");
    if (this.failure) throw this.failure;
    return this.client;
  }

  async command(...args: Parameters<CoordinatorWorkflowClient["command"]>): Promise<unknown> {
    return this.current().command(...args);
  }
  async startInitiative(...args: Parameters<CoordinatorWorkflowClient["startInitiative"]>) {
    return this.current().startInitiative(...args);
  }
  async initiativeAction(...args: Parameters<CoordinatorWorkflowClient["initiativeAction"]>) {
    return this.current().initiativeAction(...args);
  }
  async action(runId: string, action: "cancel"): Promise<unknown> {
    const client = this.current();
    if (!client.action) throw new Error("Workflow client cannot cancel runs");
    return client.action(runId, action);
  }
  async updateGates(...args: Parameters<NonNullable<CoordinatorWorkflowClient["updateGates"]>>) {
    const client = this.current();
    if (!client.updateGates) throw new Error("Workflow client cannot update gates");
    return client.updateGates(...args);
  }
  close(): void {
    this.closed = true;
    this.client.close();
  }
}
