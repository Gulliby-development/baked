import "../sdk-warnings.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tuiErrorText } from "../../components/workflow/remedies.js";
import { executeWorkflowCommand } from "../../headless/workflow.js";
import { parseWorkflowArgs } from "../../headless/workflow-parse.js";
import { recoveryArgs } from "../../headless/workflow-supervise.js";
import type { AppConfig } from "../../types/index.js";
import { ContextManager } from "../context/manager.js";
import { SharedRootContext } from "../context/shared-root.js";
import { setCwd } from "../cwd.js";
import { installGlobalFetch } from "../llm/http-agent.js";
import { presetPolicy, scaledPolicy, startCostCap } from "../workflows/budget.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { estimateStart, readHistory } from "../workflows/estimate.js";
import { assertWorkspaceFreeForGate, executeGate } from "../workflows/gates.js";
import {
  InitiativeStartInputSchema,
  initiativeStartRequest,
} from "../workflows/initiatives/forms.js";
import { InitiativeId } from "../workflows/initiatives/plan.js";
import { InitiativeService } from "../workflows/initiatives/service.js";
import {
  applyInitiativeAction,
  type InitiativeListView,
} from "../workflows/initiatives/view-model.js";
import { issueStart } from "../workflows/issue-source.js";
import { leaseOwnerAlive, recordWorkerExit } from "../workflows/leases.js";
import { presetChoice } from "../workflows/preset-router.js";
import { ROLLBACK_ARTIFACT_KIND, type RollbackReport } from "../workflows/rollback.js";
import { readRunFileDiff } from "../workflows/run-diff.js";
import {
  CheckSchema,
  DecisionSchema,
  MAX_CONCURRENT_WRITERS,
  type RunPolicy,
  SafeId,
  workflowsEnabled,
} from "../workflows/schemas.js";
import { NativeWorkflowService } from "../workflows/service.js";
import { newId } from "../workflows/store.js";
import { takeOverDriver } from "../workflows/takeover.js";
import { PRESETS } from "../workflows/v2/definition.js";
import { listDefinitions, QUICK_WORKFLOW_ID } from "../workflows/v2/definitions.js";
import { proposeForWorkspace } from "../workflows/v2/propose.js";
import type { WorkflowInfo } from "../workflows/view.js";
import {
  BudgetPreset,
  readWorkflowSummaries,
  readWorkflowViewIfChanged,
} from "../workflows/view.js";
import {
  borrowIntelligence,
  INTELLIGENCE_RELAY_CALLBACK,
  type IntelligenceRelayRequest,
  type IntelligenceRelayTransport,
} from "./intelligence-relay.js";
import { createWorkerHandler } from "./rpc.js";
import type { UndoResult } from "./workflow-client.js";

let service: NativeWorkflowService | undefined;
let initiatives: InitiativeService | undefined;
installGlobalFetch();
const controllers = new Map<string, AbortController>();
/** Initiatives this worker drives, and the last drive error of each. */
const initiativeDrives = new Set<string>();
const initiativeErrors = new Map<string, string>();
function current(): NativeWorkflowService {
  if (!service) throw new Error("Workflow worker is not initialized");
  return service;
}
function currentInitiatives(): InitiativeService {
  initiatives ??= new InitiativeService(current());
  return initiatives;
}
/** The main thread's intelligence worker, when run steps borrow it. */
let relay: IntelligenceRelayTransport | undefined;
async function close(): Promise<void> {
  for (const controller of controllers.values()) controller.abort(new Error("Workflow shutdown"));
  await service?.shutdown();
  await service?.rootContext.dispose();
  service?.close();
  service = undefined;
  initiatives = undefined;
}
/** Advances an initiative in the background, like `baked workflow initiative drive`. */
function driveInitiative(id: string): void {
  if (initiativeDrives.has(id)) return;
  const key = newId();
  const controller = new AbortController();
  controllers.set(key, controller);
  initiativeDrives.add(id);
  initiativeErrors.delete(id);
  void currentInitiatives()
    .drive(id, controller.signal)
    .catch((err: unknown) => initiativeErrors.set(id, tuiErrorText(err)))
    .finally(() => {
      controllers.delete(key);
      initiativeDrives.delete(id);
    });
}

