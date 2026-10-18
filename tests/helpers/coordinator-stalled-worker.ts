// Run the production workflow worker with a scripted executor. The first worker hangs
// after tool.started; its replacement uses the production takeover and drive paths.
import { mock } from "bun:test";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor } from "./workflow-fixture.js";

let service: NativeWorkflowService;
const hang = process.env.COORDINATOR_TEST_HANG === "1";
const uncertain = process.env.COORDINATOR_TEST_UNCERTAIN === "1";
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

class ScriptedService extends NativeWorkflowService {
  constructor(...args: ConstructorParameters<typeof NativeWorkflowService>) {
    const [root, config, , readOnly, context] = args;
    super(root, config, new ScriptedExecutor(root), readOnly, context);
    service = this;
  }
  override async drive(...args: Parameters<NativeWorkflowService["drive"]>) {
    if (process.env.COORDINATOR_TEST_REJECT_RESUME === "1" && this.store.state(args[0]).stallResumes > 0)
      throw new Error("Recovery drive failed");
    return super.drive(...args);
  }
}
mock.module("../../src/core/workflows/service.js", () => ({ NativeWorkflowService: ScriptedService }));
// Dynamic import yields before the production handler exists; retain the init RPC meanwhile.
const queued: MessageEvent[] = [];
self.onmessage = (event) => { queued.push(event); };
await import("../../src/core/workers/workflow.worker.js");
for (const event of queued) self.onmessage?.(event);
