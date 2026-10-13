import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import { getAllProviders, getProvider } from "../src/core/llm/providers/index.js";
import { performCodexBrowserLogin } from "../src/core/llm/providers/codex/auth.js";
import {
  buildCodexSchema,
  codex,
  createCodexLanguageModel,
  parseCodexLoginStatus,
  parseCodexModelListResult,
  parseCodexResponse,
  serializeCodexPrompt,
} from "../src/core/llm/providers/codex.js";
import type { CodexAppServerConnection } from "../src/core/llm/providers/codex/client.js";
import {
  buildCodexPromptParts,
  CODEX_ADAPTER_CONFIG,
  codexConfigArgs,
} from "../src/core/llm/providers/codex/runner.js";
import {
  buildCodexNativeRequest,
  CodexAppServerSessions,
  createCodexNativeLanguageModel,
  renderCodexNativeInput,
} from "../src/core/llm/providers/codex/native.js";

const BASE_OPTIONS: LanguageModelV2CallOptions = {
  prompt: [
    { role: "system", content: "You are baked." },
    { role: "user", content: [{ type: "text", text: "Read package.json" }] },
  ],
  responseFormat: { type: "text" },
};

describe("codex provider", () => {
  test("is registered as a builtin provider", () => {
    expect(getProvider("codex")).toBeDefined();
    expect(getAllProviders().map((provider) => provider.id).sort()).toEqual(["anthropic", "claude-code", "codex", "copilot", "github-models", "openai"]);
  });

  test("has provider metadata, fallback models, and shared auth hook", () => {
    expect(codex.id).toBe("codex");
    expect(codex.name).toBe("Codex");
    expect(codex.envVar).toBe("");
    expect(codex.description).toContain("Codex");
    expect(codex.description).toContain("app-server");
    expect(codex.noAuthLabel).toBe("login required — Enter to authenticate");
    expect(codex.authErrorLabel).toBe("login/session error");
    expect(codex.badge).toBeUndefined();
    expect(codex.onRequestAuth).toBeDefined();
    expect(codex.fallbackModels).toEqual([
      { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272_000 },
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1_050_000 },
      { id: "gpt-5.2-codex", name: "GPT-5.2-Codex", contextWindow: 400_000 },
    ]);
    expect(codex.contextWindows).toEqual([
      ["gpt-5.5", 272_000],
      ["gpt-5.4", 1_050_000],
      ["gpt-5.2-codex", 400_000],
    ]);
  });

  test("parses official codex login status output", () => {
    expect(parseCodexLoginStatus(0, "Logged in using ChatGPT")).toEqual({
      installed: true,
      loggedIn: true,
      authMode: "chatgpt",
      message: "Logged in using ChatGPT",
    });

    expect(parseCodexLoginStatus(0, "Logged in using an API key - sk-proj-***ABCDE")).toEqual({
      installed: true,
      loggedIn: true,
      authMode: "api-key",
      message: "Logged in using an API key - sk-proj-***ABCDE",
    });

    expect(parseCodexLoginStatus(1, "Not logged in")).toEqual({
      installed: true,
      loggedIn: false,
      authMode: null,
      message: "Not logged in",
    });
  });

  test("parses official model/list output and drops hidden models", () => {
    const models = parseCodexModelListResult({
      data: [
        { id: "gpt-5.4", displayName: "gpt-5.4", hidden: false },
        { id: "gpt-5.2-codex", displayName: "gpt-5.2-codex", hidden: false },
        { id: "internal-test-model", displayName: "Internal", hidden: true },
      ],
      nextCursor: null,
    });

    expect(models).toEqual([
      { id: "gpt-5.4", name: "gpt-5.4" },
      { id: "gpt-5.2-codex", name: "gpt-5.2-codex" },
    ]);
  });

  test("performs browser login via official app-server auth flow", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    let openedUrl = "";

    await performCodexBrowserLogin(
      {
        request: async (method) => {
          calls.push(method);
          if (method === "account/login/start") {
            return {
              type: "chatgpt",
              loginId: "login-123",
              authUrl: "https://chatgpt.com/auth/callback",
            };
          }
          throw new Error(`Unexpected request ${method}`);
        },
        waitForNotification: async (method, predicate) => {
          calls.push(method);
          const payload = { loginId: "login-123", success: true, error: null };
          expect(predicate(payload)).toBe(true);
          return payload;
        },
      },
      async (url) => {
        openedUrl = url;
        return true;
      },
      (event) => events.push(event),
    );

    expect(calls).toEqual(["account/login/start", "account/login/completed"]);
    expect(openedUrl).toBe("https://chatgpt.com/auth/callback");
    expect(events).toEqual([
      "Starting Codex browser login...",
      "Opening browser for Codex login...",
      "Browser opened. Complete the login in ChatGPT.",
      "Codex authentication complete.",
    ]);
  });

  test("surfaces app-server login failures", async () => {
    await expect(
      performCodexBrowserLogin(
        {
          request: async () => ({
            type: "chatgpt",
            loginId: "login-123",
            authUrl: "https://chatgpt.com/auth/callback",
          }),
          waitForNotification: async () => ({
            loginId: "login-123",
            success: false,
            error: "Access denied",
          }),
        },
        async () => true,
      ),
    ).rejects.toThrow("Access denied");
  });

  test("serializes prompt transcript and available tools for Codex", () => {
    const prompt = serializeCodexPrompt({
      ...BASE_OPTIONS,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      toolChoice: { type: "auto" },
    });

    expect(prompt).toContain("You are Codex running as the language-model backend for baked");
    expect(prompt).toContain("SYSTEM");
    expect(prompt).toContain("Read package.json");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("Read a file from disk");
  });

  test("builds a schema that allows tool calls when tools are available", () => {
    const schema = buildCodexSchema({
      ...BASE_OPTIONS,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: { type: "auto" },
    });

    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("tool-calls");
    expect(JSON.stringify(schema)).toContain("read_file");
  });

  test("parses stop responses into reasoning and text content", () => {
    const parsed = parseCodexResponse(
      JSON.stringify({
        finishReason: "stop",
        reasoning: "Need no tools.",
        text: "Done.",
        toolCalls: [],
      }),
    );

    expect(parsed.finishReason).toBe("stop");
    expect(parsed.content).toEqual([
      { type: "reasoning", text: "Need no tools." },
      { type: "text", text: "Done." },
    ]);
  });

  test("parses tool-call responses into AI SDK tool call parts", () => {
    const parsed = parseCodexResponse(
      JSON.stringify({
        finishReason: "tool-calls",
        reasoning: "Need file contents.",
        text: "",
        toolCalls: [{ toolName: "read_file", inputJson: JSON.stringify({ path: "package.json" }) }],
      }),
    );

    expect(parsed.finishReason).toBe("tool-calls");
    expect(parsed.content[0]).toEqual({ type: "reasoning", text: "Need file contents." });
    expect(parsed.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "read_file",
      input: JSON.stringify({ path: "package.json" }),
    });
  });

  test("language model forwards prompt and schema to the runner", async () => {
    const calls: Array<{ modelId: string; prompt: string; schema: unknown }> = [];
    const model = createCodexLanguageModel("gpt-5.2-codex", {
      async run(call) {
        calls.push({ modelId: call.modelId, prompt: call.prompt, schema: call.schema });
        return {
          text: JSON.stringify({
            finishReason: "stop",
            reasoning: "",
            text: "PONG",
            toolCalls: [],
          }),
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        };
      },
    });

    const result = await model.doGenerate(BASE_OPTIONS);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe("gpt-5.2-codex");
    expect(calls[0]?.prompt).toContain("Read package.json");
    expect(result.content).toEqual([{ type: "text", text: "PONG" }]);
    expect(result.usage.totalTokens).toBe(16);
  });

  test("streaming emits final text and finish events", async () => {
    const model = createCodexLanguageModel("gpt-5.2-codex", {
      async run() {
        return {
          text: JSON.stringify({
            finishReason: "stop",
            reasoning: "",
            text: "Hello from Codex",
            toolCalls: [],
          }),
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        };
      },
    });

    const { stream } = await model.doStream(BASE_OPTIONS);
    const reader = stream.getReader();
    const parts: string[] = [];

    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value.type);
    }

    expect(parts).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);
  });

  test("keeps per-step rules after the transcript so the prefix stays stable", () => {
    const tools: LanguageModelV2CallOptions["tools"] = [
      { type: "function", name: "read_file", description: "Read", inputSchema: { type: "object" } },
    ];
    const auto = buildCodexPromptParts({ ...BASE_OPTIONS, tools, toolChoice: { type: "auto" } });
    const forced = buildCodexPromptParts({
      ...BASE_OPTIONS,
      tools,
      toolChoice: { type: "tool", toolName: "read_file" },
    });

    expect(forced.instructions).toBe(auto.instructions);
    expect(forced.step).not.toBe(auto.step);
    expect(auto.messages.map((message) => message.role)).toEqual(["system", "user"]);
    const prompt = serializeCodexPrompt({ ...BASE_OPTIONS, tools, toolChoice: { type: "auto" } });
    expect(prompt.indexOf("Read package.json")).toBeLessThan(prompt.indexOf("CURRENT STEP"));
  });

  test("renders adapter config as codex --config overrides", () => {
    const args = codexConfigArgs({ web_search: "disabled", "features.shell_tool": false });
    expect(args).toEqual(["--config", 'web_search="disabled"', "--config", "features.shell_tool=false"]);
    expect(CODEX_ADAPTER_CONFIG["features.shell_tool"]).toBe(false);
  });
});

