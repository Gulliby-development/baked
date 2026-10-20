import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, jsonSchema, tool } from "ai";
import { ProviderUnreachableError, withProviderHealth } from "../src/core/llm/provider-health.js";
import { isStoreError } from "../src/core/workflows/host-error.js";
import { accountRefusal, isRateLimit, isTransient, retryDelay } from "../src/core/workflows/retry.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FAULT_PROVIDERS, type Fault, type FaultProvider, faultyModel, R50_P99_FIRST_BYTE_MS } from "./helpers/faulty-provider.js";

// #1719: every provider adapter against every fault profile, through the provider-health layer
// every workflow call goes through. Each row asserts the class the runtime gives the failure:
// an answer, an outage (the provider wait), a retry, or a model mistake fed back to the model.
// AGENTS.md: a new provider adapter joins FAULT_PROVIDERS, and a new timer, retry or limit on
// model calls adds the profile that exercises it.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const family = (provider: FaultProvider) => (provider === "copilot" || provider === "github-models" ? "openai" : provider);
const CLI = new Set<FaultProvider>(["codex", "claude-code"]);

/** One plan-stage call at maximum effort, the call shape of R50's slowest first bytes. */
async function start(provider: FaultProvider, fault: Fault) {
  const clock = awakeClock();
  const faulty = faultyModel(provider, fault);
  cleanups.push(() => { faulty.restore(); clock.restore(); });
  let settled = false;
  const pending = generateText({
    model: withProviderHealth(faulty.model, `${provider}/model`, { stage: "plan" }),
    prompt: "Plan the change",
    maxRetries: 0,
    tools: { read: tool({ description: "Read a file", inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }) }) },
    providerOptions: { [family(provider)]: { reasoningEffort: "xhigh", effort: "xhigh" } },
  }).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }))
    .finally(() => { settled = true; });
  await Bun.sleep(5);
  return {
    advance: async (ms: number) => { clock.advance(ms); await Bun.sleep(5); },
    settled: () => settled,
    outcome: async () => ({ ...(await pending), calls: faulty.calls() }),
  };
}

async function call(provider: FaultProvider, fault: Fault, advanceMs: number) {
  const running = await start(provider, fault);
  await running.advance(advanceMs);
  return running.outcome();
}

describe.each(FAULT_PROVIDERS.map((provider) => [provider]))("provider fault matrix: %s", (provider) => {
  test(`a healthy first byte after ${R50_P99_FIRST_BYTE_MS / 1000} s (R50 p99) is an answer, not an outage`, async () => {
    const { result, error } = await call(provider, { kind: "slow", afterMs: R50_P99_FIRST_BYTE_MS }, R50_P99_FIRST_BYTE_MS + 2_000);
    expect(error).toBeUndefined();
    expect(result?.text).toBe("OK");
  });

  test("a call that never answers is an outage at the stage's deadline, then the provider wait", async () => {
    // Anthropic streams its thinking, so a silent minute is an outage; the rest may think silently.
    const deadline = provider === "anthropic" ? 60 : 600;
    const running = await start(provider, { kind: "hang" });
    await running.advance((deadline - 5) * 1_000);
    expect(running.settled()).toBe(false);
    await running.advance(7_000);
    const { error, calls } = await running.outcome();
    expect(error).toBeInstanceOf(ProviderUnreachableError);
    expect((error as Error).message).toContain(`${deadline} seconds`);
    expect(calls).toBe(1);
    expect(isTransient(error)).toBe(true);
  });

  test("a 429 with retry-after is a rate limit that waits at least as long as asked", async () => {
    const { error } = await call(provider, { kind: "status", status: 429, retryAfter: "7" }, 1_000);
    expect(error).not.toBeInstanceOf(ProviderUnreachableError);
    expect(accountRefusal(error)).toBeNull();
    expect(isRateLimit(error)).toBe(true);
    // The CLIs report the status in their text only, so the rate-limit ladder sets the wait.
    expect(retryDelay(error, 0)).toBeGreaterThanOrEqual(CLI.has(provider) ? 5_000 : 7_000);
    expect(retryDelay(error, 3)).toBeNull();
  });

  test.each([503, 529] as const)("a %d overload is retried with backoff", async (status) => {
    const { error } = await call(provider, { kind: "status", status }, 1_000);
    expect(isRateLimit(error)).toBe(false);
    expect(isTransient(error)).toBe(true);
    expect(retryDelay(error, 0)).toBeGreaterThan(0);
  });

  test("a stream cut after the answer started is retried (#1719)", async () => {
    const { result, error } = await call(provider, { kind: "cut" }, 2_000);
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(isTransient(error)).toBe(true);
    expect(retryDelay(error, 0)).not.toBeNull();
  });

  test("a tool call with arguments that are not JSON returns to the model as a tool error", async () => {
    const { result, error } = await call(provider, { kind: "malformed-tool" }, 1_000);
    expect(error).toBeUndefined();
    expect(result?.content.some((part) => part.type === "tool-error")).toBe(true);
    expect(result?.toolResults).toEqual([]);
  });

  test("an empty answer is the model's, not an outage", async () => {
    const { result, error } = await call(provider, { kind: "empty" }, 1_000);
    expect(error).toBeUndefined();
    expect(result?.text).toBe("");
    expect(result?.finishReason).toBe("stop");
  });
});

describe("provider fault matrix: SQLITE_BUSY on store reads", () => {
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "baked-fault-store-"));
    const opened = new WorkflowStore(root);
    cleanups.push(() => { opened.close(); rmSync(root, { recursive: true, force: true }); });
    return opened;
  };

  test("a writer holding the database does not block run reads (WAL)", () => {
    const opened = store();
    const writer = new Database(opened.path);
    cleanups.push(() => writer.close());
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    expect(opened.artifacts("none")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
    writer.exec("ROLLBACK");
  });

  test("a busy read is a host fault: never a provider retry, an outage or the model's output", () => {
    const opened = store();
    const busy = Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY" });
    const reads = spyOn(opened, "artifacts").mockImplementation(() => { throw busy; });
    cleanups.push(() => reads.mockRestore());
    let error: unknown;
    try { opened.artifacts("run"); } catch (thrown) { error = thrown; }
    expect(isStoreError(error)).toBe(true);
    expect(isTransient(error)).toBe(false);
    expect(retryDelay(error, 0)).toBeNull();
    expect(accountRefusal(error)).toBeNull();
  });
});
