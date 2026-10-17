import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { accountRefusal, isCapacityError, isTransient, reportsLostTool, retryDelay, usageLimitReset } from "../src/core/workflows/retry.js";
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

  // ecfit 25614519 T003 (bench round 30, #1286): a Codex worker said the session had no edit tool.
  test("a session that says it has no edit tool is a lost tool", () => {
    expect(reportsLostTool({ outcome: "blocked", summary: "This session has no baked edit_file or multi_edit tool", unresolved: [] })).toBe(true);
    expect(reportsLostTool({ outcome: "blocked", summary: "Cannot edit src/report.go", unresolved: ["The session exposes no permitted baked edit tool; only the disallowed apply_patch tool is available for file edits."] })).toBe(true);
    expect(reportsLostTool({ outcome: "blocked", summary: "The change needs no edit to the config", unresolved: ["FR-003 conflicts with FR-004"] })).toBe(false);
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

  // sketchfold R34 (#1337): a Codex app update moved its CLI, and the run blocked
  // provider_unavailable four times, waiting 1, 3 and 9 minutes for a CLI that was not coming back.
  test("a missing provider CLI blocks the run with provider_account, not as an outage", async () => {
    const missing = new Error("Codex CLI not found (looked in C:\\Old and 26 more). Install Codex or set BAKED_CODEX_PATH, then run `codex login`.");
    expect(accountRefusal(missing)).toBe("cli");
    expect(isTransient(missing)).toBe(false);
    const root = mkdtempSync(join(tmpdir(), "baked-account-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const executor: AgentExecutor = {
      async execute() {
        calls++;
        throw missing;
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
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.map((a) => service.store.readArtifact(run.runId, a.id)).join("\n")).toContain("BAKED_CODEX_PATH");
  });

  // #1395: each supported provider words its usage limit differently; a rate limit must stay transient.
  test("every provider's usage limit is a limit with its reset, and its rate limits stay transient", () => {
    const limits: [string, Record<string, unknown>, string | null][] = [
      ["Codex, a date", { message: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 10:55 AM." }, "Oct 22nd, 2026 10:55 AM"],
      ["Codex, a duration", { message: "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 3 hours." }, "4 days 3 hours"],
      ["Claude Code, epoch", { message: "Claude AI usage limit reached|1760000000" }, "2025-10-09T08:53:20.000Z"],
      ["Claude Code", { message: "You've hit your limit \u00b7 resets 3pm (Europe/Berlin)" }, "3pm (Europe/Berlin)"],
      ["Claude Code, 5 hours", { message: "5-hour limit reached \u2219 resets 3pm" }, "3pm"],
      ["Claude Code, weekly", { message: "Weekly limit reached \u00b7 resets Oct 20, 10am" }, "Oct 20, 10am"],
      ["Anthropic API spend limit", { statusCode: 400, message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC." }, "2026-11-01 at 00:00 UTC"],
      ["Copilot premium requests", { statusCode: 402, message: "quota_exceeded: You have exceeded your premium requests allowance for this month." }, null],
      ["Copilot chat quota", { statusCode: 429, message: "You've reached your monthly chat messages quota. Upgrade to Copilot Pro to continue." }, null],
    ];
    for (const [name, error, reset] of limits) {
      expect([name, accountRefusal(error)]).toEqual([name, "limit"]);
      expect([name, isTransient(error)]).toEqual([name, false]);
      expect([name, usageLimitReset(error)]).toEqual([name, reset]);
    }
    // GitHub Models' daily request limit asks for hours; its reset is that wait from now.
    const daily = { statusCode: 429, message: "Rate limit of 150 per 86400s exceeded for UserByModelByDay. Please wait 33000 seconds before retrying." };
    expect(accountRefusal(daily)).toBe("limit");
    expect(Date.parse(usageLimitReset(daily) ?? "") - Date.now()).toBeGreaterThan(32_000_000);
    expect(accountRefusal({ statusCode: 429, message: "Too many requests", responseHeaders: { "retry-after": "7200" } })).toBe("limit");

    const credits: Record<string, unknown>[] = [
      { statusCode: 400, message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
      { statusCode: 429, message: "You exceeded your current quota, please check your plan and billing details." },
    ];
    for (const error of credits) expect(accountRefusal(error)).toBe("credits");

    const rateLimits: Record<string, unknown>[] = [
      { statusCode: 429, message: "This request would exceed the rate limit for your organization of 50 requests per minute." },
      { statusCode: 429, message: "Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000. Please try again in 20s." },
      { statusCode: 429, message: "rate limit exceeded", responseHeaders: { "retry-after": "30" } },
      { statusCode: 429, message: "Rate limit of 15 per 60s exceeded for UserByModelByMinute. Please wait 42 seconds before retrying." },
      { message: "429 Too Many Requests exceeded retry limit" },
    ];
    for (const error of rateLimits) {
      expect([error.message, accountRefusal(error)]).toEqual([error.message, null]);
      expect([error.message, isTransient(error)]).toEqual([error.message, true]);
    }
  });

  // dieodds R39 (#1395): a Codex usage limit that reset five days later was retried on the 1, 3 and 9
  // minute ladder and reported only as provider_unavailable.
  test("a subscription usage limit blocks the run with provider_account and names its reset", async () => {
    const limit = new Error("You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 10:55 AM.");
    expect(accountRefusal(limit)).toBe("limit");
    expect(isTransient(limit)).toBe(false);
    expect(usageLimitReset(limit)).toBe("Oct 22nd, 2026 10:55 AM");
    const root = mkdtempSync(join(tmpdir(), "baked-account-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const executor: AgentExecutor = {
      async execute() {
        calls++;
        throw limit;
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
    expect(service.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("provider/resume-"))).toBe(false);
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.map((a) => service.store.readArtifact(run.runId, a.id)).join("\n")).toContain("reached its usage limit until Oct 22nd, 2026 10:55 AM");
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

  async function drive(models: string[], fallback: string[] | undefined, calls: number[] = []) {
    const root = mkdtempSync(join(tmpdir(), "baked-capacity-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor: AgentExecutor = {
      async execute(request) {
        models.push(request.profile.model);
        calls.push(Date.now());
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
    const calls: number[] = [];
    await drive(models, ["fixture/other"], calls);
    expect(models.slice(0, 2)).toEqual(["fixture/model", "fixture/other"]);
    // Measured between the two calls, not from the run's start, so a slow runner's setup does not
    // count; the capacity backoff alone would take at least 5 seconds.
    expect((calls[1] ?? Number.POSITIVE_INFINITY) - (calls[0] ?? 0)).toBeLessThan(4_000);
  }, 30_000);
});
