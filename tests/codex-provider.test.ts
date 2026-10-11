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
  type CodexRunnerCall,
  CODEX_ADAPTER_CONFIG,
  codexConfigArgs,
} from "../src/core/llm/providers/codex/runner.js";
import { CodexSessionRunner } from "../src/core/llm/providers/codex/session.js";

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
    expect(codex.description).toContain("turn finishes");
    expect(codex.noAuthLabel).toBe("login required — Enter to authenticate");
    expect(codex.authErrorLabel).toBe("login/session error");
    expect(codex.badge).toBe("non-streaming");
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

interface FakeTurnReply {
  text?: string;
  status?: "completed" | "failed";
  error?: string;
  total?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

function createFakeConnection(replies: FakeTurnReply[]) {
  const listeners = new Set<(method: string, params: unknown) => void>();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let threadCount = 0;
  let turnCount = 0;
  const emit = (method: string, params: unknown) => {
    for (const listener of [...listeners]) listener(method, params);
  };
  const connection: CodexAppServerConnection = {
    closed: false,
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/start") {
        threadCount += 1;
        return { thread: { id: `thread-${threadCount}` } };
      }
      if (method === "turn/start") {
        const reply = replies[turnCount] ?? { text: "{}" };
        turnCount += 1;
        const threadId = params.threadId;
        const turnId = `turn-${turnCount}`;
        queueMicrotask(() => {
          if (reply.total) {
            emit("thread/tokenUsage/updated", {
              threadId,
              turnId,
              tokenUsage: {
                total: {
                  ...reply.total,
                  reasoningOutputTokens: 0,
                  totalTokens: reply.total.inputTokens + reply.total.outputTokens,
                },
              },
            });
          }
          if (reply.text) {
            emit("item/completed", { threadId, turnId, item: { type: "agentMessage", text: reply.text } });
          }
          emit("turn/completed", {
            threadId,
            turn: {
              id: turnId,
              status: reply.status ?? "completed",
              error: reply.error ? { message: reply.error } : null,
            },
          });
        });
        return { turn: { id: turnId } };
      }
      return {};
    },
    async waitForNotification() {
      throw new Error("not used");
    },
    close() {},
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose() {
      return () => {};
    },
  };
  return { connection, requests };
}

const STOP = JSON.stringify({ finishReason: "stop", reasoning: "", text: "done", toolCalls: [] });

function callFor(options: LanguageModelV2CallOptions): CodexRunnerCall {
  return {
    modelId: "gpt-5.5",
    prompt: serializeCodexPrompt(options),
    parts: buildCodexPromptParts(options),
    schema: buildCodexSchema(options),
  };
}

const failingFallback = {
  async run(): Promise<never> {
    throw new Error("fallback should not run");
  },
};

describe("codex app-server session runner", () => {
  const first: LanguageModelV2CallOptions = BASE_OPTIONS;
  const second: LanguageModelV2CallOptions = {
    ...BASE_OPTIONS,
    prompt: [
      ...BASE_OPTIONS.prompt,
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "Now read tsconfig.json" }] },
    ],
  };

  test("continues one thread and sends only the new messages", async () => {
    const { connection, requests } = createFakeConnection([
      { text: STOP, total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 50 } },
      { text: STOP, total: { inputTokens: 2200, cachedInputTokens: 900, outputTokens: 80 } },
    ]);
    const runner = new CodexSessionRunner(async () => connection, failingFallback);

    await runner.run(callFor(first));
    const result = await runner.run(callFor(second));

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
    const threadStart = requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params.ephemeral).toBe(true);
    expect(String(threadStart?.params.baseInstructions)).toContain("AVAILABLE TOOLS");

    const turns = requests.filter((request) => request.method === "turn/start");
    expect(turns).toHaveLength(2);
    const secondInput = JSON.stringify(turns[1]?.params.input);
    expect(secondInput).toContain("Now read tsconfig.json");
    expect(secondInput).not.toContain("Read package.json");
    expect(secondInput).toContain("(continued)");
    expect(result.usage).toMatchObject({ inputTokens: 1200, cachedInputTokens: 900, outputTokens: 30 });
  });

  test("starts a new thread when the transcript does not extend a known one", async () => {
    const { connection, requests } = createFakeConnection([{ text: STOP }, { text: STOP }]);
    const runner = new CodexSessionRunner(async () => connection, failingFallback);

    await runner.run(callFor(first));
    await runner.run(
      callFor({
        ...BASE_OPTIONS,
        prompt: [
          { role: "system", content: "You are baked." },
          { role: "user", content: [{ type: "text", text: "Something else" }] },
        ],
      }),
    );

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
  });

  test("retries of the same step run on a fresh thread", async () => {
    const { connection, requests } = createFakeConnection([{ text: STOP }, { text: STOP }]);
    const runner = new CodexSessionRunner(async () => connection, failingFallback);

    await runner.run(callFor(first));
    await runner.run(callFor(first));

    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
  });

  test("surfaces a failed turn and drops its thread", async () => {
    const { connection, requests } = createFakeConnection([
      { status: "failed", error: "You've hit your usage limit" },
      { text: STOP },
    ]);
    const runner = new CodexSessionRunner(async () => connection, failingFallback);

    await expect(runner.run(callFor(first))).rejects.toThrow("usage limit");
    expect(requests.some((request) => request.method === "thread/unsubscribe")).toBe(true);
  });

  test("falls back to codex exec when app-server cannot start", async () => {
    let fallbackCalls = 0;
    const runner = new CodexSessionRunner(
      async () => {
        throw new Error("app-server unavailable");
      },
      {
        async run() {
          fallbackCalls += 1;
          return { text: STOP, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        },
      },
    );

    await runner.run(callFor(first));
    await runner.run(callFor(second));
    expect(fallbackCalls).toBe(2);
  });
});

