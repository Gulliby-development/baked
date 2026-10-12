import { randomUUID } from "node:crypto";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { getCwd } from "../../../cwd.js";
import { cliReasoningEffort } from "../cli-effort.js";
import { imageUrl, promptImages } from "../prompt-images.js";
import { type CodexAppServerConnection, startCodexAppServerSession } from "./client.js";
import {
  CODEX_ADAPTER_CONFIG,
  collectWarnings,
  getFunctionTools,
  renderMessageContent,
  renderToolResult,
  type ToolResultPromptPart,
} from "./runner.js";

type PromptMessage = LanguageModelV2Prompt[number];

/** Threads kept per process; the least recently used idle thread is dropped beyond this. */
const MAX_THREADS = 16;

const ADAPTER_PREAMBLE = [
  "You are the language model behind baked, a coding agent that runs on the user's machine.",
  "Follow the baked instructions below. Call the function tools baked provides when they help; baked runs them and returns the result.",
  "Never use Codex built-in tools such as apply_patch or a shell of your own: only the baked tools are connected to the user's workspace.",
].join("\n");

interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const ZERO_TOTALS: TokenTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

interface DynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
}

/** One model call, split into what fixes a Codex thread and what a turn sends. */
export interface CodexNativeRequest {
  modelId: string;
  /** Adapter preamble plus BAKED's leading system messages: the thread's base instructions. */
  instructions: string;
  dynamicTools: DynamicTool[];
  /** Messages after the leading system messages. */
  conversation: PromptMessage[];
  keys: string[];
  /** Per-call rules (tool choice) appended to a new turn's input. */
  stepNote: string;
  outputSchema?: unknown;
  /** Reasoning effort for this turn; the thread's default when absent. */
  effort?: string;
}

/** A message's identity for matching, without per-step provider options such as cache markers. */
function messageKey(message: PromptMessage): string {
  return JSON.stringify(message, (key, value) => (key === "providerOptions" ? undefined : value));
}

function messageText(message: PromptMessage): string {
  return typeof message.content === "string"
    ? message.content
    : renderMessageContent(message.content);
}

function describeNativeToolChoice(options: LanguageModelV2CallOptions): string {
  const choice = options.toolChoice;
  if (!choice || choice.type === "auto") return "";
  if (choice.type === "none") return "Do not call any tools for this reply. Answer directly.";
  if (choice.type === "required") return "Call at least one tool before you answer.";
  return `Call the tool ${choice.toolName} before you answer.`;
}

export function buildCodexNativeRequest(
  modelId: string,
  options: LanguageModelV2CallOptions,
): CodexNativeRequest {
  let leading = 0;
  while (options.prompt[leading]?.role === "system") leading += 1;
  const system = options.prompt.slice(0, leading).map(messageText);
  const conversation = options.prompt.slice(leading);
  const dynamicTools = getFunctionTools(options).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  }));
  const effort = cliReasoningEffort(options.providerOptions, "codex");
  return {
    modelId,
    ...(effort ? { effort } : {}),
    instructions: [ADAPTER_PREAMBLE, ...system].join("\n\n"),
    dynamicTools,
    conversation,
    keys: conversation.map(messageKey),
    stepNote: describeNativeToolChoice(options),
    outputSchema:
      options.responseFormat?.type === "json"
        ? (options.responseFormat.schema ?? undefined)
        : undefined,
  };
}

/**
 * Renders messages as a turn's text input. Plain user messages go as they are;
 * anything else (history after compaction, tool results) becomes a labelled transcript.
 */
export function renderCodexNativeInput(messages: PromptMessage[], stepNote: string): string {
  const body = messages.every((message) => message.role === "user")
    ? messages.map(messageText).join("\n\n")
    : [
        "CONVERSATION SO FAR",
        messages
          .map((message) => `${message.role.toUpperCase()}\n${messageText(message)}`)
          .join("\n\n"),
        "",
        "Continue from the last message.",
      ].join("\n");
  return stepNote ? `${body}\n\n${stepNote}` : body;
}

interface StepSink {
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>;
  startTotals: TokenTotals;
  openText: Map<string, string>;
  openReasoning: Map<string, string>;
  /** Item ids of agent messages whose text was streamed as deltas. */
  streamed: Set<string>;
  lastError: string | null;
}

