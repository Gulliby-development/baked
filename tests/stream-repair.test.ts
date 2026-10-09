import { describe, expect, it } from "bun:test";
import {
  repairToolCall,
  sanitizeMessages,
  sanitizeToolInputsStep,
} from "../src/core/agents/stream-options.js";

function mockToolCall(input: string) {
  return {
    type: "tool-call" as const,
    toolCallId: "test-id",
    toolName: "test-tool",
    input,
  };
}

describe("repairToolCall — truncated output", () => {
  it("closes truncated object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": "test.ts"') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ file: "test.ts" });
  });

  it("closes truncated nested object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": {"b": 1') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).a.b).toBe(1);
  });

  it("closes truncated array in object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"items": [1, 2, 3') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).items).toEqual([1, 2, 3]);
  });

  it("recovers truncation mid-string value", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": "src/core/too') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).file).toBe("src/core/too");
  });

  it("recovers truncation mid-key", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": "test.ts", "con') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).file).toBe("test.ts");
  });

  it("handles deeply nested truncation", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": {"b": {"c": {"d": 1') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).a.b.c.d).toBe(1);
  });

  it("closes deeply nested truncation with arrays", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"items": [{"a": [1, 2') });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.items[0].a).toEqual([1, 2]);
  });

  it("repairs input with unicode values", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"name": "café"') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).name).toBe("café");
  });

  it("repairs input with newlines", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{\n  "a": 1\n') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).a).toBe(1);
  });

  it("repairs trailing comma combined with truncation", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1, "b": [2,') });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.a).toBe(1);
    expect(parsed.b).toEqual([2]);
  });
});

describe("repairToolCall — trailing commas", () => {
  it("fixes trailing comma in object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1,}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ a: 1 });
  });

  it("fixes trailing comma in array", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"items": [1, 2,]}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).items).toEqual([1, 2]);
  });

  it("fixes multiple trailing commas", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": {"b": 1,},}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ a: { b: 1 } });
  });
});

describe("repairToolCall — string edge cases", () => {
  it("returns null for valid JSON with escaped quotes (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"msg": "say \\"hello\\""}') });
    expect(result).toBeNull();
  });

  it("returns null for valid JSON with escaped backslashes (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": "C:\\\\Users\\\\"}') });
    expect(result).toBeNull();
  });

  it("returns null for valid JSON with brackets in strings (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"code": "if (x) { return [1]; }"}') });
    expect(result).toBeNull();
  });

  it("recovers truncation after escaped quote", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"msg": "hello \\"world') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).msg).toBe('hello "world');
  });

  it("handles empty string value", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": ""') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).file).toBe("");
  });

  it("recovers string ending with backslash (truncated escape)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": "C:\\') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toHaveProperty("path");
  });
});

describe("repairToolCall — unquoted string values", () => {
  it("returns null for unquoted path values with slashes (ambiguous)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": src/core/tools}') });
    expect(result).toBeNull();
  });

  it("returns null for unquoted path values with other fields (ambiguous)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": src/core/tools, "depth": 2}') });
    expect(result).toBeNull();
  });

  it("does not touch already-quoted strings", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": "src/core/tools"}') });
    expect(result).toBeNull(); // already valid
  });

  it("does not touch numbers, booleans, null", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1, "b": true, "c": false, "d": null}') });
    expect(result).toBeNull(); // already valid
  });

  it("returns null for multiple unquoted path values (ambiguous)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"from": src/a.ts, "to": src/b.ts}') });
    expect(result).toBeNull();
  });

  it("returns null for unquoted path value with spaces (ambiguous)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": some/path  }') });
    expect(result).toBeNull();
  });

  it("quotes unquoted simple identifiers", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{name: John}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ name: "John" });
  });

  it("handles single quotes", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("{'path': 'src/core/tools'}") });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ path: "src/core/tools" });
  });
});

describe("repairToolCall — invalid / no-op input", () => {
  it("returns null for empty string", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("") });
    expect(result).toBeNull();
  });

  it("returns null for whitespace only", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("   ") });
    expect(result).toBeNull();
  });

  it("returns null for array (not object)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("[1, 2, 3]") });
    expect(result).toBeNull();
  });

  it("returns null for string primitive", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('"hello"') });
    expect(result).toBeNull();
  });

  it("returns null for completely garbled input", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("not json at all") });
    expect(result).toBeNull();
  });

  it("returns null for already-valid JSON (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1}') });
    expect(result).toBeNull();
  });

  it("returns null for valid JSON with leading/trailing whitespace", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('  {"a": 1}  ') });
    expect(result).toBeNull();
  });

  it("100 levels of nested brackets — doesn't hang", async () => {
    const input = "{".repeat(100) + '"a": 1';
    await expect(repairToolCall({ toolCall: mockToolCall(input) })).resolves.toBeDefined();
  });

  it("handles mismatched brackets without hanging", async () => {
    await expect(repairToolCall({ toolCall: mockToolCall('{"a": [1}') })).resolves.toBeDefined();
  });
});

