import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import {
  buildClaudeCodePromptParts,
  type ClaudeCodeProcess,
  type ClaudeCodeProcessFactory,
  ClaudeCodeSessionRunner,
  claudeCode,
  createClaudeCodeLanguageModel,
  parseClaudeCodeAuthStatus,
  parseClaudeCodeFlags,
  parseClaudeCodeResponse,
  renderClaudeCodeTurn,
  usageFromResult,
} from "../src/core/llm/providers/claude-code.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { detectModelFamily } from "../src/core/llm/provider-options.js";

const TOOLS: LanguageModelV3CallOptions["tools"] = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const FIRST: LanguageModelV3CallOptions = {
  prompt: [
    { role: "system", content: "You are baked." },
    { role: "user", content: [{ type: "text", text: "Read package.json" }] },
  ],
  tools: TOOLS,
};

const SECOND: LanguageModelV3CallOptions = {
  prompt: [
    ...FIRST.prompt,
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "package.json" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "read_file",
          output: { type: "text", value: '{"name":"demo"}' },
        },
      ],
    },
  ],
  tools: TOOLS,
};

interface FakeProcess extends ClaudeCodeProcess {
  sent: string[];
  killed: boolean;
}

/** A stand-in for `claude -p` that answers each turn with the next scripted result event. */
function fakeFactory(results: Array<Record<string, unknown>>) {
  const spawned: FakeProcess[] = [];
  const factory: ClaudeCodeProcessFactory = () => {
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(error: Error) => void> = [];
    const proc: FakeProcess = {
      sent: [],
      killed: false,
      send(line) {
        proc.sent.push(line);
        const next = results.shift();
        queueMicrotask(() => {
          for (const listener of lineListeners) {
            listener(JSON.stringify({ type: "assistant", message: { content: [] } }));
            if (next) listener(JSON.stringify({ type: "result", ...next }));
          }
        });
      },
      onLine(listener) {
        lineListeners.push(listener);
      },
      onExit(listener) {
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

const toolCallResult = {
  subtype: "success",
  result: "",
  structured_output: {
    finishReason: "tool-calls",
    text: "",
    toolCalls: [{ toolName: "read_file", inputJson: '{"path":"package.json"}' }],
  },
  usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, output_tokens: 30 },
};
const stopResult = {
  subtype: "success",
  result: "",
  structured_output: { finishReason: "stop", text: "The package is demo.", toolCalls: [] },
  usage: { input_tokens: 2, cache_read_input_tokens: 4000, cache_creation_input_tokens: 120, output_tokens: 12 },
};

const userTurn = (line: string) =>
  (JSON.parse(line) as { message: { content: string } }).message.content;

describe("claude-code provider", () => {
  test("is registered without an API key and maps to the Claude family", () => {
    expect(getProvider("claude-code")).toBe(claudeCode);
    expect(claudeCode.envVar).toBe("");
    expect(claudeCode.fallbackModels.map((model) => model.id)).toContain("opus");
    expect(detectModelFamily("claude-code/opus")).toBe("claude");
  });

  test("parses auth status JSON and older text output", () => {
    expect(parseClaudeCodeAuthStatus(0, '{"loggedIn": true, "authMethod": "claude.ai"}')).toMatchObject({
      installed: true,
      loggedIn: true,
      authMethod: "claude.ai",
    });
    expect(parseClaudeCodeAuthStatus(0, '{"loggedIn": false}').loggedIn).toBe(false);
    expect(parseClaudeCodeAuthStatus(1, "Not logged in").loggedIn).toBe(false);
    expect(parseClaudeCodeAuthStatus(0, "Logged in").loggedIn).toBe(true);
  });

  test("reads supported flags from help text", () => {
    const flags = parseClaudeCodeFlags("  --tools <tools...>  x\n  --json-schema <schema>\n  -p, --print");
    expect(flags.has("--tools")).toBe(true);
    expect(flags.has("--json-schema")).toBe(true);
    expect(flags.has("--print")).toBe(true);
  });

  test("keeps instructions and schema stable while the transcript grows", () => {
    const a = buildClaudeCodePromptParts(FIRST);
    const b = buildClaudeCodePromptParts({ ...SECOND, toolChoice: { type: "required" } });
    expect(b.instructions).toBe(a.instructions);
    expect(b.schema).toEqual(a.schema);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
    expect(b.step).not.toBe(a.step);
    expect(a.instructions).toContain("read_file");
    expect(renderClaudeCodeTurn(b, 3)).toContain("[tool result read_file id=t1]");
    expect(renderClaudeCodeTurn(b, 3)).not.toContain("Read package.json");
  });

  test("parses structured tool calls, plain replies and fenced JSON text", () => {
    const calls = parseClaudeCodeResponse(toolCallResult.structured_output, "");
    expect(calls.finishReason.unified).toBe("tool-calls");
    expect(calls.content[0]).toMatchObject({ type: "tool-call", toolName: "read_file", input: '{"path":"package.json"}' });

    const fenced = parseClaudeCodeResponse(undefined, '```json\n{"finishReason":"stop","text":"hi"}\n```');
    expect(fenced.content).toEqual([{ type: "text", text: "hi" }]);

    const plain = parseClaudeCodeResponse(undefined, "just text");
    expect(plain.content).toEqual([{ type: "text", text: "just text" }]);

    expect(() => parseClaudeCodeResponse({ finishReason: "tool-calls", text: "", toolCalls: [] }, "")).toThrow();
  });

  test("reports cache reads and writes in usage", () => {
    expect(usageFromResult(stopResult.usage).inputTokens).toEqual({
      total: 4122,
      noCache: 2,
      cacheRead: 4000,
      cacheWrite: 120,
    });
  });

  test("continues one session and sends only the new messages", async () => {
    const { factory, spawned } = fakeFactory([toolCallResult, stopResult]);
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);

    const first = await model.doGenerate(FIRST);
    expect(first.finishReason.unified).toBe("tool-calls");
    const second = await model.doGenerate(SECOND);
    expect(second.content).toEqual([{ type: "text", text: "The package is demo." }]);
    expect(second.usage.inputTokens.cacheRead).toBe(4000);

    expect(spawned).toHaveLength(1);
    const [turn1, turn2] = spawned[0]?.sent.map(userTurn) ?? [];
    expect(turn1).toContain("1. SYSTEM");
    expect(turn1).toContain("2. USER");
    expect(turn2).toContain("CONVERSATION TRANSCRIPT (continued)");
    expect(turn2).toContain("4. TOOL");
    expect(turn2).not.toContain("2. USER");
    expect(turn2).not.toContain("3. ASSISTANT");
    runner.close();
    expect(spawned[0]?.killed).toBe(true);
  });

  test("starts a new session when the transcript does not extend one", async () => {
    const { factory, spawned } = fakeFactory([toolCallResult, stopResult]);
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);
    await model.doGenerate(FIRST);
    // A retry of the same step carries nothing new.
    await model.doGenerate(FIRST);
    expect(spawned).toHaveLength(2);
    runner.close();
  });

  test("an error result rejects the step and closes its session", async () => {
    const { factory, spawned } = fakeFactory([
      { subtype: "success", is_error: true, result: "Invalid API key · Please run /login" },
    ]);
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);
    await expect(model.doGenerate(FIRST)).rejects.toThrow("Invalid API key");
    expect(spawned[0]?.killed).toBe(true);
    expect(runner.sessionCount).toBe(0);
  });

  test("abort stops the turn and its process", async () => {
    const { factory, spawned } = fakeFactory([]);
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);
    const controller = new AbortController();
    const pending = model.doGenerate({ ...FIRST, abortSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(spawned[0]?.killed).toBe(true);
  });
});

describe("claude-code images", () => {
  test("a turn sends the message's image as an image block", async () => {
    const { factory, spawned } = fakeFactory([stopResult]);
    const runner = new ClaudeCodeSessionRunner(factory);
    const model = createClaudeCodeLanguageModel("sonnet", runner);
    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are baked." },
        {
          role: "user",
          content: [
            { type: "text", text: "What colour is this?" },
            { type: "file", mediaType: "image/png", data: "data:image/png;base64,iVBORw==" },
          ],
        },
      ],
    });
    const sent = JSON.parse(spawned[0]?.sent[0] ?? "{}") as {
      message: { content: Array<Record<string, unknown>> };
    };
    const [text, image] = sent.message.content;
    expect(text?.type).toBe("text");
    expect(String(text?.text)).toContain("[image image/png, attached to this message]");
    expect(image).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
    });
    runner.close();
  });

  test("a turn without images stays plain text", async () => {
    const { factory, spawned } = fakeFactory([toolCallResult]);
    const runner = new ClaudeCodeSessionRunner(factory);
    await createClaudeCodeLanguageModel("sonnet", runner).doGenerate(FIRST);
    expect(typeof userTurn(spawned[0]?.sent[0] ?? "")).toBe("string");
    runner.close();
  });
});
