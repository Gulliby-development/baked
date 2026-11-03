import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { buildFullConvoText } from "../src/core/compaction/convo-text.js";
import { v1CompactionPrompt } from "../src/core/compaction/manual.js";

// AI SDK tool results carry their content in `output` (text, json, error-text, content parts).
const conversation = (output: unknown): ModelMessage[] =>
  [
    { role: "user", content: "fix the failing test" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "t1", toolName: "shell", input: { command: "bun test" } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "t1", toolName: "shell", output }],
    },
  ] as ModelMessage[];

const outputs: [string, unknown][] = [
  ["text", { type: "text", value: "MARKER_TEXT expected 3 received 4" }],
  ["json", { type: "json", value: { stdout: "MARKER_JSON" } }],
  ["error-text", { type: "error-text", value: "MARKER_ERROR ENOENT" }],
  ["content", { type: "content", value: [{ type: "text", text: "MARKER_CONTENT" }] }],
];

describe("compaction summary input carries tool-result output", () => {
  for (const [kind, output] of outputs) {
    const marker = `MARKER_${kind === "error-text" ? "ERROR" : kind.toUpperCase()}`;

    test(`v1 prompt includes a ${kind} tool result`, () => {
      const prompt = v1CompactionPrompt(conversation(output));
      expect(prompt).toContain(marker);
      expect(prompt).not.toContain("→ null]");
    });

    test(`v2 gap-fill conversation text includes a ${kind} tool result`, () => {
      const text = buildFullConvoText(conversation(output), 12000);
      expect(text).toContain(marker);
      expect(text).not.toContain("→ null]");
    });
  }
});
