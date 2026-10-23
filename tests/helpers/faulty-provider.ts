import { spyOn } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { anthropic } from "../../src/core/llm/providers/anthropic.js";
import { createClaudeCodeLanguageModel } from "../../src/core/llm/providers/claude-code/index.js";
import { createCodexLanguageModel } from "../../src/core/llm/providers/codex/runner.js";
import { copilot } from "../../src/core/llm/providers/copilot.js";
import { githubModels } from "../../src/core/llm/providers/github-models.js";
import { openai } from "../../src/core/llm/providers/openai.js";
import { corpusCallProfile } from "../../src/core/workflows/trace.js";

/**
 * Fault injection for provider adapters (#1719), in the manner of Toxiproxy: the real adapter of
 * each provider runs against a transport that misbehaves on purpose. HTTP providers get a fake
 * `fetch` that speaks their wire protocol (Anthropic Messages, OpenAI Responses, OpenAI Chat
 * Completions); CLI providers get a fake runner in place of the spawned CLI.
 */
export const FAULT_PROVIDERS = [
  "anthropic",
  "claude-code",
  "codex",
  "openai",
  "copilot",
  "github-models",
] as const;
export type FaultProvider = (typeof FAULT_PROVIDERS)[number];

/**
 * The slowest healthy first byte of bench round 50 (#1639): a multi-step plan attempt at maximum
 * effort answered after 502 seconds of silence. Traces before round 52 keep no per-call timing
 * for multi-step attempts, so the corpus cannot show it yet; it stays a floor under the corpus.
 */
export const R50_P99_FIRST_BYTE_MS = 502_000;

/** The recorded rounds' calls (#1729): the fault profiles take their latencies from these. */
const TRACES = join(import.meta.dir, "..", "fixtures", "bench-traces");
export const CORPUS = corpusCallProfile(
  readdirSync(TRACES)
    .filter((round) => /^R\d+$/.test(round))
    .flatMap((round) =>
      readdirSync(join(TRACES, round))
        .filter((file) => file.endsWith(".sqlite.gz"))
        .map((file) => join(TRACES, round, file)),
    ),
);

/** The slowest healthy first byte the matrix waits for: the corpus's highest p99, or the R50 floor. */
export const SLOWEST_HEALTHY_FIRST_BYTE_MS = Math.max(
  R50_P99_FIRST_BYTE_MS,
  ...CORPUS.firstByte.map((shape) => shape.p99Ms),
);

const RECORDED_WAITS_S = Object.values(CORPUS.retryAfterMs)
  .flat()
  .map((ms) => Math.ceil(ms / 1000));
/** The longest rate-limit `retry-after` (an hour at most) of the recorded rounds; 7 s before any. */
export const RECORDED_RETRY_AFTER_S = Math.max(7, ...RECORDED_WAITS_S.filter((s) => s <= 3600));
/** Recorded `retry-after` waits over an hour: a usage limit, not a rate limit. */
export const RECORDED_LIMIT_WAITS_S = [...new Set(RECORDED_WAITS_S.filter((s) => s > 3600))];

export type Fault =
  /** Answers "OK" after `afterMs` of silence; a provider whose reasoning streams sends it meanwhile. */
  | { kind: "slow"; afterMs: number }
  /** Accepts the request and never answers. */
  | { kind: "hang" }
  /** Refuses with an HTTP status (CLI providers report it in their error text). */
  | { kind: "status"; status: 429 | 500 | 503 | 529; retryAfter?: string }
  /** Starts the answer, then the connection closes before it finishes. */
  | { kind: "cut" }
  /** Calls a tool with arguments that are not JSON. */
  | { kind: "malformed-tool" }
  /** Finishes without any content. */
  | { kind: "empty" }
  /**
   * Finishes and is billed with no answer the adapter can use (#1957): a CLI's `tool-calls` finish
   * with no tool call. HTTP providers end the same turn as an empty finish.
   */
  | { kind: "lost-answer" };

/** Providers whose reasoning reaches the stream as it thinks, so a slow answer is not silent. */
const STREAMS_REASONING = new Set<FaultProvider>(["anthropic"]);
const REASONING_EVERY_MS = 20_000;

export interface FaultyModel {
  model: LanguageModel;
  /** Model calls the transport received. */
  calls: () => number;
  restore: () => void;
}

