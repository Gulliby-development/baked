import { createHash, randomUUID } from "node:crypto";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider";
import { getCwd } from "../../../cwd.js";
import { providerCallDetail } from "../../provider-health.js";
import { cliReasoningEffort } from "../cli-effort.js";
import { imageUrl, promptImages } from "../prompt-images.js";
import { type CodexAppServerConnection, startCodexAppServerSession } from "./client.js";
import {
  codexAdapterConfig,
  codexRecovery,
  codexWebSearch,
  collectWarnings,
  getFunctionTools,
  renderMessageContent,
  renderToolResult,
  type ToolResultPromptPart,
} from "./runner.js";
import { tracedConnection } from "./trace.js";

type PromptMessage = LanguageModelV2Prompt[number];

/** Threads kept per process; the least recently used idle thread is dropped beyond this. */
const MAX_THREADS = 16;
/** How long a completed turn waits for a usage report that Codex sends after turn/completed. */
const LATE_USAGE_WAIT_MS = 500;
/** How long a dropped thread is listened to when Codex never confirms that its turn ended. */
const RETIRED_THREAD_MS = 120_000;
/** The app-server refuses a turn input or tool result above this many characters (`input_too_large`). */
export const CODEX_MAX_INPUT_CHARS = 1_048_576;
/** What one input may use; the rest is headroom for what the app-server wraps around it. */
const INPUT_BUDGET = Math.floor(CODEX_MAX_INPUT_CHARS * 0.9);
/** A tool result shrunk to fit keeps at least this much of its head and tail. */
const MIN_RESULT_CHARS = 4_000;

const ADAPTER_PREAMBLE = [
  "You are the language model behind baked, a coding agent that runs on the user's machine.",
  "Follow the baked instructions below. Call the function tools baked provides when they help; baked runs them and returns the result.",
  "Never use Codex built-in tools such as apply_patch or a shell of your own: only the baked tools are connected to the user's workspace.",
  "Change files only with baked's edit tools. A read-only sandbox refusal comes from a Codex tool, never from baked's tools, and is no reason to stop.",
].join("\n");

/** Added to the preamble when the call turns Codex's web search on (#1239). */
const WEB_SEARCH_NOTE =
  "Codex's web search is available: use it to check current library documentation, API signatures and versions instead of guessing them.";

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
  /** Codex's own web search is on for the thread (`providerOptions.codex.webSearch`, #1239). */
  webSearch?: boolean;
  /** Start a new thread instead of continuing one (`providerOptions.codex.freshThread`, #1877). */
  freshThread?: boolean;
}

/**
 * A message's identity for matching, without per-step provider options such as cache markers.
 * A tool message is its calls' ids and tool names: the workflow step budget later replaces an old
 * tool output with a stub, which the thread does not need since Codex already holds the full
 * output; keyed by content, every compacted step would replay the conversation on a new thread
 * (#863).
 */
function messageKey(message: PromptMessage): string {
  if (message.role === "tool" && typeof message.content !== "string")
    return JSON.stringify({
      role: "tool",
      results: message.content.map((part) =>
        part.type === "tool-result" ? [part.toolCallId, part.toolName] : part.type,
      ),
    });
  return JSON.stringify(message, (key, value) => (key === "providerOptions" ? undefined : value));
}

/** What fixes a stage's calls apart from the model: its base instructions and tool list. */
function requestShape(request: CodexNativeRequest): string {
  return createHash("sha256")
    .update(request.instructions)
    .update("\0")
    .update(JSON.stringify(request.dynamicTools))
    .digest("hex");
}