interface NativeThread {
  threadId: string;
  modelId: string;
  instructions: string;
  toolsKey: string;
  /** Conversation keys Codex holds, as of the request that started the current step. */
  keys: string[];
  /**
   * idle: the last turn completed; the next call starts with BAKED's copy of the reply.
   * running: a step is streaming (or a new thread is about to start its first turn).
   * suspended: a tool call waits for its result. broken: unusable.
   */
  state: "idle" | "running" | "suspended" | "broken";
  turnId: string | null;
  pending: { callId: string; requestId: string | number } | null;
  sink: StepSink | null;
  totals: TokenTotals;
  lastUsed: number;
}

function readTotals(value: unknown): TokenTotals | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof TokenTotals, unknown>>;
  const num = (field: unknown) => (typeof field === "number" ? field : 0);
  return {
    inputTokens: num(raw.inputTokens),
    cachedInputTokens: num(raw.cachedInputTokens),
    outputTokens: num(raw.outputTokens),
    reasoningOutputTokens: num(raw.reasoningOutputTokens),
  };
}

function usageBetween(before: TokenTotals, after: TokenTotals): LanguageModelV2Usage {
  const inputTokens = after.inputTokens - before.inputTokens;
  const outputTokens = after.outputTokens - before.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reasoningTokens: after.reasoningOutputTokens - before.reasoningOutputTokens,
    cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
  };
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function toolResultFor(message: PromptMessage | undefined, callId: string) {
  if (message?.role !== "tool" || typeof message.content === "string") return null;
  const results = message.content.filter(
    (part): part is ToolResultPromptPart => part.type === "tool-result",
  );
  if (results.length !== 1 || results[0]?.toolCallId !== callId) return null;
  return results[0];
}

function hasToolCall(message: PromptMessage | undefined, callId: string): boolean {
  if (message?.role !== "assistant" || typeof message.content === "string") return false;
  const calls = message.content.filter((part) => part.type === "tool-call");
  return calls.length === 1 && calls[0]?.type === "tool-call" && calls[0].toolCallId === callId;
}

type Plan =
  | { kind: "resume"; thread: NativeThread; result: ToolResultPromptPart }
  | { kind: "turn"; thread: NativeThread; fromIndex: number };

/**
 * Drives BAKED model calls on long-lived Codex app-server threads with BAKED's
 * tools registered as dynamic tools. Codex owns the turn: when the model calls a
 * tool, the step ends with that tool call and the turn waits; the next call
 * carries the tool result, which answers Codex's pending request, and the same
 * turn streams on. Codex dispatches one dynamic tool call at a time, so each
 * step reports at most one call. New user messages start a new turn on the same
 * thread, so the conversation keeps one prompt cache key.
 */
export class CodexAppServerSessions {
  private connection: Promise<CodexAppServerConnection> | null = null;
  private threads: NativeThread[] = [];
  private unavailable = false;

  constructor(
    private readonly connect: () => Promise<CodexAppServerConnection> = () =>
      startCodexAppServerSession({ experimentalApi: true }),
  ) {}