const encoder = new TextEncoder();
type Event = { event?: string; data: unknown };
const sse = (events: Event[]): string =>
  events
    .map(
      ({ event, data }) =>
        `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");

/** The events of one answer in each wire protocol: `head` may stream while the model thinks. */
function answer(
  provider: FaultProvider,
  fault: Fault,
): { head: Event[]; thinking: Event | null; body: Event[]; tail: Event[] } {
  const usage = { input_tokens: 2, output_tokens: 3 };
  if (provider === "anthropic") {
    const block = (index: number, type: string, delta: Record<string, unknown>) => [
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: type === "text" ? { type, text: "" } : type === "thinking" ? { type, thinking: "" } : delta,
        },
      },
    ];
    const tool = fault.kind === "malformed-tool";
    return {
      head: [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_fault",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 2, output_tokens: 0 },
            },
          },
        },
        ...block(0, "thinking", {}),
      ],
      thinking: {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "." } },
      },
      body: [
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        ...((fault.kind === "empty" || fault.kind === "lost-answer")
          ? []
          : tool
            ? [
                ...block(1, "tool_use", { type: "tool_use", id: "toolu_1", name: "read", input: {} }),
                {
                  event: "content_block_delta",
                  data: {
                    type: "content_block_delta",
                    index: 1,
                    delta: { type: "input_json_delta", partial_json: '{"path": tests/' },
                  },
                },
                { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
              ]
            : [
                ...block(1, "text", {}),
                {
                  event: "content_block_delta",
                  data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
                },
              ]),
      ],
      tail: [
        ...((fault.kind === "empty" || fault.kind === "lost-answer") || tool
          ? []
          : [{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } }]),
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 3 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ],
    };
  }
  if (provider === "openai") {
    const response = { id: "resp_fault", object: "response", created_at: 1, model: "gpt-4o" };
    const tool = fault.kind === "malformed-tool";
    const item = tool
      ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" }
      : { type: "message", id: "msg_fault", role: "assistant", status: "in_progress", content: [] };
    return {
      head: [{ data: { type: "response.created", response: { ...response, status: "in_progress" } } }],
      thinking: null,
      body:
        (fault.kind === "empty" || fault.kind === "lost-answer")
          ? []
          : [
              { data: { type: "response.output_item.added", output_index: 0, item } },
              tool
                ? {
                    data: {
                      type: "response.function_call_arguments.delta",
                      item_id: "fc_1",
                      output_index: 0,
                      delta: '{"path": tests/',
                    },
                  }
                : {
                    data: {
                      type: "response.output_text.delta",
                      item_id: "msg_fault",
                      output_index: 0,
                      content_index: 0,
                      delta: "OK",
                      logprobs: [],
                    },
                  },
            ],
      tail: [
        ...((fault.kind === "empty" || fault.kind === "lost-answer")
          ? []
          : [
              {
                data: {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: tool
                    ? { ...item, arguments: '{"path": tests/', status: "completed" }
                    : {
                        ...item,
                        status: "completed",
                        content: [{ type: "output_text", text: "OK", annotations: [], logprobs: [] }],
                      },
                },
              },
            ]),
        {
          data: {
            type: "response.completed",
            response: {
              ...response,
              status: "completed",
              usage: {
                ...usage,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        },
      ],
    };
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra = {}) => ({
    data: {
      id: "chatcmpl-fault",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    },
  });
  const tool = fault.kind === "malformed-tool";
  return {
    head: [chunk({ role: "assistant", content: "" }, null)],
    thinking: null,
    body:
      (fault.kind === "empty" || fault.kind === "lost-answer")
        ? []
        : [
            tool
              ? chunk(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "read", arguments: '{"path": tests/' },
                      },
                    ],
                  },
                  null,
                )
              : chunk({ content: "OK" }, null),
          ],
    tail: [
      chunk({}, tool ? "tool_calls" : "stop", {
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
      { data: "[DONE]" },
    ],
  };
}

/** A streamed HTTP answer that misbehaves as `fault` says, on the fake clock's timers. */
function faultyResponse(provider: FaultProvider, fault: Fault, signal?: AbortSignal | null): Response | Promise<Response> {
  if (fault.kind === "hang")
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  if (fault.kind === "status")
    return Response.json(
      {
        type: "error",
        error: {
          type: fault.status === 429 ? "rate_limit_error" : "overloaded_error",
          message: fault.status === 429 ? "Rate limit reached for requests" : "Overloaded",
          code: fault.status === 429 ? "rate_limit_exceeded" : "server_error",
        },
      },
      {
        status: fault.status,
        headers: fault.retryAfter ? { "retry-after": fault.retryAfter } : {},
      },
    );
  const { head, thinking, body, tail } = answer(provider, fault);
  const afterMs = fault.kind === "slow" ? fault.afterMs : 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (events: Event[]) => controller.enqueue(encoder.encode(sse(events)));
      const finish = () => {
        send(body);
        // What Bun's fetch reports when the server closes a chunked body early, a second after the
        // answer started, so the partial answer has reached the adapter.
        if (fault.kind === "cut")
          timers.push(
            setTimeout(
              () =>
                controller.error(
                  Object.assign(
                    new TypeError(
                      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
                    ),
                    { code: "ECONNRESET" },
                  ),
                ),
              1000,
            ),
          );
        else {
          send(tail);
          controller.close();
        }
      };
      // A silent provider sends nothing at all until it answers, not even its stream header.
      if (thinking && STREAMS_REASONING.has(provider)) {
        send(head);
        for (let at = REASONING_EVERY_MS; at < afterMs; at += REASONING_EVERY_MS)
          timers.push(setTimeout(() => send([thinking]), at));
        timers.push(setTimeout(finish, afterMs));
      } else
        timers.push(
          setTimeout(() => {
            send(head);
            finish();
          }, afterMs),
        );
      signal?.addEventListener(
        "abort",
        () => {
          for (const timer of timers) clearTimeout(timer);
          controller.error(signal.reason);
        },
        { once: true },
      );
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** What each CLI says when its turn fails the way `fault` describes. */
function cliError(provider: "codex" | "claude-code", fault: Fault): Error | null {
  if (fault.kind === "status")
    return provider === "codex"
      ? new Error(
          fault.status === 429
            ? "exceeded retry limit, last status: 429 Too Many Requests"
            : `unexpected status ${fault.status}: Service Unavailable`,
        )
      : new Error(
          fault.status === 429
            ? 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}'
            : `API Error: ${fault.status} {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
        );
  if (fault.kind === "cut")
    return provider === "codex"
      ? new Error("Codex exec exited with signal SIGPIPE")
      : new Error("Claude Code exited with signal SIGPIPE");
  return null;
}

