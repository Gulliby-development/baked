import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { assembleCompacted, splitForCompaction } from "../src/core/compaction/manual.js";

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({ role: "assistant", content });
const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
});
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: id } },
  ],
});

/** Messages the compaction neither summarized (older) nor kept verbatim. */
function lost(core: ModelMessage[], keepRecent: number): ModelMessage[] {
  const { older, recent } = splitForCompaction(core, keepRecent);
  const assembled = assembleCompacted("SUMMARY", recent);
  return core.filter((m) => !older.includes(m) && !assembled.includes(m));
}

describe("compaction split of a multi-step agent turn", () => {
  const core = [
    user("task"),
    toolCall("1"),
    toolResult("1"),
    toolCall("2"),
    toolResult("2"),
    toolCall("3"),
    toolResult("3"),
    assistant("done"),
  ];

  test("every message is either summarized or kept verbatim", () => {
    for (let keep = 1; keep <= core.length; keep++) expect(lost(core, keep)).toEqual([]);
  });

  test("the summarized part never ends with a tool call whose result is kept", () => {
    for (let keep = 1; keep <= core.length; keep++) {
      const { recent } = splitForCompaction(core, keep);
      expect(recent[0]?.role).not.toBe("tool");
    }
  });

  test("the compacted conversation alternates and pairs every tool result with its call", () => {
    for (let keep = 1; keep <= core.length; keep++) {
      const { recent } = splitForCompaction(core, keep);
      const out = assembleCompacted("SUMMARY", recent);
      expect(out[0]).toEqual({ role: "user", content: "SUMMARY" });
      for (let i = 1; i < out.length; i++) {
        expect(out[i]?.role === "assistant" && out[i - 1]?.role === "assistant").toBe(false);
        if (out[i]?.role === "tool") expect(out[i - 1]?.role).toBe("assistant");
      }
    }
  });
});
