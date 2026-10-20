import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptedExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    // Ignoring the setting must also remove the row contract from downstream prompts.
    expect(request.prompt).not.toContain('"acceptanceRows":');
    expect(request.prompt).not.toContain("Acceptance rows as data is enabled");
    return super.execute(request);
  }
}

for (const workflowId of ["quick", "quick-fix"]) {
  for (const inherited of [false, true]) {
    test(`scenario: ${workflowId} ignores ${inherited ? "inherited" : "explicit"} rows with a durable warning and completes (#1640)`, async () => {
      const fixture = workflowFixture({
        policy: { ...fixturePolicy, ...(inherited ? { rowsAsData: "on" as const } : {}) },
        executor: (root) => new ScriptedExecutor(root),
      });
      cleanups.push(fixture.dispose);
      const stderr: string[] = [];
      const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      cleanups.push(() => write.mockRestore());
      const args = workflowId === "quick"
        ? ["quick", "Create ready value", "--feature", "fixture"]
        : ["run", "--workflow", workflowId, "--feature", "fixture", "--prompt", "Create ready value"];
      if (!inherited) args.push("--rows-as-data", "on");
      let runId = "";
      await executeWorkflowCommand(fixture.service, parseWorkflowArgs(args), new AbortController().signal, (id) => { runId = id; });
      const warning = `Acceptance rows as data requires an analyze stage; rowsAsData is ignored for workflow ${workflowId}.`;
      expect(stderr.join("")).toContain(`warning: ${warning}`);
      write.mockRestore();
      const { service } = fixture;
      expect((await service.get(runId)).reason).toBe("approval");
      expect(JSON.parse(service.store.run(runId).policy_json).rowsAsData).toBeUndefined();
      // TUI and desktop read this same persisted routing summary.
      expect(readWorkflowView(service, runId).routing?.warnings[0]).toBe(warning);
      await fixture.approve(runId);
      expect((await service.drive(runId, new AbortController().signal)).status).toBe("completed");
      expect(fixture.executor.calls).not.toContain("analysis");
      expect(fixture.executor.calls).toContain("implementation");
      expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
      expect(service.store.latestArtifact(runId, "rows.json")).toBeNull();
      const status = await executeWorkflowCommand(service, parseWorkflowArgs(["status", runId]), new AbortController().signal);
      expect(status).toMatchObject({ routing: { warnings: expect.arrayContaining([warning]) } });
    }, 60000);
  }
}
