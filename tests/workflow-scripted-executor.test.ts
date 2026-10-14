import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { scriptedExecutorFromEnv } from "../src/core/workflows/scripted-executor.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  checks: [{ id: "output", executable: "bun", args: ["-e", "if (await Bun.file('e2e-output.txt').text() !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }],
};

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

describe("scripted workflow executor (BAKED_TEST_WORKFLOW)", () => {
  test("is off unless the environment variable is set", () => {
    expect(scriptedExecutorFromEnv("/tmp", {})).toBeUndefined();
    expect(scriptedExecutorFromEnv("/tmp", { BAKED_TEST_WORKFLOW: "1" })).toBeDefined();
  });

  for (const workflowId of ["sdd", "quick"]) {
    test(`completes a ${workflowId} run after its approval and writes the output file`, async () => {
      const root = mkdtempSync(join(tmpdir(), "baked-scripted-workflow-"));
      roots.push(root);
      execSync("git init -q && git -c user.email=t@baked.dev -c user.name=t commit -q --allow-empty -m init", { cwd: root });
      const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: workflowId, policy } };
      const service = new NativeWorkflowService(root, config, scriptedExecutorFromEnv(root, { BAKED_TEST_WORKFLOW: "1" }));
      try {
        const run = await service.start({ commandId: newId(), featureId: "scripted", workflowId, prompt: "Write the output", ownerLabel: "test", policy });
        const signal = new AbortController().signal;
        const waiting = await service.drive(run.runId, signal);
        expect(waiting.reason).toBe("approval");
        const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
        if (!request) throw new Error("No pending approval");
        await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
        expect((await service.drive(run.runId, signal)).status).toBe("completed");
        expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");
      } finally {
        await service.shutdown();
        service.close();
      }
    });
  }
});
