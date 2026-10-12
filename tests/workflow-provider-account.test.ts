import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { accountRefusal, isCapacityError, isTransient, reportsLostTool, retryDelay } from "../src/core/workflows/retry.js";
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

  test("an OAuth refresh collision is transient and waits 30 to 60 seconds, three times", () => {
    const collision = new Error("Another Claude Code process is refreshing the OAuth token, retry in a minute");
    expect(isTransient(collision)).toBe(true);
    expect(accountRefusal(Object.assign(collision, { statusCode: 401 }))).toBeNull();
    for (const retry of [0, 1, 2]) {
      const delay = retryDelay(collision, retry);
      expect(delay).toBeGreaterThanOrEqual(30_000);
      expect(delay).toBeLessThan(60_000);
    }
    expect(retryDelay(collision, 3)).toBeNull();
  });

  test("a blocked implementation that names a missing edit tool is a lost tool", () => {
    const blocked = { outcome: "blocked", summary: "The edit_file tool is not available in this session", unresolved: [] };
    expect(reportsLostTool(blocked)).toBe(true);
    expect(reportsLostTool({ ...blocked, outcome: "implemented" })).toBe(false);
    expect(reportsLostTool({ outcome: "blocked", summary: "Cannot satisfy FR-002 as written", unresolved: ["FR-002 is ambiguous"] })).toBe(false);
  });

  test("a missing read tool or a no such tool message is a lost tool", () => {
    const blocked = (summary: string) => ({ outcome: "blocked", summary, unresolved: [] as string[] });
    expect(reportsLostTool(blocked("Every attempt to call the `read` tool failed with 'No such tool available'"))).toBe(true);
    expect(reportsLostTool(blocked("The grep tool is not available"))).toBe(true);
    expect(reportsLostTool(blocked("Tests fail on the read path"))).toBe(false);
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

  test("hand the step to a fallback model on another provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-account-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const models: string[] = [];
    const executor: AgentExecutor = {
      async execute(request) {
        models.push(request.profile.model);
        throw noCredits;
      },
    };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = {
      ...DEFAULT_CONFIG,
      defaultModel: "fixture/model",
      modelFallback: { "fixture/model": ["fixture/other", "spare/model"] },
      workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy },
    };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    const final = await service.drive(run.runId, new AbortController().signal);
    // fixture/other shares the refused account, so the step goes straight to spare/model.
    expect(models).toEqual(["fixture/model", "spare/model"]);
    expect(final.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("provider_account");
  });
});

describe("a model at capacity", () => {
  const capacity = new Error("Selected model is at capacity. Please try a different model.");

  test("is transient and waits with a growing backoff, four times", () => {
    expect(isCapacityError(capacity)).toBe(true);
    expect(isCapacityError({ statusCode: 400, message: "Bad request", responseBody: '{"error":"model is at capacity"}' })).toBe(true);
    expect(isTransient(capacity)).toBe(true);
    expect(isCapacityError(new Error("Capacity of the cache is 3"))).toBe(false);
    const waits = [0, 1, 2, 3].map((retry) => retryDelay(capacity, retry) ?? 0);
    expect(waits[0]).toBeGreaterThanOrEqual(5_000);
    expect(waits[0]).toBeLessThan(6_000);
    expect(waits[1]).toBeGreaterThanOrEqual(15_000);
    expect(waits[3]).toBeGreaterThanOrEqual(90_000);
    expect(retryDelay(capacity, 4)).toBeNull();
    expect(isTransient(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }))).toBe(true);
  });

  async function drive(models: string[], fallback: string[] | undefined) {
    const root = mkdtempSync(join(tmpdir(), "baked-capacity-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor: AgentExecutor = {
      async execute(request) {
        models.push(request.profile.model);
        throw capacity;
      },
    };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = {
      ...DEFAULT_CONFIG,
      defaultModel: "fixture/model",
      ...(fallback ? { modelFallback: { "fixture/model": fallback } } : {}),
      workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy },
    };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    const controller = new AbortController();
    // The call waits for the capacity backoff; stop the run after the first retry has started.
    const stop = setInterval(() => { if (models.length >= 2) controller.abort(); }, 50);
    try {
      await service.drive(run.runId, controller.signal).catch(() => undefined);
    } finally {
      clearInterval(stop);
    }
  }

  test("is retried on the same model after a wait when the route has no other model", async () => {
    const models: string[] = [];
    await drive(models, undefined);
    expect(models.slice(0, 2)).toEqual(["fixture/model", "fixture/model"]);
  }, 30_000);

  test("goes to the next model of the route at once", async () => {
    const models: string[] = [];
    const started = Date.now();
    await drive(models, ["fixture/other"]);
    expect(models.slice(0, 2)).toEqual(["fixture/model", "fixture/other"]);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 30_000);
});
