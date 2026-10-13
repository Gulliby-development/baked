import { describe, expect, test } from "bun:test";
import { resultSummary, streamTurn, warningText } from "../src/headless/run.js";

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

const unsupported = { type: "unsupported", feature: "temperature", details: "Codex CLI ignores this setting" };
const step = (n: number) => [
  { type: "start-step", warnings: [unsupported] },
  { type: "finish-step", usage: { inputTokens: n, outputTokens: 1 } },
];

describe("headless event details", () => {
  test("an MCP tool result shows its text, other objects their JSON", () => {
    expect(resultSummary({ content: [{ type: "text", text: "echo: pong-109" }] })).toBe("echo: pong-109");
    expect(resultSummary({ success: true, output: "ok" })).toBe("ok");
    expect(resultSummary({ rows: 2 })).toBe('{"rows":2}');
    expect(resultSummary("x".repeat(250))).toHaveLength(201);
  });

  test("a warning names what is unsupported", () => {
    expect(warningText(unsupported)).toBe("[unsupported] temperature: Codex CLI ignores this setting");
    expect(warningText({ type: "other", message: "Tool choice ignored" })).toBe("[other] Tool choice ignored");
  });

  test("a warning repeated on every step and turn is reported once", async () => {
    const events: Record<string, unknown>[] = [];
    const seenWarnings = new Set<string>();
    for (let turn = 0; turn < 2; turn++)
      await streamTurn(agentOf([...step(1), ...step(2)]), [], "hi", new AbortController().signal, {
        events: true,
        showProgress: false,
        emit: (event) => events.push(event as unknown as Record<string, unknown>),
        seenWarnings,
      });
    expect(events.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", message: "[unsupported] temperature: Codex CLI ignores this setting" },
    ]);
  });
});