class FakeCodex {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly responses: Array<{ id: string | number; result?: unknown; error?: string }> = [];
  onTurnStart: (threadId: string, text: string) => void = () => {};
  onRespond: (threadId: string, id: string | number, result: unknown) => void = () => {};
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly requestListeners = new Set<
    (method: string, id: string | number, params: unknown) => boolean
  >();
  private threads = 0;
  private turns = 0;
  private nextServerRequest = 100;
  private readonly requestThreads = new Map<string | number, string>();
  turnIdFor = new Map<string, string>();

  readonly connection: CodexAppServerConnection = {
    closed: false,
    request: async (method, params) => {
      this.requests.push({ method, params });
      if (method === "thread/start") {
        this.threads += 1;
        return { thread: { id: `thread-${this.threads}` } };
      }
      if (method === "turn/start") {
        this.turns += 1;
        const threadId = String(params.threadId);
        const turnId = `turn-${this.turns}`;
        this.turnIdFor.set(threadId, turnId);
        const input = params.input as Array<{ text: string }>;
        queueMicrotask(() => this.onTurnStart(threadId, input[0]?.text ?? ""));
        return { turn: { id: turnId } };
      }
      return {};
    },
    waitForNotification: async () => {
      throw new Error("not used");
    },
    close: () => {},
    onNotification: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    onClose: () => () => {},
    onServerRequest: (listener) => {
      this.requestListeners.add(listener);
      return () => this.requestListeners.delete(listener);
    },
    respond: (id, result) => {
      this.responses.push({ id, result });
      const threadId = this.requestThreads.get(id) ?? "";
      queueMicrotask(() => this.onRespond(threadId, id, result));
    },
    respondError: (id, error) => {
      this.responses.push({ id, error });
    },
  };

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(method, params);
  }

  text(threadId: string, itemId: string, text: string): void {
    const turnId = this.turnIdFor.get(threadId);
    this.emit("item/agentMessage/delta", { threadId, turnId, itemId, delta: text });
    this.emit("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text } });
  }

  usage(threadId: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): void {
    this.emit("thread/tokenUsage/updated", {
      threadId,
      tokenUsage: { total: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0 } },
    });
  }

  complete(threadId: string, status = "completed", error?: string): void {
    this.emit("turn/completed", {
      threadId,
      turn: { id: this.turnIdFor.get(threadId), status, error: error ? { message: error } : null },
    });
  }

  toolCall(threadId: string, callId: string, tool: string, args: unknown): void {
    const id = this.nextServerRequest++;
    this.requestThreads.set(id, threadId);
    for (const listener of [...this.requestListeners]) {
      if (
        listener("item/tool/call", id, {
          threadId,
          turnId: this.turnIdFor.get(threadId),
          callId,
          tool,
          arguments: args,
        })
      )
        return;
    }
  }

  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }
}

