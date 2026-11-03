import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import type { ContextManager } from "../src/core/context/manager.js";
import { reprimeContextFromMessages } from "../src/hooks/chat/message-processing.js";

function recorder() {
  const tracked: string[] = [];
  const cm = { trackMentionedFile: (f: string) => tracked.push(f) } as unknown as ContextManager;
  return { cm, tracked };
}

describe("reprimeContextFromMessages", () => {
  it("re-tracks file paths from AI SDK tool-call `input`", () => {
    const { cm, tracked } = recorder();
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "src/a.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "multi_read",
            input: { files: ["src/b.ts", "src/c.ts"] },
          },
        ],
      },
    ];
    reprimeContextFromMessages(cm, msgs);
    expect(tracked).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("still reads `args` from sessions saved before AI SDK v5", () => {
    const { cm, tracked } = recorder();
    const legacy = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "edit_file",
          args: { file_path: "src/old.ts" },
        },
      ],
    } as unknown as ModelMessage;
    reprimeContextFromMessages(cm, [legacy]);
    expect(tracked).toEqual(["src/old.ts"]);
  });

  it("ignores tool-call input that is not an object", () => {
    const { cm, tracked } = recorder();
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "x", input: "src/a.ts" }],
      },
    ] as unknown as ModelMessage[];
    reprimeContextFromMessages(cm, msgs);
    expect(tracked).toEqual([]);
  });
});