/**
 * Takes over the runs of workers the terminal UI stopped because their thread stopped (#1541), and
 * drives the resumed ones here, as `baked workflow resume` and `initiative drive` would.
 */
async function takeOverStalled(owners: string[]): Promise<void> {
  for (const owner of owners) {
    for (const run of await takeOverDriver(current(), { pid: process.pid, owner })) {
      if (!run.resumed) continue;
      if (run.initiativeId) {
        driveInitiative(run.initiativeId);
        continue;
      }
      const id = newId();
      const controller = new AbortController();
      controllers.set(id, controller);
      void executeWorkflowCommand(
        current(),
        parseWorkflowArgs(recoveryArgs([], run, 0)),
        controller.signal,
        (runId) => ctx.emit("drive", { id, runId }),
      )
        .catch((err: unknown) =>
          ctx.emit("drive-error", {
            runId: run.runId,
            message: tuiErrorText(err),
          }),
        )
        .finally(() => {
          controllers.delete(id);
          ctx.emit("driven", { runId: run.runId });
        });
    }
  }
}

const StartInput = z
  .object({
    workflowId: SafeId,
    // Empty with an issue: the core names the feature after it.
    featureId: z.union([SafeId, z.literal("")]),
    prompt: z.string(),
    issue: z.string().min(1).max(500).optional(),
    model: z.string().min(1),
    budget: BudgetPreset,
    executionMode: z.enum(["inline", "worktree"]).optional(),
    maxConcurrentWriters: z.number().int().min(1).max(MAX_CONCURRENT_WRITERS).optional(),
    clarification: z.enum(["ask", "assume"]).optional(),
    testIntegrity: z.enum(["block", "warn"]).optional(),
    rowsAsData: z.enum(["off", "on"]).optional(),
    autoPreset: z.boolean().optional(),
    modelStrict: z.boolean().optional(),
    maxCostUsd: z.number().positive().finite().optional(),
  })
  .strict();
