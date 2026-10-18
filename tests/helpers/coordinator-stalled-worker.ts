// A real worker with a scripted executor. Its first implementation stops the event loop,
// after its leases have expired, so only the coordinator host can recover the run (#1554).
import type { AppConfig } from "../../src/types/index.js";
import { executeWorkflowCommand } from "../../src/headless/workflow.js";
import { parseWorkflowArgs } from "../../src/headless/workflow-parse.js";
import { initiativeStartRequest, type InitiativeStartInput } from "../../src/core/workflows/initiatives/forms.js";
import { InitiativeService } from "../../src/core/workflows/initiatives/service.js";
import { applyInitiativeAction } from "../../src/core/workflows/initiatives/view-model.js";
import { newId } from "../../src/core/workflows/store.js";
import { createWorkerHandler } from "../../src/core/workers/rpc.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor } from "./workflow-fixture.js";

let service: NativeWorkflowService;
let initiatives: InitiativeService;
let hang = false;
let uncertain = false;
class ScriptedExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    if (hang && ["implementation", "initiativePlan"].includes(request.profile.output)) {
      service.store.emit(request.runId, { type: "tool.started", payload: { attemptId: request.attemptId, tool: "multi_edit" } });
      if (uncertain)
        service.store.prepareEffect(request.runId, request.attemptId, "command", { command: "unknown" }, null, null);
      for (const lease of service.store.leases())
        if (lease.owner_id === service.leases.owner)
          service.store.putLease({ ...lease, expires_at: Date.now() - 1 });
      for (;;) {}
    }
    if (request.profile.output === "initiativePlan") return {
      output: {
        schemaVersion: 1, title: "Three values", goals: ["Values exist"], completionCriteria: ["Every value is ready"],
        features: ["first", "second", "third"].map((id, index, ids) => ({
          id, title: id, boundary: { scope: id, paths: [`${id}.txt`] }, contract: `${id} is ready`,
          dependsOn: index ? [ids[index - 1]] : [], mandatory: true,
        })),
      }, inputTokens: 25, outputTokens: 25,
    };
    return super.execute(request);
  }
}

const ctx = createWorkerHandler({
  async command(id, argv) {
    return executeWorkflowCommand(service, parseWorkflowArgs(argv as string[]), new AbortController().signal,
      (runId) => ctx.emit("drive", { id, runId }));
  },
  async startInitiative(input) {
    const view = await initiatives.start(initiativeStartRequest(input as InitiativeStartInput, service.config, { commandId: newId(), ownerLabel: "Coordinator" }));
    void initiatives.drive(view.initiativeId, new AbortController().signal).catch((error) => ctx.emit("drive-error", String(error)));
    return view;
  },
  async initiativeAction(id, action) {
    const result = await applyInitiativeAction(initiatives, id as string, action);
    if (result.drive) void initiatives.drive(id as string, new AbortController().signal).catch((error) => ctx.emit("drive-error", String(error)));
    return result.view;
  },
  async gatesUpdate() {},
}, (config) => {
  const root = config.workspace as string;
  hang = config.hang === true;
  uncertain = config.uncertain === true;
  service = new NativeWorkflowService(root, config.config as AppConfig, new ScriptedExecutor(root));
  initiatives = new InitiativeService(service);
  ctx.emit("owner", service.leases.owner);
}, async () => {
  await service.shutdown();
  service.close();
});