/** The caller's first-response deadline ended the call (`withProviderHealth`), not a cancel. */
function firstByteStall(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason as { name?: unknown } | undefined;
  return reason?.name === "ProviderUnreachableError";
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
  const webSearch = codexWebSearch(options.providerOptions);
  const { freshThread } = codexRecovery(options.providerOptions);
  return {
    modelId,
    ...(effort ? { effort } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(freshThread ? { freshThread } : {}),
    instructions: [
      webSearch ? `${ADAPTER_PREAMBLE}\n${WEB_SEARCH_NOTE}` : ADAPTER_PREAMBLE,
      ...system,
    ].join("\n\n"),
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

/**
 * `text` cut in the middle to at most `limit` characters, with a note of what was left out: an
 * input above the app-server's limit fails the turn, and every restart repeated it (#997).
 */
export function boundInputText(text: string, limit = INPUT_BUDGET): string {
  if (text.length <= limit) return text;
  const note = `\n\n[${text.length - limit} characters elided: the input exceeded the ${CODEX_MAX_INPUT_CHARS}-character limit of the model's input. Ask for a narrower range or a shorter output if the elided part is needed.]\n\n`;
  const keep = Math.max(0, limit - note.length);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${note}${text.slice(text.length - (keep - head))}`;
}

/**
 * A turn's input within `limit`: tool results are shrunk oldest first, then the whole text is
 * cut if the rest alone is too large.
 */
export function boundCodexNativeInput(
  messages: PromptMessage[],
  stepNote: string,
  limit = INPUT_BUDGET,
): string {
  let text = renderCodexNativeInput(messages, stepNote);
  let current = messages;
  for (const [index, message] of messages.entries()) {
    if (text.length <= limit) return text;
    if (message.role !== "tool") continue;
    let excess = text.length - limit;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const rendered = renderToolResult(part);
      if (excess <= 0 || rendered.length <= MIN_RESULT_CHARS) return part;
      const value = boundInputText(rendered, Math.max(MIN_RESULT_CHARS, rendered.length - excess));
      excess -= rendered.length - value.length;
      return { ...part, output: { type: "text" as const, value } };
    });
    current = current.map((m, i) => (i === index ? { ...message, content } : m));
    text = renderCodexNativeInput(current, stepNote);
  }
  return boundInputText(text, limit);
}

interface StepSink {
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>;
  startTotals: TokenTotals;
  openText: Map<string, string>;
  openReasoning: Map<string, string>;
  /** Item ids of agent messages whose text was streamed as deltas. */
  streamed: Set<string>;
  lastError: string | null;
  /** Model responses whose usage Codex reported during this step. */
  responses: number;
  /** Set while a completed turn waits for its late usage report before the step finishes. */
  usageWait: ReturnType<typeof setTimeout> | null;
  /** Responses of dropped threads whose usage Codex will never report (see `abandoned`). */
  unreported: number;
  /** Queries of the web searches Codex ran during this step. */
  webSearches: string[];
  /** The connection's count of unparsed output lines when this step started (#1956). */
  unparsedBefore: number;
}

interface NativeThread {
  threadId: string;
  modelId: string;
  instructions: string;
  toolsKey: string;
  /** The thread was started with Codex's web search on; a thread never changes it. */
  webSearch: boolean;
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
  /** The step that ended at the pending tool call; its abort signal releases the thread. */
  suspendedBy: StepSink | null;
  totals: TokenTotals;
  /**
   * Totals already reported by finished steps. The next step starts from here, so usage that
   * arrives between steps is reported by the next step instead of being lost.
   */
  billed: TokenTotals;
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

function addUsage(usage: LanguageModelV2Usage, late: TokenTotals): LanguageModelV2Usage {
  const inputTokens = (usage.inputTokens ?? 0) + late.inputTokens;
  const outputTokens = (usage.outputTokens ?? 0) + late.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reasoningTokens: (usage.reasoningTokens ?? 0) + late.reasoningOutputTokens,
    cachedInputTokens: (usage.cachedInputTokens ?? 0) + late.cachedInputTokens,
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

/** Text-only user messages; a message with an image cannot ride in a tool result. */
function plainUserMessages(messages: PromptMessage[]): boolean {
  return messages.every(
    (message) =>
      message.role === "user" &&
      (typeof message.content === "string" ||
        message.content.every((part) => part.type === "text")),
  );
}

type Plan =
  | {
      kind: "resume";
      thread: NativeThread;
      result: ToolResultPromptPart;
      /** User messages BAKED appended after the tool result, such as a step reminder. */
      appended: PromptMessage[];
    }
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
  /**
   * Model responses on threads dropped while a tool call waited: Codex reports a response's usage
   * only once its tool call is answered, so these are never reported. The next step to start
   * carries the count as `unreportedResponses`, so the usage it misses is visible (#820).
   */
  private abandoned = 0;
  /**
   * Threads BAKED dropped, until Codex confirms their turn ended. Their late usage reports and
   * the requests their model still makes are handled here instead of being lost (#863).
   */
  private retired = new Map<string, NativeThread>();
  /**
   * Request shapes (base instructions and tools, so one stage's profile on any model) whose call
   * got no first byte on app-server: their later calls in this process run on `codex exec`, while
   * other stages keep their threads. In bench round 58 the call answering a refused submission
   * of wheeltags' specify got no byte in 8 of 8 attempts on app-server, on astra and sol, and
   * the same stage completed in one 126 s call on exec (#1876).
   */
  private stalled = new Set<string>();
  /** Usage dropped threads reported after BAKED left them; the next step to finish carries it. */
  private late: TokenTotals = { ...ZERO_TOTALS };
  private lateReports = 0;

  constructor(
    private readonly connect: () => Promise<CodexAppServerConnection> = async () => {
      const connection = await startCodexAppServerSession({
        experimentalApi: true,
        isolated: true,
      });
      const trace = process.env.BAKED_CODEX_TRACE;
      return trace ? tracedConnection(connection, trace) : connection;
    },
  ) {}

  /** Opens a streaming step, or returns null when app-server cannot serve it. */
  async openStep(
    request: CodexNativeRequest,
    abortSignal?: AbortSignal,
  ): Promise<ReadableStream<LanguageModelV2StreamPart> | null> {
    if (this.unavailable) return null;
    abortSignal?.throwIfAborted();
    const shape = requestShape(request);
    if (this.stalled.has(shape)) return null;

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
    providerCallDetail(abortSignal, { transport: "app-server", resumed: plan.kind === "resume" });
    let stepSink: StepSink | null = null;
    return new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] });
        const sink: StepSink = {
          controller,
          startTotals: thread.billed,
          openText: new Map(),
          openReasoning: new Map(),
          streamed: new Set(),
          lastError: null,
          responses: 0,
          usageWait: null,
          unreported: this.abandoned,
          webSearches: [],
          unparsedBefore: connection.unparsed?.count ?? 0,
        };
        this.abandoned = 0;
        thread.sink = sink;
        stepSink = sink;
        thread.keys = request.keys;
        abortSignal?.addEventListener(
          "abort",
          () => {
            // After its step finished the signal still releases a thread left waiting at that
            // step's tool call: the caller is done and nothing will answer it.
            if (thread.state === "suspended" && thread.suspendedBy === sink)
              this.dropThread(connection, thread);
            else {
              if (thread.sink === sink && firstByteStall(abortSignal)) this.stalled.add(shape);
              this.abort(connection, thread, sink, abortSignal);
            }
          },
          { once: true },
        );
        if (startedPlan.kind === "resume") {
          const pending = thread.pending;
          thread.pending = null;
          if (!pending) return;
          const output = startedPlan.result.output;
          // Messages BAKED appended after the result ride along with it; a new turn would need the
          // pending call dropped, and with it the thread and the response's usage report (#820).
          const appended = startedPlan.appended.length
            ? [{ type: "inputText", text: boundCodexNativeInput(startedPlan.appended, "") }]
            : [];
          const room = INPUT_BUDGET - (appended[0]?.text.length ?? 0);
          connection.respond(pending.requestId, {
            contentItems: [
              {
                type: "inputText",
                text: boundInputText(
                  renderToolResult(startedPlan.result),
                  Math.max(MIN_RESULT_CHARS, room),
                ),
              },
              ...appended,
            ],
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
    this.retired.clear();
    void pending?.then((connection) => connection.close()).catch(() => {});
  }

  private plan(connection: CodexAppServerConnection, request: CodexNativeRequest): Plan | null {
    const toolsKey = JSON.stringify(request.dynamicTools);
    let best: Plan | null = null;
    for (const thread of [...this.threads]) {
      if (thread.modelId !== request.modelId || thread.instructions !== request.instructions)
        continue;
      // A stalled call's recovery runs each step on a new thread: the thread this conversation
      // would continue, suspended at a tool call or idle, is dropped instead (#1877).
      if (request.freshThread) {
        if (
          thread.state !== "running" &&
          thread.keys.every((key, index) => key === request.keys[index])
        )
          this.dropThread(connection, thread);
        continue;
      }
      if (thread.toolsKey !== toolsKey || thread.webSearch !== (request.webSearch === true))
        continue;
      if (thread.state === "running" || thread.state === "broken") continue;
      const known = thread.keys.length;
      if (known > request.keys.length) continue;
      if (!thread.keys.every((key, index) => key === request.keys[index])) continue;

      if (thread.state === "suspended") {
        const pending = thread.pending;
        const result = pending
          ? toolResultFor(request.conversation[known + 1], pending.callId)
          : null;
        const appended = request.conversation.slice(known + 2);
        if (
          pending &&
          result &&
          request.keys.length >= known + 2 &&
          plainUserMessages(appended) &&
          hasToolCall(request.conversation[known], pending.callId)
        ) {
          thread.state = "running";
          return { kind: "resume", thread, result, appended };
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
        this.retired.clear();
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
      config: codexAdapterConfig(request.webSearch === true),
      dynamicTools: request.dynamicTools,
    })) as { thread?: { id?: unknown } } | undefined;
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string") throw new Error("Codex app-server returned no thread id");

    const thread: NativeThread = {
      threadId,
      modelId: request.modelId,
      instructions: request.instructions,
      toolsKey: JSON.stringify(request.dynamicTools),
      webSearch: request.webSearch === true,
      keys: [],
      state: "running",
      turnId: null,
      pending: null,
      sink: null,
      suspendedBy: null,
      totals: { ...ZERO_TOTALS },
      billed: { ...ZERO_TOTALS },
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
    const text = boundCodexNativeInput(
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
    const retired = this.retired.get(String(params.threadId));
    if (retired) {
      // The model of a dropped thread is still running: stop its turn again rather than answer
      // with an error it would retry, at the cost of another model request each time.
      connection.respondError(id, "baked left this thread");
      const turnId = typeof params.turnId === "string" ? params.turnId : retired.turnId;
      if (turnId)
        void connection
          .request("turn/interrupt", { threadId: retired.threadId, turnId })
          .catch(() => {});
      return true;
    }
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
    thread.suspendedBy = sink;
    this.finishStep(thread, "tool-calls");
    thread.state = "suspended";
    return true;
  }

  private onNotification(method: string, rawParams: unknown): void {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const retired = this.retired.get(String(params.threadId));
    if (retired) {
      this.onRetiredNotification(retired, method, params);
      return;
    }
    const thread = this.threads.find((candidate) => candidate.threadId === params.threadId);
    if (!thread) return;
    if (typeof params.turnId === "string" && method !== "turn/completed") {
      thread.turnId = params.turnId;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage as { total?: unknown } | undefined;
      const totals = readTotals(usage?.total);
      if (totals) thread.totals = totals;
      if (thread.sink) {
        thread.sink.responses += 1;
        if (thread.sink.usageWait) this.finishTurn(thread);
      }
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
        // Codex can send the turn's last usage report after turn/completed. A step that has seen
        // none waits briefly for it, so its response is not recorded as zero tokens (#364).
        if (sink.responses === 0) {
          sink.usageWait = setTimeout(() => this.finishTurn(thread), LATE_USAGE_WAIT_MS);
          return;
        }
        this.finishTurn(thread);
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
      const item = params.item as
        | { type?: string; id?: unknown; text?: unknown; query?: unknown }
        | undefined;
      const itemId = String(item?.id ?? "");
      if (item?.type === "webSearch") {
        sink.webSearches.push(typeof item.query === "string" ? item.query : "");
      } else if (item?.type === "agentMessage") {
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

  private onRetiredNotification(
    thread: NativeThread,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage as { total?: unknown } | undefined;
      const totals = readTotals(usage?.total);
      if (!totals) return;
      for (const key of Object.keys(ZERO_TOTALS) as (keyof TokenTotals)[])
        this.late[key] += Math.max(0, totals[key] - thread.totals[key]);
      thread.totals = totals;
      this.lateReports += 1;
      return;
    }
    if (method === "turn/completed") this.forget(thread);
  }

  /** Stops listening to a dropped thread once its turn has ended. */
  private forget(thread: NativeThread): void {
    if (!this.retired.delete(thread.threadId)) return;
    void this.connection
      ?.then((connection) =>
        connection.request("thread/unsubscribe", { threadId: thread.threadId }),
      )
      .catch(() => {});
  }

  private closeOpenParts(sink: StepSink): void {
    for (const id of sink.openReasoning.values()) {
      sink.controller.enqueue({ type: "reasoning-end", id });
    }
    for (const id of sink.openText.values()) sink.controller.enqueue({ type: "text-end", id });
    sink.openReasoning.clear();
    sink.openText.clear();
  }

  private finishTurn(thread: NativeThread): void {
    this.finishStep(thread, "stop");
    thread.state = "idle";
  }

  private finishStep(thread: NativeThread, finishReason: LanguageModelV2FinishReason): void {
    const sink = thread.sink;
    if (!sink) return;
    thread.sink = null;
    if (sink.usageWait) clearTimeout(sink.usageWait);
    thread.billed = thread.totals;
    const usage = usageBetween(sink.startTotals, thread.totals);
    const late = this.late;
    const lateReports = this.lateReports;
    this.late = { ...ZERO_TOTALS };
    this.lateReports = 0;
    sink.controller.enqueue({
      type: "finish",
      finishReason,
      // Usage of threads BAKED already left counts here, so a run's total matches what Codex
      // reported; the step that happens to finish next carries it.
      usage: lateReports ? addUsage(usage, late) : usage,
      // Codex reports a response's usage only once the tool call it made has been answered, so a
      // step reports the usage that arrived while it ran: the previous step's response, plus its
      // own when it ends the turn. `responses` counts those reports, so totals over a run show how
      // many model requests it cost.
      providerMetadata: {
        codex: {
          responses: sink.responses,
          ...(sink.unreported ? { unreportedResponses: sink.unreported } : {}),
          ...(lateReports ? { lateResponses: lateReports } : {}),
          ...(sink.webSearches.length
            ? { webSearches: sink.webSearches.length, webSearchQueries: sink.webSearches }
            : {}),
        },
      },
    });
    sink.controller.close();
  }

  private failStep(thread: NativeThread, error: Error): void {
    const sink = thread.sink;
    if (!sink) return;
    // The turn already completed and only its usage report is missing: the step still succeeds.
    if (sink.usageWait) {
      this.finishTurn(thread);
      return;
    }
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
    const error = abortError(signal);
    // A line the client could not parse may have been this step's answer or tool call (#1956).
    const note = connection.unparsed?.note(sink.unparsedBefore) ?? "";
    if (note && firstByteStall(signal)) error.message += note;
    this.failStep(thread, error);
    this.dropThread(connection, thread);
  }

  private dropThread(connection: CodexAppServerConnection, thread: NativeThread): void {
    this.threads = this.threads.filter((candidate) => candidate !== thread);
    thread.state = "broken";
    thread.suspendedBy = null;
    const { threadId, turnId } = thread;
    if (!turnId) {
      void connection.request("thread/unsubscribe", { threadId }).catch(() => {});
      if (thread.pending) {
        connection.respondError(thread.pending.requestId, "baked abandoned this tool call");
        thread.pending = null;
        this.abandoned += 1;
      }
      return;
    }
    // The turn is interrupted before the pending call is answered, so the model has no answer to
    // continue from. The thread stays subscribed until Codex reports the turn ended, so a late
    // usage report is still counted and a further request from its model is stopped (#863).
    this.retired.set(threadId, thread);
    setTimeout(() => this.forget(thread), RETIRED_THREAD_MS).unref?.();
    const interrupt = () => connection.request("turn/interrupt", { threadId, turnId });
    // A failed interrupt is tried once more; a turn left running keeps calling the model.
    void interrupt()
      .catch(() => interrupt())
      .catch(() => {});
    if (thread.pending) {
      connection.respondError(thread.pending.requestId, "baked abandoned this tool call");
      thread.pending = null;
      this.abandoned += 1;
    }
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
  let providerMetadata: SharedV2ProviderMetadata | undefined;
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
      providerMetadata = value.providerMetadata;
    }
  }
  return { content, finishReason, usage, ...(providerMetadata ? { providerMetadata } : {}) };
}

/**
 * The Codex model over app-server with native tool calls and streaming; falls
 * back to `fallback` (one `codex exec` per step) when app-server cannot serve a call,
 * and uses it at once for a call whose recovery asks for the exec transport (#1877).
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
      if (codexRecovery(options.providerOptions).exec) return fallback.doStream(options);
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
      if (codexRecovery(options.providerOptions).exec) return fallback.doGenerate(options);
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