const READ_TOOL: NonNullable<LanguageModelV2CallOptions["tools"]> = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

const unusedFallback = createCodexLanguageModel("gpt-5.5", {
  async run(): Promise<never> {
    throw new Error("fallback should not run");
  },
});

async function readParts(stream: ReadableStream<{ type: string }>) {
  const parts: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value as Record<string, unknown>);
  }
  return parts;
}

describe("codex app-server native model", () => {
  const userPrompt: LanguageModelV2CallOptions["prompt"] = [
    { role: "system", content: "You are baked." },
    { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
  ];

  function setup() {
    const fake = new FakeCodex();
    const sessions = new CodexAppServerSessions(async () => fake.connection);
    const model = createCodexNativeLanguageModel("gpt-5.5", sessions, unusedFallback);
    return { fake, model };
  }

  test("puts system messages into the thread instructions and registers tools", () => {
    const request = buildCodexNativeRequest("gpt-5.5", { prompt: userPrompt, tools: READ_TOOL });
    expect(request.instructions).toContain("You are baked.");
    expect(request.conversation).toHaveLength(1);
    expect(request.dynamicTools[0]).toMatchObject({ type: "function", name: "read_file" });
    expect(renderCodexNativeInput(request.conversation, "")).toBe("Read a.txt");
  });

  test("streams text and reports usage from the thread totals", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => {
      fake.text(threadId, "m1", "Hello");
      fake.usage(threadId, 1000, 0, 20);
      fake.complete(threadId);
    };

    const { stream } = await model.doStream({ prompt: userPrompt, tools: READ_TOOL });
    const parts = await readParts(stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 1000, outputTokens: 20 },
    });
    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params.ephemeral).toBe(true);
    expect(String(threadStart?.params.baseInstructions)).toContain("You are baked.");
    expect(threadStart?.params.dynamicTools).toEqual([
      expect.objectContaining({ name: "read_file" }),
    ]);
  });

  test("ends the step at a tool call and answers it on the next call in the same turn", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => fake.toolCall(threadId, "call-1", "read_file", { path: "a.txt" });

    const first = await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    expect(first.finishReason).toBe("tool-calls");
    expect(first.content).toEqual([
      { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: '{"path":"a.txt"}' },
    ]);

    let answered: unknown;
    fake.onRespond = (threadId, _id, result) => {
      answered = result;
      fake.usage(threadId, 2200, 900, 40);
      fake.text(threadId, "m2", "It says hello.");
      fake.complete(threadId);
    };
    const second = await model.doGenerate({
      prompt: [
        ...userPrompt,
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { type: "text", value: "hello" } },
          ],
        },
      ],
      tools: READ_TOOL,
    });

    expect(answered).toEqual({ contentItems: [{ type: "inputText", text: "hello" }], success: true });
    expect(second.content).toEqual([{ type: "text", text: "It says hello." }]);
    expect(second.usage).toMatchObject({ inputTokens: 2200, cachedInputTokens: 900 });
    // Codex reports the first response's usage only after the tool result: the second step
    // carries it, and counts it as one model request.
    expect(first.providerMetadata).toEqual({ codex: { responses: 0 } });
    expect(second.providerMetadata).toEqual({ codex: { responses: 1 } });
    expect(fake.count("thread/start")).toBe(1);
    expect(fake.count("turn/start")).toBe(1);
  });

  test("a user message appended after a tool result rides on the same thread (#820)", async () => {
    const { fake, model } = setup();
    const call = (id: string, path: string) => ({
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, toolCallId: id, toolName: "read_file", input: { path } }],
    });
    const result = (id: string, value: string) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: id,
          toolName: "read_file",
          output: { type: "text" as const, value },
        },
      ],
    });
    const reminder = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "<system-reminder>\nFinish with final_response.\n</system-reminder>" }],
    };
    fake.onTurnStart = (threadId) => fake.toolCall(threadId, "call-1", "read_file", { path: "a.txt" });
    const answers: unknown[] = [];
    let input = 1000;
    fake.onRespond = (threadId, _id, answer) => {
      answers.push(answer);
      // Codex reports the answered response, then the model continues.
      fake.usage(threadId, input, 0, 10);
      input += 1000;
      if (answers.length === 1) fake.toolCall(threadId, "call-2", "read_file", { path: "b.txt" });
      else {
        fake.text(threadId, "m", "Done.");
        fake.usage(threadId, input, 0, 20);
        fake.complete(threadId);
      }
    };

    const first = await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    const second = await model.doGenerate({
      prompt: [...userPrompt, call("call-1", "a.txt"), result("call-1", "b.txt next")],
      tools: READ_TOOL,
    });
    const third = await model.doGenerate({
      prompt: [
        ...userPrompt,
        call("call-1", "a.txt"),
        result("call-1", "b.txt next"),
        call("call-2", "b.txt"),
        result("call-2", "end"),
        reminder,
      ],
      tools: READ_TOOL,
    });

    expect(third.content).toEqual([{ type: "text", text: "Done." }]);
    expect(fake.count("thread/start")).toBe(1);
    expect(fake.count("turn/start")).toBe(1);
    expect(answers[1]).toEqual({
      contentItems: [
        { type: "inputText", text: "end" },
        { type: "inputText", text: "<system-reminder>\nFinish with final_response.\n</system-reminder>" },
      ],
      success: true,
    });
    // Every response is reported: the second step carries the first, the third the other two.
    expect([first, second, third].map((step) => step.providerMetadata)).toEqual([
      { codex: { responses: 0 } },
      { codex: { responses: 1 } },
      { codex: { responses: 2 } },
    ]);
    expect(third.usage).toMatchObject({ inputTokens: 2000, outputTokens: 10 });
  });

  test("counts a response whose tool call is abandoned as unreported (#820)", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => {
      if (fake.count("thread/start") === 1) fake.toolCall(threadId, "call-1", "read_file", { path: "a.txt" });
      else {
        fake.text(threadId, "m", "Done.");
        fake.usage(threadId, 500, 0, 5);
        fake.complete(threadId);
      }
    };
    await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    // The next request moves past the tool call without its result (an image cannot ride in it).
    const next = await model.doGenerate({
      prompt: [
        ...userPrompt,
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } }],
        },
        { role: "user", content: [{ type: "text", text: "Never mind, say done." }] },
      ],
      tools: READ_TOOL,
    });
    expect(fake.count("thread/start")).toBe(2);
    expect(fake.responses.at(0)).toMatchObject({ error: "baked abandoned this tool call" });
    expect(next.providerMetadata).toEqual({ codex: { responses: 1, unreportedResponses: 1 } });
  });

  test("a thread left at its last tool call is stopped and its late usage counted (#863)", async () => {
    const { fake, model } = setup();
    let left = "";
    fake.onTurnStart = (threadId) => {
      if (!left) {
        left = threadId;
        fake.toolCall(threadId, "submit-1", "read_file", { path: "a.txt" });
      } else {
        fake.text(threadId, "m", "Next attempt.");
        fake.usage(threadId, 700, 0, 7);
        fake.complete(threadId);
      }
    };
    // The attempt's last step ends at its submit call; then the attempt ends and aborts.
    const attempt = new AbortController();
    const last = await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL, abortSignal: attempt.signal });
    expect(last.finishReason).toBe("tool-calls");
    attempt.abort();
    expect(fake.count("turn/interrupt")).toBe(1);
    expect(fake.responses.at(-1)).toMatchObject({ error: "baked abandoned this tool call" });

    // Codex reports the abandoned response late, and its model asks for another tool call.
    fake.usage(left, 1200, 0, 30);
    fake.toolCall(left, "again", "read_file", { path: "a.txt" });
    expect(fake.responses.at(-1)).toMatchObject({ error: "baked left this thread" });
    expect(fake.count("turn/interrupt")).toBe(2);
    fake.complete(left, "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.count("thread/unsubscribe")).toBe(1);

    // The next attempt's first step carries the late usage.
    const next = await model.doGenerate({
      prompt: [
        { role: "system", content: "You are baked." },
        { role: "user", content: [{ type: "text", text: "Another task" }] },
      ],
      tools: READ_TOOL,
    });
    expect(next.usage).toMatchObject({ inputTokens: 1900, outputTokens: 37 });
    expect(next.providerMetadata).toEqual({
      codex: { responses: 1, unreportedResponses: 1, lateResponses: 1 },
    });
    // A report from the thread after it was forgotten is not counted again.
    fake.usage(left, 5000, 0, 50);
    const again = await model.doGenerate({
      prompt: [
        { role: "system", content: "You are baked." },
        { role: "user", content: [{ type: "text", text: "Another task" }] },
        { role: "assistant", content: [{ type: "text", text: "Next attempt." }] },
        { role: "user", content: [{ type: "text", text: "More" }] },
      ],
      tools: READ_TOOL,
    });
    expect(again.providerMetadata).toEqual({ codex: { responses: 1 } });
  });

  test("a compacted older tool output keeps the thread (#863)", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => fake.toolCall(threadId, "call-1", "read_file", { path: "a.txt" });
    let answers = 0;
    fake.onRespond = (threadId) => {
      answers += 1;
      if (answers === 1) fake.toolCall(threadId, "call-2", "read_file", { path: "b.txt" });
      else {
        fake.text(threadId, "m", "Done.");
        fake.complete(threadId);
      }
    };
    const call = (id: string, path: string) => ({
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, toolCallId: id, toolName: "read_file", input: { path } }],
    });
    const result = (id: string, value: string) => ({
      role: "tool" as const,
      content: [
        { type: "tool-result" as const, toolCallId: id, toolName: "read_file", output: { type: "text" as const, value } },
      ],
    });
    await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    await model.doGenerate({
      prompt: [...userPrompt, call("call-1", "a.txt"), result("call-1", "a long file body")],
      tools: READ_TOOL,
    });
    const third = await model.doGenerate({
      prompt: [
        ...userPrompt,
        call("call-1", "a.txt"),
        // The step budget replaced the older output with a stub.
        result("call-1", '{"compacted":true}'),
        call("call-2", "b.txt"),
        result("call-2", "b"),
      ],
      tools: READ_TOOL,
    });
    expect(third.content).toEqual([{ type: "text", text: "Done." }]);
    expect(fake.count("thread/start")).toBe(1);
    expect(fake.count("turn/interrupt")).toBe(0);
  });

  test("waits for a usage report that arrives after turn/completed", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => {
      fake.text(threadId, "m1", "Done.");
      fake.complete(threadId);
      setTimeout(() => fake.usage(threadId, 3000, 0, 50), 20);
    };
    const result = await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    expect(result.usage).toMatchObject({ inputTokens: 3000, outputTokens: 50 });
    expect(result.providerMetadata).toEqual({ codex: { responses: 1 } });
  });

  test("usage reported between steps goes to the next step on the thread", async () => {
    const { fake, model } = setup();
    let threadOf = "";
    fake.onTurnStart = (threadId) => {
      threadOf = threadId;
      fake.text(threadId, "m1", "First.");
      fake.usage(threadId, 1000, 0, 10);
      fake.complete(threadId);
    };
    const first = await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    expect(first.usage).toMatchObject({ inputTokens: 1000, outputTokens: 10 });
    // A late report for the first turn lands while no step is open.
    fake.usage(threadOf, 1500, 0, 30);
    fake.onTurnStart = (threadId) => {
      fake.text(threadId, "m2", "Second.");
      fake.usage(threadId, 2500, 0, 50);
      fake.complete(threadId);
    };
    const second = await model.doGenerate({
      prompt: [
        ...userPrompt,
        { role: "assistant", content: [{ type: "text", text: "First." }] },
        { role: "user", content: [{ type: "text", text: "And then?" }] },
      ],
      tools: READ_TOOL,
    });
    expect(fake.count("thread/start")).toBe(1);
    expect(second.usage).toMatchObject({ inputTokens: 1500, outputTokens: 40 });
  });

  test("sends the chat's reasoning effort on the turn", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => fake.complete(threadId);
    await model.doGenerate({
      prompt: userPrompt,
      providerOptions: { codex: { reasoningEffort: "xhigh" } },
    });
    expect(fake.requests.find((r) => r.method === "turn/start")?.params.effort).toBe("xhigh");
    expect(buildCodexNativeRequest("gpt-5.5", { prompt: userPrompt }).effort).toBeUndefined();
  });

  test("sends only the new user message as the next turn on the same thread", async () => {
    const { fake, model } = setup();
    const inputs: string[] = [];
    fake.onTurnStart = (threadId, text) => {
      inputs.push(text);
      fake.text(threadId, `m${inputs.length}`, "Done.");
      fake.complete(threadId);
    };

    await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    await model.doGenerate({
      prompt: [
        ...userPrompt,
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: [{ type: "text", text: "Now b.txt" }] },
      ],
      tools: READ_TOOL,
    });

    expect(inputs).toEqual(["Read a.txt", "Now b.txt"]);
    expect(fake.count("thread/start")).toBe(1);
  });

  test("starts a new thread when the conversation does not extend a known one", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => {
      fake.text(threadId, "m", "Done.");
      fake.complete(threadId);
    };

    await model.doGenerate({ prompt: userPrompt, tools: READ_TOOL });
    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are baked." },
        { role: "user", content: [{ type: "text", text: "Something else" }] },
      ],
      tools: READ_TOOL,
    });

    expect(fake.count("thread/start")).toBe(2);
  });

  test("surfaces a failed turn as a stream error", async () => {
    const { fake, model } = setup();
    fake.onTurnStart = (threadId) => fake.complete(threadId, "failed", "You've hit your usage limit");

    await expect(model.doGenerate({ prompt: userPrompt, tools: READ_TOOL })).rejects.toThrow(
      "usage limit",
    );
  });

  test("interrupts the turn when the step is aborted", async () => {
    const { fake, model } = setup();
    const controller = new AbortController();
    fake.onTurnStart = (threadId) => {
      fake.emit("item/agentMessage/delta", {
        threadId,
        turnId: fake.turnIdFor.get(threadId),
        itemId: "m",
        delta: "Working",
      });
      controller.abort();
    };

    await expect(
      model.doGenerate({ prompt: userPrompt, tools: READ_TOOL, abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(fake.count("turn/interrupt")).toBe(1);
  });

  test("falls back to codex exec when app-server cannot start", async () => {
    let fallbackCalls = 0;
    const fallback = createCodexLanguageModel("gpt-5.5", {
      async run() {
        fallbackCalls += 1;
        return {
          text: JSON.stringify({ finishReason: "stop", reasoning: "", text: "exec", toolCalls: [] }),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    });
    const sessions = new CodexAppServerSessions(async () => {
      throw new Error("app-server unavailable");
    });
    const model = createCodexNativeLanguageModel("gpt-5.5", sessions, fallback);

    const result = await model.doGenerate({ prompt: userPrompt });
    expect(result.content).toEqual([{ type: "text", text: "exec" }]);
    expect(fallbackCalls).toBe(1);
  });
});

describe("codex images", () => {
  const RED = new Uint8Array([137, 80, 78, 71]);
  const withImage: LanguageModelV2CallOptions["prompt"] = [
    { role: "system", content: "You are baked." },
    {
      role: "user",
      content: [
        { type: "text", text: "What colour is this?" },
        { type: "file", mediaType: "image/png", data: RED },
      ],
    },
  ];

  test("an app-server turn sends the image beside the text", async () => {
    const fake = new FakeCodex();
    const sessions = new CodexAppServerSessions(async () => fake.connection);
    const model = createCodexNativeLanguageModel("gpt-5.5", sessions, unusedFallback);
    fake.onTurnStart = (threadId) => {
      fake.text(threadId, "m1", "Red");
      fake.complete(threadId);
    };
    await model.doGenerate({ prompt: withImage });
    const turn = fake.requests.find((request) => request.method === "turn/start");
    const input = turn?.params.input as Array<Record<string, unknown>>;
    expect(input[0]?.text).toContain("[image image/png, attached to this message]");
    expect(input[1]).toEqual({ type: "image", url: "data:image/png;base64,iVBORw==" });
  });

  test("exec prompt parts carry the conversation's images", () => {
    const parts = buildCodexPromptParts({ prompt: withImage });
    expect(parts.images).toEqual([{ mediaType: "image/png", base64: "iVBORw==" }]);
    expect(parts.messages[1]?.text).not.toContain("binary:");
  });
});
