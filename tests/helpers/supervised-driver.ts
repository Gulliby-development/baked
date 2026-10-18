// A workflow driver process for the supervisor scenario (#1533), started by
// tests/workflow-scenario-supervisor.test.ts. It resumes a run of a fixture workspace and drives it.
// SUPERVISED_MODE=hang: the implementation attempt starts a multi_edit whose action never returns
// to the event loop, as the R44 driver did, so no timer of this process runs again.
import type { RunPolicy } from "../../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import { DEFAULT_STALL_SETTINGS } from "../../src/core/workflows/stall.js";
import { newId } from "../../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor } from "./workflow-fixture.js";

const root = process.env.SUPERVISED_ROOT ?? "";
const config = JSON.parse(process.env.SUPERVISED_CONFIG ?? "{}");
const [command, runId, , revision] = JSON.parse(process.env.SUPERVISED_ARGS ?? "[]") as string[];

let service: NativeWorkflowService;
class Driver extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    if (process.env.SUPERVISED_MODE === "hang" && request.profile.output === "implementation") {
      const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
      await new WorkflowToolPolicy(
        service.store,
        service.leases,
        request.runId,
        request.attemptId,
        request.profile,
        policy,
        request.task,
        root,
        DEFAULT_STALL_SETTINGS,
      ).execute("multi_edit", { path: "value.txt" }, async () => {
        for (;;) {}
      });
    }
    return super.execute(request);
  }
}
service = new NativeWorkflowService(root, config, new Driver(root));
if (command !== "resume" || !runId) process.exit(2);
await service.resume(runId, { commandId: newId(), expectedRevision: Number(revision) });
const snapshot = await service.drive(runId, new AbortController().signal);
process.stdout.write(`${JSON.stringify({ runId, status: snapshot.status })}\n`);
await service.shutdown();
service.close();
process.exit(snapshot.status === "completed" ? 0 : 4);
