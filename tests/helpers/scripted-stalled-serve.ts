// A real workflow API child for #1541. Only its first process hangs inside a guarded tool call.
import { startApiServer } from "../../src/core/api/server.js";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../../src/core/workflows/schemas.js";
import { ScriptedWorkflowExecutor } from "../../src/core/workflows/scripted-executor.js";
import { NativeWorkflowService } from "../../src/core/workflows/service.js";
import { stallSettings } from "../../src/core/workflows/stall.js";
import { WorkflowToolPolicy } from "../../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { parseServeArgs } from "../../src/headless/serve.js";
import type { AppConfig } from "../../src/types/index.js";

const args = parseServeArgs(process.argv.slice(3));
if (args === "help") throw new Error("Expected serve arguments");
const root = process.cwd();
const config = JSON.parse(process.env.SUPERVISED_CONFIG ?? "{}") as AppConfig;
let service: NativeWorkflowService;
class StalledExecutor extends ScriptedWorkflowExecutor {
  override async execute(request: ExecutionRequest) {
    if (args !== "help" && args.takeOver === undefined && request.profile.output === "implementation") {
      const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
      await new WorkflowToolPolicy(
        service.store, service.leases, request.runId, request.attemptId,
        request.profile, policy, request.task, root, stallSettings(config),
      ).execute("multi_edit", { path: "value.txt" }, async () => {
        const marker = join(root, ".baked", "scripted-stalled.json");
        writeFileSync(`${marker}.tmp`, JSON.stringify({ runId: request.runId, pid: process.pid }));
        renameSync(`${marker}.tmp`, marker);
        for (;;) {}
      });
    }
    return super.execute(request);
  }
}
service = new NativeWorkflowService(root, config, new StalledExecutor(root, "value.txt"));
const server = await startApiServer({
  service,
  ownsService: true,
  tokenFile: args.tokenFile,
  ...(args.takeOver === undefined ? {} : { takeOver: { pid: args.takeOver } }),
});
console.log(JSON.stringify({ url: server.url, tokenFile: server.tokenFile }));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void server.stop().then(() => process.exit(0)));
