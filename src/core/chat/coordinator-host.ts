/**
 * The project coordinator for a front end without `baked serve`, such as the terminal UI. It runs
 * through `ChatService` like the server's coordinator, so the brief, the project state, the launch
 * tools and split approval behave the same. Project state is read from the workflow database
 * read-only; runs and initiatives start through the front end's own workflow client.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import { attentionItems } from "../workflows/attention.js";
import { uniqueFeatureId } from "../workflows/feature-id.js";
import type { InitiativeStartInput } from "../workflows/initiatives/forms.js";
import { InitiativeService, type InitiativeView } from "../workflows/initiatives/service.js";
import type { InitiativeAction } from "../workflows/initiatives/view-model.js";
import { NativeWorkflowService } from "../workflows/service.js";
import { githubTasks, type ProjectLauncher, type RunControl } from "./coordinator-launch.js";
import { BakeChatHost } from "./host.js";
import { type ProjectStateSource, serviceStateSource } from "./project-state.js";
import { type ChatAgentHost, ChatService, type ChatSession } from "./sessions.js";

/** The parts of the terminal UI's workflow client the coordinator starts work with. */
export interface CoordinatorWorkflowClient {
  command(argv: string[], signal: AbortSignal, onDrive?: (runId: string) => void): Promise<unknown>;
  startInitiative(input: InitiativeStartInput): Promise<InitiativeView>;
  initiativeAction(initiativeId: string, action: InitiativeAction): Promise<InitiativeView>;
}

/**
 * Project state over a read-only view of `.baked/workflows.sqlite`, opened on first use; before any
 * run exists the lists are empty.
 */
export class ReadonlyProjectState implements ProjectStateSource {
  private service: NativeWorkflowService | null = null;
  private source: ProjectStateSource | null = null;

  constructor(
    private readonly workspace: string,
    private readonly config: AppConfig,
  ) {}

  private open(): ProjectStateSource | null {
    if (this.source) return this.source;
    if (!existsSync(join(this.workspace, ".baked", "workflows.sqlite"))) return null;
    const service = new NativeWorkflowService(this.workspace, this.config, undefined, true);
    const initiatives = new InitiativeService(service);
    this.service = service;
    this.source = serviceStateSource(service, initiatives, () =>
      attentionItems(service.store, initiatives.store),
    );
    return this.source;
  }

  private need(): ProjectStateSource {
    const source = this.open();
    if (!source) throw new Error("No workflow run or initiative exists in this project yet");
    return source;
  }

  /** Whether a run of feature `id` exists; false before any run. */
  featureTaken(id: string): boolean {
    this.open();
    return (this.service?.store.list(1, id).items.length ?? 0) > 0;
  }

  runs(limit: number) {
    return this.open()?.runs(limit) ?? [];
  }
  run(id: string) {
    return this.need().run(id);
  }
  initiatives() {
    return this.open()?.initiatives() ?? [];
  }
  initiative(id: string) {
    return this.need().initiative(id);
  }
  attention() {
    return this.open()?.attention() ?? [];
  }

  close(): void {
    this.service?.close();
    this.service = null;
    this.source = null;
  }
}

/**
 * Starts runs and initiatives through a workflow client, as `/workflow run` and the initiative
 * form do. A run resolves once it is being driven; the client keeps driving it.
 */
export function clientLauncher(
  client: CoordinatorWorkflowClient,
  options: {
    workspace: string;
    config: AppConfig;
    /** The model a run starts with when the coordinator names none. */
    model: () => string;
    featureTaken: (id: string) => boolean;
    /** The run's revision now, which a decision or cancel names. */
    revision?: (runId: string) => number;
  },
): ProjectLauncher {
  /** Runs one workflow command; resolves once it is done or, for a resume, being driven. */
  const command = (argv: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      client
        .command(argv, new AbortController().signal, () => resolve())
        .then(
          () => resolve(),
          (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
        );
    });
  return {
    startRun: ({ prompt, workflow, feature, worktree, issue }) =>
      new Promise((resolve, reject) => {
        const argv = [
          "run",
          "--prompt",
          prompt,
          "--model",
          options.model(),
          "--owner",
          "Coordinator",
        ];
        // From an issue without a feature, the core names the feature after the issue.
        const featureId = feature ?? (issue ? null : uniqueFeatureId(prompt, options.featureTaken));
        if (featureId) argv.push("--feature", featureId);
        if (issue) argv.push("--issue", issue);
        if (workflow) argv.push("--workflow", workflow);
        if (worktree) argv.push("--worktree");
        let started = false;
        client
          .command(argv, new AbortController().signal, (runId) => {
            started = true;
            resolve({ runId });
          })
          .then(
            () => {
              if (!started) reject(new Error("The run did not start"));
            },
            (error: unknown) => {
              if (!started) reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
      }),
    startInitiative: async ({ initiativeId, prompt, plan, approveSplit, featureIssues }) => {
      let view = await client.startInitiative({
        initiativeId,
        prompt,
        ...(plan ? { plan } : {}),
        ...(featureIssues ? { featureIssues } : {}),
      });
      const split = view.pendingDecisions.find((d) => d.kind === "split_approval");
      if (approveSplit && split)
        view = await client.initiativeAction(view.initiativeId, {
          kind: "approve",
          expectedRevision: view.revision,
          requestId: split.requestId,
          digest: split.digest,
        });
      return { initiativeId: view.initiativeId };
    },
    tasks: githubTasks(options.workspace, options.config),
    // As /workflow approve, reject and cancel do; an approved run goes on through the worker.
    ...(options.revision
      ? {
          control: async (control: RunControl) => {
            const revision = String(options.revision?.(control.runId) ?? 0);
            const head = [control.action, control.runId, "--expected-revision", revision];
            if (control.action === "cancel") return command(head);
            if (control.action === "reject")
              return command([...head, "--request", control.requestId, "--reason", control.reason]);
            return command([
              ...head,
              "--request",
              control.requestId,
              "--digest",
              control.digest,
              "--resume",
            ]);
          },
        }
      : {}),
  };
}

/** The coordinator of one project, hosted in this process. */
export class LocalCoordinator {
  private constructor(
    readonly chat: ChatService,
    readonly session: ChatSession,
    private readonly state: ReadonlyProjectState,
  ) {}

  /** Opens the project's coordinator, creating it the first time. */
  static async open(options: {
    workspace: string;
    config: AppConfig;
    client: CoordinatorWorkflowClient | null;
    /** The model new runs and a new coordinator use. */
    model: () => string;
    host?: ChatAgentHost;
    homeDir?: string;
    /** How often launched work is checked; 0 turns the timer off (tests). */
    watchMs?: number;
  }): Promise<LocalCoordinator> {
    const { workspace, config } = options;
    const chat = new ChatService({
      workspace,
      config,
      host: options.host ?? new BakeChatHost(workspace, config),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    });
    const state = new ReadonlyProjectState(workspace, config);
    const launcher = options.client
      ? clientLauncher(options.client, {
          workspace,
          config,
          model: options.model,
          featureTaken: (id) => state.featureTaken(id),
          revision: (runId) => state.run(runId).summary.snapshot.revision,
        })
      : null;
    chat.setProjectState(state, launcher, options.watchMs ?? 2000);
    try {
      const session = await chat.coordinator(true, options.model());
      if (!session) throw new Error("The coordinator could not be created");
      return new LocalCoordinator(chat, session, state);
    } catch (error) {
      await chat.shutdown();
      state.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.chat.shutdown();
    this.state.close();
  }
}
