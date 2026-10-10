import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { accountRefusal, isTransient } from "../src/core/workflows/retry.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const noCredits = Object.assign(new Error("You have no credits remaining. Add credits to continue."), { statusCode: 429 });

describe("provider account refusals", () => {
  test("spent credits and a rejected key are not retried", () => {
    expect(accountRefusal(noCredits)).toBe("credits");
    expect(isTransient(noCredits)).toBe(false);
    expect(accountRefusal({ statusCode: 429, message: "Error", responseBody: '{"error":{"code":"insufficient_quota"}}' })).toBe("credits");
    expect(accountRefusal({ statusCode: 401, message: "Incorrect API key provided" })).toBe("key");
    const rateLimit = { statusCode: 429, message: "Rate limit reached for requests" };
    expect(accountRefusal(rateLimit)).toBeNull();
    expect(isTransient(rateLimit)).toBe(true);
  });

  test("block the run with provider_account after one call", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-account-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const executor: AgentExecutor = {
      async execute() {
        calls++;
        throw noCredits;
      },
    };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    const final = await service.drive(run.runId, new AbortController().signal);
    expect(final.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("provider_account");
    expect(calls).toBe(1);
  });
});