const ctx = createWorkerHandler(
  {
    view: (runId, stamp) =>
      readWorkflowViewIfChanged(
        current(),
        SafeId.parse(runId),
        typeof stamp === "string" ? stamp : null,
      ),
    diff: (runId, path) => {
      if (typeof path !== "string") throw new Error("Invalid path");
      return readRunFileDiff(current().store, SafeId.parse(runId), path);
    },
    list: (limit) =>
      readWorkflowSummaries(current(), z.number().int().min(1).max(100).parse(limit)),
    // Every initiative with its features, budget and decisions, for the initiative screen.
    initiatives: (): InitiativeListView => ({
      initiatives: currentInitiatives().list(),
      driving: [...initiativeDrives],
      errors: Object.fromEntries(initiativeErrors),
    }),
    // One initiative command; approve, resume and continue then drive it in the background.
    async initiativeAction(initiativeId, action) {
      const id = InitiativeId.parse(initiativeId);
      const result = await applyInitiativeAction(currentInitiatives(), id, action);
      if (result.drive) driveInitiative(id);
      return result.view;
    },
    // The estimate of an initiative's split, computed only when someone asks for it.
    initiativeEstimate: (initiativeId) =>
      currentInitiatives().estimate(InitiativeId.parse(initiativeId)),
    // Starts an initiative from the TUI form, then splits and drives it in the background.
    async startInitiative(input) {
      const service = currentInitiatives();
      const view = await service.start(
        initiativeStartRequest(InitiativeStartInputSchema.parse(input), service.workflows.config, {
          commandId: newId(),
          ownerLabel: "TUI",
        }),
      );
      driveInitiative(view.initiativeId);
      return view;
    },
    // Past runs with their spend, for the editor's estimate of a definition.
    history: () => readHistory(current().store),
    info: () => {
      const runtime = current();
      const dir = join(runtime.workspace, "baked", "workflows");
      const custom = existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -5))
            .filter((id) => SafeId.safeParse(id).success && id !== "sdd")
        : [];
      const configured = runtime.config.workflows?.policy ?? defaultWorkflowPolicy;
      // The cap a run gets without one of its own, so the form shows the setting's cap too.
      const policy = {
        ...configured,
        maxCostUsd: startCostCap(undefined, configured, runtime.config),
      };
      return {
        estimate: estimateStart(readHistory(runtime.store)),
        enabled: workflowsEnabled(runtime.config),
        defaultWorkflow: runtime.config.workflows?.defaultWorkflow ?? "sdd",
        quickWorkflow: runtime.config.workflows?.quickWorkflow ?? QUICK_WORKFLOW_ID,
        workflows: [...new Set(["sdd", ...PRESETS, ...custom])],
        definitions: definitionSummaries(runtime.workspace, policy),
        policy,
        presets: Object.fromEntries(
          BudgetPreset.options.map((p) => {
            const scaled = scaledPolicy(policy, p);
            return [
              p,
              {
                maxTotalTokens: scaled.maxTotalTokens,
                maxAgentCalls: scaled.maxAgentCalls,
                maxActiveMs: scaled.maxActiveMs,
                checkpointTokens: scaled.checkpointTokens,
              },
            ];
          }),
        ),
      };
    },
    // Starts a run and drives it in the background so the UI never waits for the whole run.
    async start(requestId, input) {
      const id = SafeId.parse(requestId);
      const request = StartInput.parse(input);
      const runtime = current();
      const fromIssue = request.issue
        ? await issueStart(runtime.workspace, runtime.config, {
            reference: request.issue,
            ...(request.prompt ? { prompt: request.prompt } : {}),
            ...(request.featureId ? { featureId: request.featureId } : {}),
          })
        : null;
      const prompt = fromIssue?.prompt ?? request.prompt ?? "";
      // The form showed this proposal; the run records it with the workflow the person kept.
      const choice = request.autoPreset
        ? presetChoice(
            proposeForWorkspace(runtime.workspace, runtime.config, prompt),
            request.workflowId,
          )
        : null;
      const run = await runtime.start({
        commandId: id,
        workflowId: request.workflowId,
        featureId: fromIssue?.featureId ?? SafeId.parse(request.featureId),
        prompt,
        ...(fromIssue ? { issue: fromIssue.issue } : {}),
        ...(choice ? { presetChoice: choice } : {}),
        policy: presetPolicy(runtime.config.workflows?.policy, request.budget),
        ownerLabel: "TUI",
        model: request.model,
        ...(request.executionMode ? { executionMode: request.executionMode } : {}),
        ...(request.maxConcurrentWriters !== undefined
          ? { maxConcurrentWriters: request.maxConcurrentWriters }
          : {}),
        ...(request.clarification ? { clarification: request.clarification } : {}),
        ...(request.testIntegrity ? { testIntegrity: request.testIntegrity } : {}),
        ...(request.rowsAsData ? { rowsAsData: request.rowsAsData } : {}),
        ...(request.modelStrict ? { modelStrict: true } : {}),
        ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
      });
      const controller = new AbortController();
      controllers.set(id, controller);
      ctx.emit("drive", { id, runId: run.runId });
      void runtime
        .drive(run.runId, controller.signal)
        .catch((err: unknown) =>
          ctx.emit("drive-error", {
            runId: run.runId,
            message: tuiErrorText(err),
          }),
        )
        .finally(() => {
          controllers.delete(id);
          ctx.emit("driven", { runId: run.runId });
        });
      return run;
    },
    async command(requestId, argv) {
      const id = SafeId.parse(requestId);
      if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string"))
        throw new Error("Invalid workflow arguments");
      const controller = new AbortController();
      controllers.set(id, controller);
      try {
        return await executeWorkflowCommand(
          current(),
          parseWorkflowArgs(argv),
          controller.signal,
          (runId) => ctx.emit("drive", { id, runId }),
        );
      } finally {
        controllers.delete(id);
      }
    },
    async action(runId, input) {
      const runtime = current();
      const id = SafeId.parse(runId);
      const snapshot = await runtime.get(id);
      const command = { commandId: newId(), expectedRevision: snapshot.revision };
      if (input === "pause") return runtime.pause(id, command);
      if (input === "cancel") return runtime.cancel(id, command);
      if (input === "fork") return runtime.fork(id, command);
      if (typeof input === "object" && input !== null && "fork" in input)
        return runtime.fork(id, command, {
          fromStage: SafeId.parse((input as { fork: unknown }).fork),
        });
      if (input === "discard-worktree") return runtime.discardWorktree(id, command);
      if (typeof input === "object" && input !== null && "reroute" in input) {
        // One user decision: switch the run model, then continue from where the run stopped.
        const model = z
          .string()
          .min(1)
          .parse((input as { reroute: unknown }).reroute);
        const rerouted = await runtime.reroute(id, command, { model });
        if (rerouted.status === "blocked" || rerouted.status === "paused")
          await runtime.resume(id, { commandId: newId(), expectedRevision: rerouted.revision });
      } else if (input === "extend") {
        // One user decision: raise the limits, then continue from the stopped stage.
        await runtime.extendBudget(id, command);
        const paused = await runtime.get(id);
        await runtime.resume(id, { commandId: newId(), expectedRevision: paused.revision });
      } else if (typeof input === "object" && input !== null && "repair" in input)
        await runtime.repair(id, {
          ...command,
          expectedRevision: z
            .number()
            .int()
            .nonnegative()
            .parse((input as { repair: unknown }).repair),
        });
      else if (input === "resume") await runtime.resume(id, command);
      else if (input === "accept-workspace")
        await runtime.resume(id, command, { acceptWorkspace: true });
      else await runtime.decide(id, command, DecisionSchema.parse(input));
      const state = await runtime.get(id);
      if (
        state.pendingRequestIds.length === 0 &&
        !["cancelled", "completed", "failed"].includes(state.status) &&
        (typeof input === "string" ||
          "reroute" in (input as object) ||
          "repair" in (input as object) ||
          DecisionSchema.parse(input).kind !== "reject")
      )
        return runtime.drive(id, new AbortController().signal);
      return state;
    },
    // The files a person changed outside the run, for the "accept changes" confirmation.
    async outsideChanges(runId) {
      return current().outsideChanges(SafeId.parse(runId));
    },
    // Undo never drives: the run stays where it stopped, and the report says what changed.
    async undo(runId) {
      const runtime = current();
      const id = SafeId.parse(runId);
      const latest = () =>
        runtime.store
          .artifacts(id)
          .filter((a) => a.kind === ROLLBACK_ARTIFACT_KIND)
          .at(-1)?.id;
      const before = latest();
      const snapshot = await runtime.undo(id, {
        commandId: newId(),
        expectedRevision: (await runtime.get(id)).revision,
      });
      const after = latest();
      const report =
        after && after !== before
          ? (JSON.parse(runtime.store.readArtifact(id, after)) as RollbackReport)
          : null;
      return { snapshot, report } satisfies UndoResult;
    },
    // Runs one gate outside any run. The worker keeps the UI thread free while it executes.
    async gateRun(requestId, check) {
      const id = SafeId.parse(requestId);
      const runtime = current();
      const parsed = CheckSchema.parse(check);
      assertWorkspaceFreeForGate(
        (["execution", "mutation"] as const).some((resource) => {
          const lease = runtime.store.lease(resource);
          return lease !== null && leaseOwnerAlive(lease) !== false;
        }),
      );
      const controller = new AbortController();
      controllers.set(id, controller);
      try {
        return await executeGate(runtime.workspace, parsed, controller.signal);
      } finally {
        controllers.delete(id);
      }
    },
    // New runs read the gate list from this in-memory policy; started runs froze their own copy.
    gatesUpdate(checks) {
      const parsed = CheckSchema.array().parse(checks);
      const workflows = current().config.workflows;
      if (workflows) workflows.policy = { ...workflows.policy, checks: parsed };
    },
    intelligenceEvent: (event, data) => {
      if (typeof event === "string") relay?.emit(event, data);
    },
    abort: (requestId) => {
      controllers.get(SafeId.parse(requestId))?.abort(new Error("Command aborted"));
    },
    shutdown: close,
  },
  async (config) => {
    if (typeof config.workspace !== "string") throw new Error("Missing workflow workspace");
    setCwd(config.workspace, { changeProcess: false });
    const workspace = config.workspace;
    const appConfig = config.config as AppConfig;
    service = new NativeWorkflowService(
      workspace,
      appConfig,
      undefined,
      false,
      new SharedRootContext(() => rootContext(workspace, appConfig)),
    );
    // The terminal app is where the person is, so a run that starts waiting raises a notification.
    if (service.attention) service.attention.systemNotifications = true;
    // Events are appended inside transactions; notify after the current task so readers see them.
    const changed = new Set<string>();
    service.store.onEvent = (event) => {
      if (changed.has(event.runId)) return;
      changed.add(event.runId);
      setTimeout(() => {
        changed.delete(event.runId);
        ctx.emit("changed", { runId: event.runId });
      }, 15);
    };
    if (Array.isArray(config.exitedOwners))
      for (const owner of config.exitedOwners) recordWorkerExit(service.store, SafeId.parse(owner));
    ctx.emit("owner", service.leases.owner);
    if (Array.isArray(config.stalledOwners) && config.stalledOwners.length)
      // A run the takeover could not resume stays as the run screen shows it, for a person.
      void takeOverStalled(config.stalledOwners.map((owner) => SafeId.parse(owner))).catch(
        () => undefined,
      );
  },
  close,
);