  /** Opens a streaming step, or returns null when app-server cannot serve it. */
  async openStep(
    request: CodexNativeRequest,
    abortSignal?: AbortSignal,
  ): Promise<ReadableStream<LanguageModelV2StreamPart> | null> {
    if (this.unavailable) return null;
    abortSignal?.throwIfAborted();

    let connection: CodexAppServerConnection;
    try {
      connection = await this.getConnection();
    } catch {
      this.unavailable = true;
      return null;
    }

    let plan = this.plan(connection, request);
    if (!plan) {
      try {
        const thread = await this.startThread(connection, request);
        plan = { kind: "turn", thread, fromIndex: 0 };
      } catch {
        return null;
      }
    }

    const { thread } = plan;
    thread.lastUsed = Date.now();
    const startedPlan = plan;
    let stepSink: StepSink | null = null;
    return new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] });
        const sink: StepSink = {
          controller,
          startTotals: thread.totals,
          openText: new Map(),
          openReasoning: new Map(),
          streamed: new Set(),
          lastError: null,
        };
        thread.sink = sink;
        stepSink = sink;
        thread.keys = request.keys;
        abortSignal?.addEventListener(
          "abort",
          () => this.abort(connection, thread, sink, abortSignal),
          { once: true },
        );
        if (startedPlan.kind === "resume") {
          const pending = thread.pending;
          thread.pending = null;
          if (!pending) return;
          const output = startedPlan.result.output;
          connection.respond(pending.requestId, {
            contentItems: [{ type: "inputText", text: renderToolResult(startedPlan.result) }],
            success: !output.type.startsWith("error"),
          });
          return;
        }
        this.startTurn(connection, thread, request, startedPlan.fromIndex);
      },
      cancel: () => {
        if (stepSink) this.abort(connection, thread, stepSink, abortSignal);
      },
    });
  }

  /** Closes the app-server process and forgets every thread. */
  close(): void {
    const pending = this.connection;
    this.connection = null;
    this.threads = [];
    void pending?.then((connection) => connection.close()).catch(() => {});
  }

  private plan(connection: CodexAppServerConnection, request: CodexNativeRequest): Plan | null {
    const toolsKey = JSON.stringify(request.dynamicTools);
    let best: Plan | null = null;
    for (const thread of [...this.threads]) {
      if (thread.modelId !== request.modelId || thread.instructions !== request.instructions)
        continue;
      if (thread.toolsKey !== toolsKey) continue;
      if (thread.state === "running" || thread.state === "broken") continue;
      const known = thread.keys.length;
      if (known > request.keys.length) continue;
      if (!thread.keys.every((key, index) => key === request.keys[index])) continue;

      if (thread.state === "suspended") {
        const pending = thread.pending;
        const result = pending
          ? toolResultFor(request.conversation[known + 1], pending.callId)
          : null;
        if (
          pending &&
          result &&
          request.keys.length === known + 2 &&
          hasToolCall(request.conversation[known], pending.callId)
        ) {
          thread.state = "running";
          return { kind: "resume", thread, result };
        }
        // The conversation moved past this tool call without answering it here.
        this.dropThread(connection, thread);
        continue;
      }

      let fromIndex = known;
      if (thread.state === "idle") {
        // Codex already holds its own reply; skip BAKED's copy of it.
        if (request.conversation[fromIndex]?.role !== "assistant") continue;
        fromIndex += 1;
      }
      if (fromIndex >= request.keys.length) continue;
      if (request.conversation.slice(fromIndex).some((message) => message.role === "assistant"))
        continue;
      if (!best || (best.kind === "turn" && fromIndex > best.fromIndex)) {
        best = { kind: "turn", thread, fromIndex };
      }
    }
    if (best) best.thread.state = "running";
    return best;
  }

  private async getConnection(): Promise<CodexAppServerConnection> {
    if (this.connection) {
      const existing = await this.connection;
      if (!existing.closed) return existing;
      this.connection = null;
      this.threads = [];
    }
    const pending = this.connect();
    this.connection = pending;
    try {
      const connection = await pending;
      connection.onNotification((method, params) => this.onNotification(method, params));
      connection.onServerRequest((method, id, params) =>
        this.onServerRequest(connection, method, id, params),
      );
      connection.onClose((error) => {
        if (this.connection !== pending) return;
        this.connection = null;
        for (const thread of this.threads) this.failStep(thread, error);
        this.threads = [];
      });
      return connection;
    } catch (error) {
      this.connection = null;
      throw error;
    }
  }

  private async startThread(
    connection: CodexAppServerConnection,
    request: CodexNativeRequest,
  ): Promise<NativeThread> {
    const result = (await connection.request("thread/start", {
      model: request.modelId,
      cwd: getCwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: request.instructions,
      config: CODEX_ADAPTER_CONFIG,
      dynamicTools: request.dynamicTools,
    })) as { thread?: { id?: unknown } } | undefined;
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string") throw new Error("Codex app-server returned no thread id");

    const thread: NativeThread = {
      threadId,
      modelId: request.modelId,
      instructions: request.instructions,
      toolsKey: JSON.stringify(request.dynamicTools),
      keys: [],
      state: "running",
      turnId: null,
      pending: null,
      sink: null,
      totals: { ...ZERO_TOTALS },
      lastUsed: Date.now(),
    };
    this.threads.push(thread);
    this.evictIdleThreads(connection);
    return thread;
  }

  private startTurn(
    connection: CodexAppServerConnection,
    thread: NativeThread,
    request: CodexNativeRequest,
    fromIndex: number,
  ): void {
    const messages = request.conversation.slice(fromIndex);
    const text = renderCodexNativeInput(
      messages.length > 0
        ? messages
        : [{ role: "user", content: [{ type: "text", text: "Begin." }] }],
      request.stepNote,
    );
    // Images of the messages this turn sends; earlier ones are already in the thread.
    const images = promptImages(messages).map((image) => ({
      type: "image" as const,
      url: imageUrl(image),
    }));
    connection
      .request("turn/start", {
        threadId: thread.threadId,
        input: [{ type: "text", text, text_elements: [] }, ...images],
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      })
      .then((result) => {
        const id = (result as { turn?: { id?: unknown } } | undefined)?.turn?.id;
        if (typeof id === "string" && !thread.turnId) thread.turnId = id;
      })
      .catch((error: unknown) => {
        this.failStep(thread, error instanceof Error ? error : new Error(String(error)));
        this.dropThread(connection, thread);
      });
  }

  private onServerRequest(
    connection: CodexAppServerConnection,
    method: string,
    id: string | number,
    rawParams: unknown,
  ): boolean {
    if (method !== "item/tool/call") return false;
    const params = (rawParams ?? {}) as {
      threadId?: unknown;
      turnId?: unknown;
      callId?: unknown;
      tool?: unknown;
      arguments?: unknown;
    };
    const thread = this.threads.find((candidate) => candidate.threadId === params.threadId);
    if (!thread) return false;
    if (typeof params.turnId === "string") thread.turnId = params.turnId;
    const sink = thread.sink;
    if (!sink || typeof params.callId !== "string" || typeof params.tool !== "string") {
      connection.respondError(id, "baked is not waiting for a tool call on this thread");
      thread.state = "broken";
      return true;
    }
    this.closeOpenParts(sink);
    sink.controller.enqueue({
      type: "tool-call",
      toolCallId: params.callId,
      toolName: params.tool,
      input: JSON.stringify(params.arguments ?? {}),
    });
    thread.pending = { callId: params.callId, requestId: id };
    this.finishStep(thread, "tool-calls");
    thread.state = "suspended";
    return true;
  }

  private onNotification(method: string, rawParams: unknown): void {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const thread = this.threads.find((candidate) => candidate.threadId === params.threadId);
    if (!thread) return;
    if (typeof params.turnId === "string" && method !== "turn/completed") {
      thread.turnId = params.turnId;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage as { total?: unknown } | undefined;
      const totals = readTotals(usage?.total);
      if (totals) thread.totals = totals;
      return;
    }

    const sink = thread.sink;
    if (method === "turn/completed") {
      const turn = params.turn as
        | { status?: string; error?: { message?: unknown } | null }
        | undefined;
      thread.turnId = null;
      if (!sink) {
        thread.state = "broken";
        return;
      }
      if (turn?.status === "completed") {
        this.closeOpenParts(sink);
        this.finishStep(thread, "stop");
        thread.state = "idle";
        return;
      }
      const message =
        typeof turn?.error?.message === "string"
          ? turn.error.message
          : (sink.lastError ?? `Codex turn ${turn?.status ?? "failed"}`);
      this.failStep(thread, new Error(message));
      thread.state = "broken";
      return;
    }

    if (!sink) return;
    const { controller } = sink;
    if (method === "item/agentMessage/delta") {
      const itemId = String(params.itemId ?? "");
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) return;
      let id = sink.openText.get(itemId);
      if (!id) {
        id = `codex-text-${randomUUID()}`;
        sink.openText.set(itemId, id);
        controller.enqueue({ type: "text-start", id });
      }
      sink.streamed.add(itemId);
      controller.enqueue({ type: "text-delta", id, delta });
    } else if (method === "item/reasoning/summaryTextDelta") {
      const itemId = String(params.itemId ?? "");
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) return;
      let id = sink.openReasoning.get(itemId);
      if (!id) {
        id = `codex-reasoning-${randomUUID()}`;
        sink.openReasoning.set(itemId, id);
        controller.enqueue({ type: "reasoning-start", id });
      }
      controller.enqueue({ type: "reasoning-delta", id, delta });
    } else if (method === "item/completed") {
      const item = params.item as { type?: string; id?: unknown; text?: unknown } | undefined;
      const itemId = String(item?.id ?? "");
      if (item?.type === "agentMessage") {
        const id = sink.openText.get(itemId);
        if (id) {
          controller.enqueue({ type: "text-end", id });
          sink.openText.delete(itemId);
        } else if (!sink.streamed.has(itemId) && typeof item.text === "string" && item.text) {
          const fullId = `codex-text-${randomUUID()}`;
          controller.enqueue({ type: "text-start", id: fullId });
          controller.enqueue({ type: "text-delta", id: fullId, delta: item.text });
          controller.enqueue({ type: "text-end", id: fullId });
        }
      } else if (item?.type === "reasoning") {
        const id = sink.openReasoning.get(itemId);
        if (id) {
          controller.enqueue({ type: "reasoning-end", id });
          sink.openReasoning.delete(itemId);
        }
      }
    } else if (method === "error") {
      const error = params.error as { message?: unknown } | undefined;
      if (params.willRetry !== true && typeof error?.message === "string") {
        sink.lastError = error.message;
      }
    }
  }

  private closeOpenParts(sink: StepSink): void {
    for (const id of sink.openReasoning.values()) {
      sink.controller.enqueue({ type: "reasoning-end", id });
    }
    for (const id of sink.openText.values()) sink.controller.enqueue({ type: "text-end", id });
    sink.openReasoning.clear();
    sink.openText.clear();
  }

  private finishStep(thread: NativeThread, finishReason: LanguageModelV2FinishReason): void {
    const sink = thread.sink;
    if (!sink) return;
    thread.sink = null;
    sink.controller.enqueue({
      type: "finish",
      finishReason,
      usage: usageBetween(sink.startTotals, thread.totals),
    });
    sink.controller.close();
  }

  private failStep(thread: NativeThread, error: Error): void {
    const sink = thread.sink;
    if (!sink) return;
    thread.sink = null;
    sink.controller.error(error);
  }

  private abort(
    connection: CodexAppServerConnection,
    thread: NativeThread,
    sink: StepSink,
    signal: AbortSignal | undefined,
  ): void {
    // Only the step this signal belongs to; a later step on the thread is not affected.
    if (thread.sink !== sink) return;
    this.failStep(thread, abortError(signal));
    this.dropThread(connection, thread);
  }

  private dropThread(connection: CodexAppServerConnection, thread: NativeThread): void {
    this.threads = this.threads.filter((candidate) => candidate !== thread);
    thread.state = "broken";
    if (thread.pending) {
      connection.respondError(thread.pending.requestId, "baked abandoned this tool call");
      thread.pending = null;
    }
    const { threadId, turnId } = thread;
    if (turnId) void connection.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    void connection.request("thread/unsubscribe", { threadId }).catch(() => {});
  }

  private evictIdleThreads(connection: CodexAppServerConnection): void {
    while (this.threads.length > MAX_THREADS) {
      const idle = this.threads
        .filter((thread) => thread.state !== "running")
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return;
      this.dropThread(connection, idle);
    }
  }
}