/** The structured answer each CLI returns for a fault that still answers. */
function cliAnswer(provider: "codex" | "claude-code", fault: Fault) {
  const toolCalls =
    fault.kind === "malformed-tool" ? [{ toolName: "read", inputJson: '{"path": tests/' }] : [];
  const reply = {
    text: fault.kind === "empty" || fault.kind === "lost-answer" || toolCalls.length ? "" : "OK",
    toolCalls,
    finishReason: toolCalls.length || fault.kind === "lost-answer" ? "tool-calls" : "stop",
  };
  return provider === "codex"
    ? { text: JSON.stringify(reply), usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
    : { structured: reply, text: reply.text, usage: { inputTokens: { total: 2 }, outputTokens: { total: 3 } } };
}

/** The real adapter of `provider`, wired to a transport that misbehaves as `fault` says. */
export function faultyModel(provider: FaultProvider, fault: Fault): FaultyModel {
  let calls = 0;
  if (provider === "codex" || provider === "claude-code") {
    const run = async (call: { abortSignal?: AbortSignal | undefined }) => {
      calls++;
      const signal = call.abortSignal;
      const wait = fault.kind === "hang" ? Number.POSITIVE_INFINITY : fault.kind === "slow" ? fault.afterMs : 0;
      if (wait > 0)
        await new Promise<void>((resolve, reject) => {
          const timer = Number.isFinite(wait) ? setTimeout(resolve, wait) : undefined;
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      const error = cliError(provider, fault);
      if (error) throw error;
      return cliAnswer(provider, fault);
    };
    const model =
      provider === "codex"
        ? createCodexLanguageModel("gpt-6-astra", { run: run as never })
        : createClaudeCodeLanguageModel("opus", { run: run as never });
    return { model: model as LanguageModel, calls: () => calls, restore: () => {} };
  }
  const definition = { anthropic, openai, copilot, "github-models": githubModels }[provider];
  const previous = process.env[definition.envVar];
  process.env[definition.envVar] = "fixture-token";
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("copilot_internal/v2/token"))
      return Response.json({ token: "fixture-bearer", expires_at: Date.now() / 1000 + 3600 });
    calls++;
    return faultyResponse(provider, fault, init?.signal);
  }) as typeof globalThis.fetch);
  const model = definition.createModel(provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o", {
    config: DEFAULT_CONFIG,
  }) as LanguageModel;
  return {
    model,
    calls: () => calls,
    restore: () => {
      fetch.mockRestore();
      if (previous === undefined) delete process.env[definition.envVar];
      else process.env[definition.envVar] = previous;
    },
  };
}
