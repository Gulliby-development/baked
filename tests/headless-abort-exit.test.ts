import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { ToolLoopAgent } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { EXIT_ABORT, EXIT_OK } from "../src/headless/constants.js";
import { streamTurn } from "../src/headless/run.js";

type Agent = Parameters<typeof streamTurn>[0];

/**
 * Streams one turn through a real AI SDK agent, so an abort reaches streamTurn the way Ctrl+C and
 * --timeout do in `baked --headless`: as an `abort` part and a normal end of the stream.
 */
async function turnOf(doStream: (ac: AbortController, opts: LanguageModelV3CallOptions) => unknown) {
  const ac = new AbortController();
  const model = new MockLanguageModelV3({
    doStream: ((opts: LanguageModelV3CallOptions) => doStream(ac, opts)) as never,
  });
  const agent = new ToolLoopAgent({ model }) as unknown as Agent;
  const events: Record<string, unknown>[] = [];
  const turn = await streamTurn(agent, [{ role: "user", content: "hi" }], "hi", ac.signal, {
    events: true,
    showProgress: false,
    emit: (event) => events.push(event as unknown as Record<string, unknown>),
  });
  return { turn, events };
}

describe("an aborted headless turn", () => {
  test("an abort in the middle of the answer fails the turn as aborted", async () => {
    const { turn, events } = await turnOf(async (ac) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: "partial" });
          setTimeout(() => ac.abort(), 10);
        },
      }),
    }));
    expect(turn.output).toBe("partial");
    expect(turn.exitCode).toBe(EXIT_ABORT);
    expect(turn.error).toBe("Aborted");
    expect(events.at(-1)).toEqual({ type: "error", error: "Aborted" });
  });

  test("an abort before the model answers fails the turn as aborted", async () => {
    const { turn, events } = await turnOf(async (ac, opts) => {
      setTimeout(() => ac.abort(), 5);
      await new Promise((_, reject) =>
        opts.abortSignal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
        ),
      );
    });
    expect(turn.exitCode).toBe(EXIT_ABORT);
    expect(turn.error).toBe("Aborted");
    expect(events.at(-1)).toEqual({ type: "error", error: "Aborted" });
  });

  test("a turn that ends on its own still succeeds", async () => {
    const { turn, events } = await turnOf(async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: "done" });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }));
    expect(turn.exitCode).toBe(EXIT_OK);
    expect(turn.output).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
