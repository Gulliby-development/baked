import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, jsonSchema, tool } from "ai";
import { FirstByteHistory } from "../src/core/llm/first-byte-history.js";
import {
  ADAPTIVE_FIRST_BYTE_FLOOR_MS,
  adaptiveFirstByteMs,
  type CallTiming,
  ProviderUnreachableError,
  withProviderHealth,
} from "../src/core/llm/provider-health.js";
import { isStoreError } from "../src/core/workflows/host-error.js";
import { accountRefusal, isRateLimit, isTransient, retryDelay } from "../src/core/workflows/retry.js";
import { isStall } from "../src/core/workflows/stall-ladder.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { awakeClock } from "./helpers/awake-clock.js";
import {
  CORPUS,
  FAULT_PROVIDERS,
  type Fault,
  type FaultProvider,
  faultyModel,
  RECORDED_LIMIT_WAITS_S,
  RECORDED_RETRY_AFTER_S,
  SLOWEST_HEALTHY_FIRST_BYTE_MS,
} from "./helpers/faulty-provider.js";

// #1719: every provider adapter against every fault profile, through the provider-health layer
// every workflow call goes through. Each row asserts the class the runtime gives the failure:
// an answer, an outage (the provider wait), a retry, or a model mistake fed back to the model.
// AGENTS.md: a new provider adapter joins FAULT_PROVIDERS, and a new timer, retry or limit on
// model calls adds the profile that exercises it.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const family = (provider: FaultProvider) => (provider === "copilot" || provider === "github-models" ? "openai" : provider);
const CLI = new Set<FaultProvider>(["codex", "claude-code"]);

/**
 * One call of `shape`: by default a plan-stage call at maximum effort, the call shape of R50's
 * slowest first bytes.
 */
async function start(provider: FaultProvider, fault: Fault, shape: { stage: string; effort: string } = { stage: "plan", effort: "xhigh" }, history?: FirstByteHistory) {
  const clock = awakeClock();
  const faulty = faultyModel(provider, fault);
  cleanups.push(() => { faulty.restore(); clock.restore(); });
  let settled = false;
  // With a history, the call takes the workflow executor's adaptive deadline (#1766).
  const adaptive = history
    ? { firstByteLimit: (ceilingMs: number, c: { stage?: string | undefined; effort?: string | undefined }) => adaptiveFirstByteMs(ceilingMs, history.healthy(`${provider}/model`, c.stage, c.effort)) }
    : {};
  const pending = generateText({
    model: withProviderHealth(faulty.model, `${provider}/model`, { stage: shape.stage, ...adaptive }),
    prompt: "Plan the change",
    maxRetries: 0,
    tools: { read: tool({ description: "Read a file", inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }) }) },
    providerOptions: { [family(provider)]: { reasoningEffort: shape.effort, effort: shape.effort } },
  }).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }))
    .finally(() => { settled = true; });
  await Bun.sleep(5);
  return {
    advance: async (ms: number) => { clock.advance(ms); await Bun.sleep(5); },
    settled: () => settled,
    outcome: async () => ({ ...(await pending), calls: faulty.calls() }),
  };
}

async function call(provider: FaultProvider, fault: Fault, advanceMs: number, shape?: { stage: string; effort: string }) {
  const running = await start(provider, fault, shape);
  await running.advance(advanceMs);
  return running.outcome();
}

