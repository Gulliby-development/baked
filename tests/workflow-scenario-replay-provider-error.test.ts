import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText } from "ai";
import { type CallTiming, withProviderHealth } from "../src/core/llm/provider-health.js";
import { canonical } from "../src/core/specs/hash.js";
import { openTrace, replayStallLadder } from "../src/core/workflows/trace.js";

// R89 namesound-update (#2820). Research attempt 85cd6609 ended at once with "Selected model is at
// capacity". Its last call lasted 441 ms with no first byte and no status, the run took no recovery
// rung (a provider error is retried, not climbed), and the replay read the call as a stall and
// climbed to fresh-session: the corpus test failed with newRecoveries 1.

const TRACE = join(import.meta.dir, "fixtures", "bench-traces", "R89", "namesound-update.sqlite.gz");
const RUN = "3e63ee34-7434-4337-93bd-4d0fe0b9929f";
const AT_CAPACITY = "85cd6609-f0f0-48f2-8665-6980138255fa";

function streaming(action: (controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>) => void): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("must observe the provider stream");
    },
    doStream: async () => ({ stream: new ReadableStream({ start: action }) }),
  };
}

async function timingOf(model: LanguageModelV4, firstByteMs?: number): Promise<CallTiming | undefined> {
  const calls: CallTiming[] = [];
  await generateText({
    model: withProviderHealth(model, "fixture/model", { ...(firstByteMs ? { firstByteMs } : {}), timing: (call) => calls.push(call) }),
    prompt: "Hi",
    maxRetries: 0,
  }).catch(() => undefined);
  return calls[0];
}

describe("scenario: R89 namesound-update, a provider error with no first byte is no stall (#2820)", () => {
  test("a call that ends in a provider error records failure: error; an unanswered one, failure: stall", async () => {
    const capacity = await timingOf(
      streaming((controller) => {
        controller.enqueue({ type: "error", error: new Error("Selected model is at capacity. Please try a different model.") });
        controller.close();
      }),
    );
    expect(capacity).toMatchObject({ firstByteMs: null, failure: "error" });
    expect(capacity?.status).toBeUndefined();
    // A stream that ends with no part and no finish is a stall, as the ladder climbs on it.
    const unfinished = await timingOf(streaming((controller) => controller.close()));
    expect(unfinished).toMatchObject({ firstByteMs: null, failure: "stall" });
    // A first-response deadline that runs out is a stall too.
    const silent = await timingOf(streaming(() => {}), 50);
    expect(silent).toMatchObject({ firstByteMs: null, failure: "stall" });
    // A call that completes records no failure.
    const done = await timingOf(
      streaming((controller) => {
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
        controller.close();
      }),
    );
    expect(done?.failure).toBeUndefined();
  });

  test("the replay climbs no rung for the at-capacity call once its timing says error, as the run did", () => {
    const { store, dispose } = openTrace(TRACE);
    try {
      const path = `attempts/${AT_CAPACITY}/usage.json`;
      const usage = JSON.parse(store.readArtifact(RUN, store.latestArtifact(RUN, path)!.id)) as { calls: CallTiming[] };
      const last = usage.calls.at(-1)!;
      expect(last).toMatchObject({ firstByteMs: null, durationMs: 441 });
      expect(last.status).toBeUndefined();
      // Recorded before the failure kind: read by its timing alone, which the corpus accepts.
      const before = replayStallLadder(store, RUN).find((b) => b.attemptId === AT_CAPACITY);
      expect(before).toMatchObject({ recorded: "none", replayed: "fresh-session" });
      // The same call as the provider timing records it now.
      store.transaction(() =>
        store.artifact(RUN, "usage", path, canonical({ ...usage, calls: [...usage.calls.slice(0, -1), { ...last, failure: "error" }] })),
      );
      const after = replayStallLadder(store, RUN).find((b) => b.attemptId === AT_CAPACITY);
      expect(after).toBeUndefined();
    } finally {
      dispose();
    }
  }, 60_000);
});
