import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import {
  type ClaudeCodeProcess,
  type ClaudeCodeProcessFactory,
  ClaudeCodeNativeToolError,
  ClaudeCodeSessionRunner,
  createClaudeCodeLanguageModel,
  nativeToolInEvent,
} from "../src/core/llm/providers/claude-code.js";

const OPTIONS: LanguageModelV3CallOptions = {
  prompt: [
    { role: "system", content: "You are baked." },
    { role: "user", content: [{ type: "text", text: "Read package.json" }] },
  ],
  tools: [
    {
      type: "function",
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};

const usage = (output: number) => ({
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 1000,
  output_tokens: output,
});

const nativeToolUse = (name: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "tu1", name, input: { path: "package.json" } }] },
});
const noSuchTool = (name: string) => ({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu1",
        is_error: true,
        content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`,
      },
    ],
  },
});
const interruptedResult = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  usage: usage(700),
};
const answer = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  structured_output: {
    finishReason: "tool-calls",
    text: "",
    toolCalls: [{ toolName: "read", inputJson: '{"path":"package.json"}' }],
  },
  usage: usage(40),
};

type Script = Array<Record<string, unknown>>;

/** A `claude -p` stand-in: each user message plays the next script, an interrupt plays its own. */
function scriptedFactory(turns: Script[], onInterrupt: Script) {
  const spawned: Array<ClaudeCodeProcess & { sent: string[]; killed: boolean }> = [];
  const factory: ClaudeCodeProcessFactory = () => {
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(error: Error) => void> = [];
    const emit = (events: Script) =>
      queueMicrotask(() => {
        for (const event of events) for (const l of lineListeners) l(JSON.stringify(event));
      });
    const proc = {
      sent: [] as string[],
      killed: false,
      send(line: string) {
        proc.sent.push(line);
        const message = JSON.parse(line) as { type: string };
        if (message.type === "control_request") emit(onInterrupt);
        else emit(turns.shift() ?? []);
      },
      onLine(listener: (line: string) => void) {
        lineListeners.push(listener);
      },
      onExit(listener: (error: Error) => void) {
        exitListeners.push(listener);
      },
      kill() {
        proc.killed = true;
        for (const listener of exitListeners) listener(new Error("killed"));
      },
    };
    spawned.push(proc);
    return proc;
  };
  return { factory, spawned };
}

const types = (sent: string[]) => sent.map((line) => (JSON.parse(line) as { type: string }).type);

describe("claude-code native tool calls", () => {
  test("detects native tool_use blocks and No such tool results, not the structured output tool", () => {
    expect(nativeToolInEvent(nativeToolUse("read"))).toBe("read");
    expect(nativeToolInEvent(noSuchTool("read"))).toBe("read");
    expect(nativeToolInEvent(nativeToolUse("StructuredOutput"))).toBeNull();
    expect(nativeToolInEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBeNull();
  });

  test("interrupts the turn, re-sends a corrective line in the same session and sums the usage", async () => {
    const { factory, spawned } = scriptedFactory(
      [[nativeToolUse("read"), noSuchTool("read")], [answer]],
      [interruptedResult],
    );
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);

    const result = await model.doGenerate(OPTIONS);

    expect(result.finishReason.unified).toBe("tool-calls");
    expect(result.content[0]).toMatchObject({ type: "tool-call", toolName: "read" });
    expect(spawned).toHaveLength(1);
    expect(types(spawned[0]?.sent ?? [])).toEqual(["user", "control_request", "user"]);
    const correction = (JSON.parse(spawned[0]?.sent[2] ?? "{}") as { message: { content: string } }).message.content;
    expect(correction).toContain("BAKED tools are not native tools");
    expect(correction).toContain('"read"');
    // 700 tokens of the aborted attempt are charged to the answer.
    expect(result.usage.outputTokens.total).toBe(740);
    expect(result.providerMetadata).toEqual({ "claude-code": { nativeToolAborts: ["read"] } });
    expect(runner.sessionCount).toBe(1);
  });

  test("a turn that never calls a native tool is untouched", async () => {
    const { factory, spawned } = scriptedFactory([[answer]], [interruptedResult]);
    const model = createClaudeCodeLanguageModel("sonnet", new ClaudeCodeSessionRunner(factory));
    const result = await model.doGenerate(OPTIONS);
    expect(types(spawned[0]?.sent ?? [])).toEqual(["user"]);
    expect(result.providerMetadata).toBeUndefined();
  });

  test("retries the step in a fresh session when the correction fails", async () => {
    const { factory, spawned } = scriptedFactory(
      [[nativeToolUse("read")], [nativeToolUse("read"), noSuchTool("read")], [answer]],
      [interruptedResult],
    );
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);

    const result = await model.doGenerate(OPTIONS);
    expect(result.finishReason.unified).toBe("tool-calls");
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.killed).toBe(true);
    // The fresh session gets the whole transcript.
    expect(spawned[1]?.sent[0]).toContain("CONVERSATION TRANSCRIPT\\n");
    expect(result.providerMetadata?.["claude-code"]?.nativeToolAborts).toEqual(["read", "read"]);
    // Two interrupted results (700 each) and the answer (40).
    expect(result.usage.outputTokens.total).toBe(1440);
    runner.close();
  });

  test("gives up when the fresh session loses the tools too and drops both sessions", async () => {
    const { factory, spawned } = scriptedFactory(
      [
        [nativeToolUse("read")],
        [nativeToolUse("read"), noSuchTool("read")],
        [nativeToolUse("glob")],
        [nativeToolUse("glob"), noSuchTool("glob")],
      ],
      [interruptedResult],
    );
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);

    const error = await model.doGenerate(OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeNativeToolError);
    expect((error as ClaudeCodeNativeToolError).nativeTools).toEqual(["read", "read", "glob", "glob"]);
    expect((error as ClaudeCodeNativeToolError).usage.outputTokens.total).toBe(2800);
    expect(spawned).toHaveLength(2);
    expect(spawned.every((proc) => proc.killed)).toBe(true);
    expect(runner.sessionCount).toBe(0);
  });
});
