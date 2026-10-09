import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { executeWorkflowCommand } from "../../headless/workflow.js";
import { parseWorkflowArgs } from "../../headless/workflow-parse.js";
import type { AppConfig } from "../../types/index.js";
import { setCwd } from "../cwd.js";
import { installGlobalFetch } from "../llm/http-agent.js";
import { scaledPolicy } from "../workflows/budget.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { estimateStart, readHistory } from "../workflows/estimate.js";
import { assertWorkspaceFreeForGate, executeGate } from "../workflows/gates.js";
import { leaseOwnerAlive, recordWorkerExit } from "../workflows/leases.js";
import { readRunFileDiff } from "../workflows/run-diff.js";
import { CheckSchema, DecisionSchema, type RunPolicy, SafeId } from "../workflows/schemas.js";
import { NativeWorkflowService } from "../workflows/service.js";
import { newId } from "../workflows/store.js";
import { PRESETS } from "../workflows/v2/definition.js";
import { listDefinitions } from "../workflows/v2/definitions.js";
import type { WorkflowInfo } from "../workflows/view.js";
import {
  BudgetPreset,
  readWorkflowSummaries,
  readWorkflowViewIfChanged,
} from "../workflows/view.js";
import { createWorkerHandler } from "./rpc.js";

let service: NativeWorkflowService | undefined;
installGlobalFetch();
const controllers = new Map<string, AbortController>();
function current(): NativeWorkflowService {
  if (!service) throw new Error("Workflow worker is not initialized");
  return service;
}
async function close(): Promise<void> {
  for (const controller of controllers.values()) controller.abort(new Error("Workflow shutdown"));
  await service?.shutdown();
  service?.close();
  service = undefined;
}

const StartInput = z
  .object({
    workflowId: SafeId,
    featureId: SafeId,
    prompt: z.string().min(1),
    model: z.string().min(1),
    budget: BudgetPreset,
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
      const policy = runtime.config.workflows?.policy ?? defaultWorkflowPolicy;
      return {
        estimate: estimateStart(readHistory(runtime.store)),
        enabled: runtime.config.workflows?.enabled === true,
        defaultWorkflow: runtime.config.workflows?.defaultWorkflow ?? "sdd",
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
      const run = await runtime.start({
        commandId: id,
        workflowId: request.workflowId,
        featureId: request.featureId,
        prompt: request.prompt,
        policy: scaledPolicy(
          runtime.config.workflows?.policy ?? defaultWorkflowPolicy,
          request.budget,
        ),
        ownerLabel: "TUI",
        model: request.model,
      });
      const controller = new AbortController();
      controllers.set(id, controller);
      ctx.emit("drive", { id, runId: run.runId });
      void runtime
        .drive(run.runId, controller.signal)
        .catch((err: unknown) =>
          ctx.emit("drive-error", {
            runId: run.runId,
            message: err instanceof Error ? err.message : String(err),
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
      if (input === "extend") {
        // One user decision: raise the limits, then continue from the stopped stage.
        await runtime.extendBudget(id, command);
        const paused = await runtime.get(id);
        await runtime.resume(id, { commandId: newId(), expectedRevision: paused.revision });
      } else if (input === "resume") await runtime.resume(id, command);
      else await runtime.decide(id, command, DecisionSchema.parse(input));
      const state = await runtime.get(id);
      if (
        state.pendingRequestIds.length === 0 &&
        !["cancelled", "completed", "failed"].includes(state.status) &&
        (typeof input === "string" || DecisionSchema.parse(input).kind !== "reject")
      )
        return runtime.drive(id, new AbortController().signal);
      return state;
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
    abort: (requestId) => {
      controllers.get(SafeId.parse(requestId))?.abort(new Error("Command aborted"));
    },
    shutdown: close,
  },
  async (config) => {
    if (typeof config.workspace !== "string") throw new Error("Missing workflow workspace");
    setCwd(config.workspace, { changeProcess: false });
    service = new NativeWorkflowService(config.workspace, config.config as AppConfig);
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
  },
  close,
);

/** What the new-run form shows for each workflow; a listing that fails shows nothing. */
function definitionSummaries(
  workspace: string,
  policy: RunPolicy,
): NonNullable<WorkflowInfo["definitions"]> {
  try {
    return Object.fromEntries(
      listDefinitions(workspace, policy).map((d) => [
        d.id,
        { stages: d.stages, writes: d.writes, problems: d.problems },
      ]),
    );
  } catch {
    return {};
  }
}
