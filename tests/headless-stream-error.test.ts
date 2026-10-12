import { describe, expect, test } from "bun:test";
import { EXIT_ERROR, EXIT_OK } from "../src/headless/constants.js";
import { streamTurn } from "../src/headless/run.js";

type Agent = Parameters<typeof streamTurn>[0];

function agentOf(parts: Record<string, unknown>[]): Agent {
  return {
    stream: async () => ({
      stream: (async function* () {
        for (const part of parts) yield part;
      })(),
    }),
  } as unknown as Agent;
}

async function run(parts: Record<string, unknown>[]) {
  const events: Record<string, unknown>[] = [];
  const turn = await streamTurn(agentOf(parts), [], "hi", new AbortController().signal, {
    events: true,
    showProgress: false,
    emit: (event) => events.push(event as unknown as Record<string, unknown>),
  });
  return { turn, events };
}

describe("headless turn", () => {
  test("a provider error part fails the turn with an error event", async () => {
    const providerError = Object.assign(new Error("You have no credits remaining"), {
      statusCode: 429,
    });
    const { turn, events } = await run([
      { type: "start-step" },
      { type: "error", error: providerError },
      { type: "finish-step", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(turn.exitCode).toBe(EXIT_ERROR);
    expect(turn.error).toBe("You have no credits remaining");
    expect(turn.output).toBe("");
    expect(events.at(-1)).toEqual({ type: "error", error: "You have no credits remaining" });
  });

  test("an error part that is not an Error still gives a readable message", async () => {
    const { turn } = await run([{ type: "error", error: { message: "Claude Code lost the BAKED tools" } }]);
    expect(turn.exitCode).toBe(EXIT_ERROR);
    expect(turn.error).toBe("Claude Code lost the BAKED tools");
  });

  test("a turn without an error part succeeds", async () => {
    const { turn, events } = await run([
      { type: "text-delta", text: "hello" },
      { type: "finish-step", usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    expect(turn.exitCode).toBe(EXIT_OK);
    expect(turn.output).toBe("hello");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