async function collectStep(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const content: LanguageModelV2Content[] = [];
  const texts = new Map<string, { type: "text" | "reasoning"; text: string }>();
  let finishReason: LanguageModelV2FinishReason = "unknown";
  let usage: LanguageModelV2Usage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "text-start" || value.type === "reasoning-start") {
      const part = { type: value.type === "text-start" ? "text" : "reasoning", text: "" } as const;
      const entry = { ...part };
      texts.set(value.id, entry);
      content.push(entry as LanguageModelV2Content);
    } else if (value.type === "text-delta" || value.type === "reasoning-delta") {
      const entry = texts.get(value.id);
      if (entry) entry.text += value.delta;
    } else if (value.type === "tool-call") {
      content.push(value);
    } else if (value.type === "finish") {
      finishReason = value.finishReason;
      usage = value.usage;
    }
  }
  return { content, finishReason, usage };
}

/**
 * The Codex model over app-server with native tool calls and streaming; falls
 * back to `fallback` (one `codex exec` per step) when app-server cannot serve a call.
 */
export function createCodexNativeLanguageModel(
  modelId: string,
  sessions: CodexAppServerSessions,
  fallback: LanguageModelV2,
): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "codex",
    modelId,
    supportedUrls: {},
    async doStream(options) {
      const stream = await sessions.openStep(
        buildCodexNativeRequest(modelId, options),
        options.abortSignal,
      );
      if (!stream) return fallback.doStream(options);
      const warnings = collectWarnings(options);
      if (warnings.length === 0) return { stream };
      return {
        stream: stream.pipeThrough(
          new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
            transform(part, controller) {
              controller.enqueue(part.type === "stream-start" ? { ...part, warnings } : part);
            },
          }),
        ),
      };
    },
    async doGenerate(options) {
      const stream = await sessions.openStep(
        buildCodexNativeRequest(modelId, options),
        options.abortSignal,
      );
      if (!stream) return fallback.doGenerate(options);
      const result = await collectStep(stream);
      return { ...result, warnings: collectWarnings(options) };
    },
  };
}

let defaultSessions: CodexAppServerSessions | null = null;

export function getDefaultCodexSessions(): CodexAppServerSessions {
  defaultSessions ??= new CodexAppServerSessions();
  return defaultSessions;
}