/**
 * Run steps borrow the terminal UI's intelligence worker, so the process keeps one repository map
 * and one set of language servers. Without one for this workspace (another workspace, or a host
 * that serves no relay), the root starts a worker of its own.
 */
async function rootContext(workspace: string, config: AppConfig): Promise<ContextManager> {
  const repoMapEnabled = config.repoMap !== false;
  try {
    const borrowed = await borrowIntelligence(workspace, (request: IntelligenceRelayRequest) =>
      // The borrowing client applies its own timeout to each call.
      ctx.requestCallback(INTELLIGENCE_RELAY_CALLBACK, request, 24 * 60 * 60_000),
    );
    relay = borrowed.transport;
    return await ContextManager.createAsync(workspace, undefined, {
      repoMapEnabled,
      intelligence: borrowed.client,
    });
  } catch {
    relay = undefined;
    return ContextManager.createAsync(workspace, undefined, { repoMapEnabled });
  }
}

/** What the new-run form shows for each workflow; a listing that fails shows nothing. */
function definitionSummaries(
  workspace: string,
  policy: RunPolicy,
): NonNullable<WorkflowInfo["definitions"]> {
  try {
    return Object.fromEntries(
      listDefinitions(workspace, policy).map((d) => [
        d.id,
        {
          stages: d.stages,
          line: d.line,
          description: d.description,
          writes: d.writes,
          problems: d.problems,
          execution: d.execution,
          worktreeRefusal: d.worktreeRefusal,
        },
      ]),
    );
  } catch {
    return {};
  }
}
