import { describe, expect, test } from "bun:test";
import { addCopilotCacheControl } from "../src/core/llm/providers/copilot.js";

const EPHEMERAL = { type: "ephemeral" };

function marked(body: string): boolean[] {
  const parsed = JSON.parse(addCopilotCacheControl(body)) as {
    messages: Array<{ copilot_cache_control?: unknown }>;
  };
  return parsed.messages.map((m) => m.copilot_cache_control !== undefined);
}

describe("copilot prompt cache markers", () => {
  test("marks system messages and the last message for Claude models", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "system", content: "prompt" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "tool", tool_call_id: "1", content: "ok" },
      ],
    });
    expect(marked(body)).toEqual([true, false, false, true]);
    const last = JSON.parse(addCopilotCacheControl(body)).messages[3];
    expect(last.copilot_cache_control).toEqual(EPHEMERAL);
  });

  test("uses at most two system markers", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.8",
      messages: [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "system", content: "c" },
        { role: "user", content: "hi" },
      ],
    });
    expect(marked(body)).toEqual([true, true, false, true]);
  });

  test("leaves non-Claude models and invalid bodies unchanged", () => {
    const gpt = JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
    expect(addCopilotCacheControl(gpt)).toBe(gpt);
    expect(addCopilotCacheControl("not json")).toBe("not json");
  });
});