describe("sanitizeMessages", () => {
  it("returns same reference when no tool calls present", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("returns same reference for empty messages array", () => {
    const messages: Parameters<typeof sanitizeMessages>[0] = [];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("leaves valid object tool call inputs unchanged", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: { a: 1 } },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("replaces string tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: "bad" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("replaces array tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: [1, 2] as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("replaces null tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: null as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("replaces number tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: 42 as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("handles mix of valid and invalid tool calls in same message", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "good", input: { file: "a.ts" } },
          { type: "tool-call" as const, toolCallId: "t2", toolName: "bad", input: "oops" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const content = (result[0] as { content: Array<{ toolCallId: string; input: unknown }> }).content;
    expect(content[0].input).toEqual({ file: "a.ts" });
    expect(content[1].input).toEqual({});
  });

  it("non-assistant messages pass through unchanged", () => {
    const messages = [
      { role: "user" as const, content: "do something" },
      { role: "system" as const, content: "you are helpful" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: "bad" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
  });

  it("drops orphan provider-executed tool-call with no matching tool-result", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "running it" },
          {
            type: "tool-call" as const,
            toolCallId: "srvtoolu_01",
            toolName: "bash_code_execution",
            input: { command: "ls" },
            providerExecuted: true,
          },
          // No matching tool-result — stream was cancelled before it arrived.
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("keeps provider-executed tool-call with matching tool-result", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "srvtoolu_02",
            toolName: "bash_code_execution",
            input: { command: "ls" },
            providerExecuted: true,
          },
          {
            type: "tool-result" as const,
            toolCallId: "srvtoolu_02",
            toolName: "bash_code_execution",
            output: { type: "text" as const, value: "ok" },
          },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("drops orphan tool-result with no matching provider-executed tool-call", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "done" },
          {
            type: "tool-result" as const,
            toolCallId: "srvtoolu_99",
            toolName: "bash_code_execution",
            output: { type: "text" as const, value: "stray" },
          },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("drops cross-message orphan tool-result whose toolCallId has no matching tool-call in preceding assistant", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "call_1", toolName: "read", output: { type: "text" as const, value: "ok" } },
          { type: "tool-result" as const, toolCallId: "call_ORPHAN", toolName: "shell", output: { type: "text" as const, value: "stray" } },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    expect(result).toHaveLength(3);
    const toolMsg = result[2] as { content: Array<{ toolCallId: string }> };
    expect(toolMsg.content).toHaveLength(1);
    expect(toolMsg.content[0].toolCallId).toBe("call_1");
  });

  it("removes entire tool message when all tool-results are orphaned", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "Continuing." },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "call_GONE", toolName: "read", output: { type: "text" as const, value: "orphan" } },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Continuing." });
  });

  it("preserves tool message when all tool-results match preceding assistant tool-calls", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "call_A", toolName: "read", input: { path: "x.ts" } },
        ],
      },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "call_A", toolName: "read", output: { type: "text" as const, value: "content" } },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("does not treat provider-executed tool-result in tool message as valid (drops it)", () => {
    // Reproduces the exact bug from diagnostic: code_execution (providerExecuted=true)
    // has its result inline in the assistant message, but a synthetic "Interrupted" result
    // also ends up in the tool message. The reverse pass should drop it.
    const messages = [
      { role: "user" as const, content: "do something" },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Let me check." },
          {
            type: "tool-call" as const,
            toolCallId: "srvtoolu_ABC",
            toolName: "code_execution",
            input: { code: "print(1)" },
            providerExecuted: true,
          },
          {
            type: "tool-result" as const,
            toolCallId: "srvtoolu_ABC",
            toolName: "code_execution",
            output: { type: "error-json" as const, value: { errorCode: "too_many_requests" } },
          },
          {
            type: "tool-call" as const,
            toolCallId: "toolu_123",
            toolName: "shell",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "toolu_123", toolName: "shell", output: { type: "text" as const, value: "hi" } },
          { type: "tool-result" as const, toolCallId: "srvtoolu_ABC", toolName: "code_execution", output: { type: "text" as const, value: "Interrupted — no result recorded." } },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    expect(result).toHaveLength(3);
    const toolMsg = result[2] as { content: Array<{ toolCallId: string }> };
    expect(toolMsg.content).toHaveLength(1);
    expect(toolMsg.content[0].toolCallId).toBe("toolu_123");
  });

  it("non-provider-executed tool-call without result is preserved (client tool — result lives in next user msg)", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "client_1",
            toolName: "read",
            input: { path: "a.ts" },
          },
        ],
      },
    ] as unknown as Parameters<typeof sanitizeMessages>[0];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });
});

describe("sanitizeToolInputsStep", () => {
  it("returns undefined when messages are clean", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: { a: 1 } },
        ],
      },
    ];
    const result = sanitizeToolInputsStep({ messages });
    expect(result).toBeUndefined();
  });

  it("returns { messages } when messages need sanitization", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: "bad" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeToolInputsStep({ messages });
    expect(result).toBeDefined();
    expect(result!.messages).not.toBe(messages);
    const part = (result!.messages[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });
});