describe.each(FAULT_PROVIDERS.map((provider) => [provider]))("provider fault matrix: %s", (provider) => {
  test(`a healthy first byte after ${SLOWEST_HEALTHY_FIRST_BYTE_MS / 1000} s (the corpus's slowest) is an answer, not an outage`, async () => {
    const { result, error } = await call(provider, { kind: "slow", afterMs: SLOWEST_HEALTHY_FIRST_BYTE_MS }, SLOWEST_HEALTHY_FIRST_BYTE_MS + 2_000);
    expect(error).toBeUndefined();
    expect(result?.text).toBe("OK");
  });

  // #1729: every call shape the recorded rounds saw on this provider, at its p99 first byte.
  const shapes = CORPUS.firstByte.filter((shape) => shape.provider === provider && shape.stage && shape.effort);
  if (shapes.length) test.each(shapes.map((shape) => [shape.stage, shape.effort, shape.p99Ms, shape]))(
    "a recorded %s call at %s effort answering after its p99 (%d ms) is an answer",
    async (_stage, _effort, p99Ms, shape) => {
      const { result, error } = await call(provider, { kind: "slow", afterMs: p99Ms }, p99Ms + 2_000, {
        stage: shape.stage ?? "",
        effort: shape.effort ?? "",
      });
      expect(error).toBeUndefined();
      expect(result?.text).toBe("OK");
    },
  );

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
    // A stall, not a refused connection: a workflow stage climbs the recovery ladder (#1877).
    expect(isStall(error)).toBe(true);
  });

  test("a call that never answers after three 50 s answers of its shape is an outage at the adaptive deadline (#1766)", async () => {
    // Silent providers wait twice the shape's p95, at least 3 minutes; Anthropic keeps its minute.
    const deadline = provider === "anthropic" ? 60 : ADAPTIVE_FIRST_BYTE_FLOOR_MS / 1000;
    const history = new FirstByteHistory();
    for (let i = 0; i < 3; i++)
      history.record(`${provider}/model`, { provider, stage: "plan", effort: "xhigh", firstByteMs: 50_000, durationMs: 60_000 });
    const running = await start(provider, { kind: "hang" }, undefined, history);
    await running.advance((deadline - 5) * 1_000);
    expect(running.settled()).toBe(false);
    await running.advance(7_000);
    const { error, calls } = await running.outcome();
    expect(error).toBeInstanceOf(ProviderUnreachableError);
    expect((error as Error).message).toContain(`${deadline} seconds`);
    expect(calls).toBe(1);
    expect(isTransient(error)).toBe(true);
  });

  test(`a 429 with the recorded retry-after (${RECORDED_RETRY_AFTER_S} s) is a rate limit that waits at least as long as asked`, async () => {
    const { error } = await call(provider, { kind: "status", status: 429, retryAfter: String(RECORDED_RETRY_AFTER_S) }, 1_000);
    expect(error).not.toBeInstanceOf(ProviderUnreachableError);
    expect(accountRefusal(error)).toBeNull();
    expect(isRateLimit(error)).toBe(true);
    // The CLIs report the status in their text only, so the rate-limit ladder sets the wait.
    expect(retryDelay(error, 0)).toBeGreaterThanOrEqual(CLI.has(provider) ? 5_000 : RECORDED_RETRY_AFTER_S * 1000);
    expect(retryDelay(error, 3)).toBeNull();
  });

  // A recorded wait over an hour is a usage limit: no retry or other model of the account helps.
  if (RECORDED_LIMIT_WAITS_S.length && !CLI.has(provider))
    test.each(RECORDED_LIMIT_WAITS_S.map((wait) => [wait]))("a 429 asking to wait %d s is a usage limit", async (wait) => {
      const { error } = await call(provider, { kind: "status", status: 429, retryAfter: String(wait) }, 1_000);
      expect(accountRefusal(error)).toBe("limit");
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
    // A cut answer got its first byte: the in-call retries take it, not the recovery ladder.
    expect(isStall(error)).toBe(false);
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

describe("adaptive first-response deadline (#1766)", () => {
  test("is the ceiling until three calls answered, then twice their p95 between 3 minutes and the ceiling", () => {
    const ceiling = 10 * 60_000;
    expect(adaptiveFirstByteMs(ceiling, [])).toBe(ceiling);
    expect(adaptiveFirstByteMs(ceiling, [50_000, 60_000])).toBe(ceiling);
    expect(adaptiveFirstByteMs(ceiling, [50_000, 60_000, 70_000])).toBe(ADAPTIVE_FIRST_BYTE_FLOOR_MS);
    // R52's specify calls: 66 to 166 s.
    expect(adaptiveFirstByteMs(ceiling, [66_000, 115_000, 120_000, 166_000])).toBe(332_000);
    expect(adaptiveFirstByteMs(ceiling, [300_000, 400_000, 502_000])).toBe(ceiling);
    // A 60 s deadline stays as it is.
    expect(adaptiveFirstByteMs(60_000, [1_000, 1_000, 1_000])).toBe(60_000);
  });

  test("history keeps only answered calls, per model, stage and effort", () => {
    const history = new FirstByteHistory();
    const call = { provider: "codex", stage: "spec", effort: "xhigh", durationMs: 1 };
    history.record("codex/a", { ...call, firstByteMs: 10 });
    history.record("codex/a", { ...call, firstByteMs: null });
    history.record("codex/a", { ...call, firstByteMs: 20, status: 429 });
    history.record("codex/b", { ...call, firstByteMs: 30 });
    expect(history.healthy("codex/a", "spec", "xhigh")).toEqual([10]);
    expect(history.healthy("codex/a", "plan", "xhigh")).toEqual([]);
  });
});

describe("fault profiles from the replay corpus (#1729)", () => {
  test("a refused call keeps its status and retry-after for the next round's profile", async () => {
    const clock = awakeClock();
    const faulty = faultyModel("openai", { kind: "status", status: 429, retryAfter: "42" });
    cleanups.push(() => { faulty.restore(); clock.restore(); });
    const timings: CallTiming[] = [];
    const error = await generateText({
      model: withProviderHealth(faulty.model, "openai/model", { stage: "plan", timing: (call) => timings.push(call) }),
      prompt: "Plan the change",
      maxRetries: 0,
    }).then(() => undefined, (thrown: unknown) => thrown);
    expect(isRateLimit(error)).toBe(true);
    expect(timings).toEqual([expect.objectContaining({ provider: "openai.responses", status: 429, retryAfter: "42", firstByteMs: null })]);
  });

  test("the corpus gives every recorded call shape its healthy first-byte percentiles", () => {
    const codex = CORPUS.firstByte.find((shape) => shape.provider === "codex" && shape.stage === "analysis");
    expect(codex?.calls).toBeGreaterThan(100);
    for (const shape of CORPUS.firstByte) {
      expect(shape.p50Ms).toBeLessThanOrEqual(shape.p99Ms);
      expect(shape.p99Ms).toBeLessThanOrEqual(shape.maxMs);
      expect(SLOWEST_HEALTHY_FIRST_BYTE_MS).toBeGreaterThanOrEqual(shape.p99Ms);
    }
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
