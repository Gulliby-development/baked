import type { ReadableStreamDefaultReader } from "node:stream/web";
import type {
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { generateText, type LanguageModel, type LanguageModelUsage, wrapLanguageModel } from "ai";
import { executionClock, executionTimeout } from "../workflows/execution-clock.js";
import { lostAnswer } from "./provider-answer.js";

export const PROVIDER_FIRST_BYTE_MS = 60_000;
export const PROVIDER_BACKOFF_MAX_MS = 5 * 60_000;

/** CLI transports buffer all reasoning until a turn finishes, including native fallback. */
const BUFFERED_CLI = new Set(["codex", "claude-code"]);
const PLANNING_STAGES = ["spec", "plan", "task-graph"];

export interface CallReasoning {
  stage?: string | undefined;
  effort?: string | undefined;
  /** The call streams its reasoning as it thinks (an OpenAI reasoning summary). */
  streamsReasoning?: boolean | undefined;
}

/**
 * Whether a call may think silently for minutes before its first output (#1639, #1652). CLI
 * adapters buffer every turn. Any other model may too at high effort or on a planning stage,
 * unless its reasoning streams: Anthropic's thinking deltas, or an OpenAI reasoning summary.
 * An OpenAI Responses model at `xhigh` streams nothing while it thinks, since the summary is off
 * unless configured (`openaiReasoningSummary`).
 */
export function silentReasoning(provider: string, context: CallReasoning = {}): boolean {
  if (BUFFERED_CLI.has(provider)) return true;
  if (provider === "anthropic" || provider.startsWith("anthropic.") || context.streamsReasoning)
    return false;
  return (
    PLANNING_STAGES.includes(context.stage ?? "") ||
    ["high", "xhigh", "max"].includes(context.effort ?? "")
  );
}

/** The first-response deadline of a call: long for silent reasoning, 60 s otherwise. */
export function providerFirstByteMs(provider: string, context: CallReasoning = {}): number {
  if (!silentReasoning(provider, context)) return PROVIDER_FIRST_BYTE_MS;
  if (
    PLANNING_STAGES.includes(context.stage ?? "") ||
    ["xhigh", "max"].includes(context.effort ?? "")
  )
    return 10 * 60_000;
  return context.effort === "high" ? 7.5 * 60_000 : 5 * 60_000;
}

/** The shortest adaptive first-response deadline of a silent call (#1766). */
export const ADAPTIVE_FIRST_BYTE_FLOOR_MS = 3 * 60_000;
/** Healthy first responses of a call shape needed before its deadline adapts. */
export const ADAPTIVE_FIRST_BYTE_SAMPLES = 3;
const ADAPTIVE_FIRST_BYTE_FACTOR = 2;

/**
 * The first-response deadline of a call shape whose healthy first responses took `healthy`
 * milliseconds: twice their 95th percentile, between `ADAPTIVE_FIRST_BYTE_FLOOR_MS` and
 * `ceilingMs` (`providerFirstByteMs`). Until `ADAPTIVE_FIRST_BYTE_SAMPLES` calls answered it is the
 * ceiling. A flat 10 minutes for the slowest honest planning call hid a hung specify call on an
 * initiative's critical path for all of it, while the round's other specify calls answered in
 * 66 to 166 s (bench round 52, #1766).
 */
export function adaptiveFirstByteMs(
  ceilingMs: number,
  healthy: readonly (number | SizedFirstByte)[],
  promptChars?: number,
): number {
  return firstByteDeadline(ceilingMs, firstByteInputs(healthy), promptChars);
}

/**
 * What an adaptive first-response deadline is computed from, kept in the call's timing so a
 * replay decides the call from the same inputs (#2283): the executor's history also holds the
 * machine-wide shared answers (#1880) and the answers it was seeded with when its process started,
 * neither of which is in the run's database.
 */
export interface FirstByteInputs {
  /** The healthy answers of the call's shape the deadline was taken from. */
  samples: number;
  /** How many of them came from the machine-wide shared file (#1880). */
  shared?: number;
  /** Their 95th-percentile first response, when there were any. */
  p95Ms?: number;
  /** How many of them recorded a prompt size, and the 95th percentile of their pace (#2041). */
  paceSamples?: number;
  p95PaceMsPerChar?: number;
  /** A call of the shape ran out its adaptive deadline unanswered: the ceiling (#2193). */
  expired?: true;
}

/** The inputs `firstByteDeadline` takes from a shape's healthy answers. */
export function firstByteInputs(healthy: readonly (number | SizedFirstByte)[]): FirstByteInputs {
  if (!healthy.length) return { samples: 0 };
  // A call larger than the ones its shape answered gets their slowest pace per prompt character
  // times its own size: a silent call's first byte is its whole answer, which grows with its
  // input. Bench round 66 (nodepluck syntax): an analysis of 86 derivations met the 180 s floor
  // set by analyses of 34 to 56 (47 to 70 s), took 182 to 185 s and was cut off five times (#2041).
  const paces = healthy.flatMap((sample) =>
    typeof sample !== "number" && sample.chars && sample.chars > 0
      ? [sample.ms / sample.chars]
      : [],
  );
  return {
    samples: healthy.length,
    p95Ms: p95(healthy.map((sample) => (typeof sample === "number" ? sample : sample.ms))),
    ...(paces.length ? { paceSamples: paces.length, p95PaceMsPerChar: p95(paces) } : {}),
  };
}

/** `adaptiveFirstByteMs` from its recorded inputs (`firstByteInputs`). */
export function firstByteDeadline(
  ceilingMs: number,
  inputs: FirstByteInputs,
  promptChars?: number,
): number {
  if (
    inputs.expired ||
    ceilingMs <= ADAPTIVE_FIRST_BYTE_FLOOR_MS ||
    inputs.samples < ADAPTIVE_FIRST_BYTE_SAMPLES
  )
    return ceilingMs;
  let expected = inputs.p95Ms ?? 0;
  if (
    promptChars &&
    inputs.p95PaceMsPerChar !== undefined &&
    (inputs.paceSamples ?? 0) >= ADAPTIVE_FIRST_BYTE_SAMPLES
  )
    expected = Math.max(expected, inputs.p95PaceMsPerChar * promptChars);
  return Math.min(
    ceilingMs,
    Math.max(ADAPTIVE_FIRST_BYTE_FLOOR_MS, Math.ceil(ADAPTIVE_FIRST_BYTE_FACTOR * expected)),
  );
}

/** A healthy first response with the size of its call's prompt, when it was recorded (#2041). */
export interface SizedFirstByte {
  ms: number;
  chars?: number;
}

const p95 = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
};

/**
 * The size of a call's prompt in characters, the unit `adaptiveFirstByteMs` scales a deadline by.
 * Undefined when the prompt cannot be measured.
 */
export function promptChars(prompt: unknown): number | undefined {
  try {
    return JSON.stringify(prompt)?.length;
  } catch {
    return undefined;
  }
}

/**
 * The effort and reasoning summary a call sends. The options are keyed by the provider family
 * (`openai`), while the adapter names itself `openai.responses` or `openai.chat`.
 */
export function callReasoning(
  options: Record<string, Record<string, unknown> | undefined> | undefined,
): { effort?: string; streamsReasoning: boolean } {
  let effort: string | undefined;
  let streamsReasoning = false;
  for (const entry of Object.values(options ?? {})) {
    const sent = entry?.effort ?? entry?.reasoningEffort;
    if (effort === undefined && typeof sent === "string") effort = sent;
    const summary = entry?.reasoningSummary;
    if (typeof summary === "string" && summary !== "off") streamsReasoning = true;
  }
  return { ...(effort !== undefined ? { effort } : {}), streamsReasoning };
}

/**
 * One model call's timing and what its first-response deadline depends on, so a recorded run can
 * be replayed against a changed deadline (#1715). Times are execution time in milliseconds;
 * `firstByteMs` is null when no response came.
 */
export interface CallTiming extends CallReasoning {
  provider: string;
  firstByteMs: number | null;
  durationMs: number;
  /** The first-response deadline the call had, when it was not the provider's fixed one (#1766). */
  limitMs?: number;
  /**
   * What the adaptive deadline (`limitMs`) was computed from (`firstByteInputs`, #2283); absent
   * before #2283 and when the deadline was not adaptive.
   */
  deadlineInputs?: FirstByteInputs;
  /** The size of the call's prompt (`promptChars`), which the adaptive deadline scales by (#2041). */
  promptChars?: number;
  /**
   * The size in characters of each part of an implementer attempt's workflow context, on its first
   * call (`promptParts` in context.ts, #2470), so an oversized prompt says what it holds.
   */
  promptParts?: Record<string, number>;
  /** The HTTP status of a call the provider refused, and its `retry-after` header (#1729). */
  status?: number;
  retryAfter?: string;
  /** How an adapter with more than one transport served the call (`providerCallDetail`, #1876). */
  transport?: string;
  /** The call answered a tool call the model's open turn waited on, instead of starting a turn. */
  resumed?: boolean;
  /**
   * The wait before the first response of a call that answered, charged to active time; absent
   * for a call that ended without an answer, whose whole interval is excluded (#2414).
   */
  silentMs?: number;
}

export class ProviderUnreachableError extends Error {
  readonly code = "provider_unreachable";
  constructor(
    readonly modelId: string,
    message = "No model response within 60 seconds",
  ) {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

/** CLI adapters buffer their answer, but can report model traffic before the answer ends. */
const responses = new WeakMap<AbortSignal, () => void>();
export function providerResponded(signal?: AbortSignal): void {
  if (signal) responses.get(signal)?.();
}

/** What an adapter says about how it serves a call, kept with the call's timing (#1876). */
export type CallDetail = Pick<CallTiming, "transport" | "resumed">;
const details = new WeakMap<AbortSignal, (detail: CallDetail) => void>();
export function providerCallDetail(signal: AbortSignal | undefined, detail: CallDetail): void {
  if (signal) details.get(signal)?.(detail);
}

/** A dropped or refused connection, also when it is the cause of an SDK error (`APICallError`). */
export function connectionError(error: unknown): boolean {
  const info = error as { name?: string; message?: string; code?: string; cause?: unknown } | null;
  return (
    info?.name === "TimeoutError" ||
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(
      `${info?.code ?? ""} ${info?.message ?? ""}`,
    ) ||
    (info?.cause !== undefined && info.cause !== error && connectionError(info.cause))
  );
}

export interface ProviderWatch {
  /**
   * Tentatively withhold unanswered time. A real response charges it; an outage excludes it, and
   * so does a call that responded but ends without an answer (no output, no tool call: a deadline,
   * a watchdog, a cancel), settled `false` after its `true` (#2414). `silent` says the call may
   * reason silently (`silentReasoning`), so its quiet is not a stall.
   */
  pending?: (silent: boolean) => (responded: boolean) => void;
  progress?: () => void;
  firstByteMs?: number;
  /**
   * The deadline of a call whose fixed one (`providerFirstByteMs`) is `ceilingMs`, from what the
   * same call shape took before (`adaptiveFirstByteMs`, #1766). Unused when `firstByteMs` is set.
   * With its inputs, they are kept in the call's timing (`deadlineInputs`, #2283).
   */
  firstByteLimit?: (
    ceilingMs: number,
    call: CallReasoning & { provider: string; promptChars?: number },
  ) => number | { ms: number; inputs: FirstByteInputs };
  /** Output kind of the workflow profile, also used by continuations and format correction. */
  stage?: string;
  /** Called once per call when it ends, with its timing. */
  timing?: (call: CallTiming) => void;
}

/**
 * Workflow generation reads the provider stream so local stream-start/handshake messages cannot
 * hide a dead connection, and reasoning deltas keep a healthy long response alive. The SDK still
 * runs tools only after this complete response, as it does for ordinary generateText.
 */
export function withProviderHealth(
  model: LanguageModel,
  modelId: string,
  watch: ProviderWatch = {},
) {
  if (typeof model === "string") throw new Error("Provider health requires a resolved model");
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ model: adapted, params }) => {
        const controller = new AbortController();
        const signal = params.abortSignal
          ? AbortSignal.any([params.abortSignal, controller.signal])
          : controller.signal;
        signal.throwIfAborted();
        const reasoning = { stage: watch.stage, ...callReasoning(params.providerOptions) };
        const settle = watch.pending?.(silentReasoning(adapted.provider, reasoning));
        let responded = false;
        // Output or a tool call reached BAKED; an adapter's activity signal alone is no answer.
        let answered = false;
        const startedAt = executionClock.now();
        let firstByteAt: number | null = null;
        let refusal: { statusCode?: unknown; responseHeaders?: Record<string, string> } | undefined;
        const ceilingMs = providerFirstByteMs(adapted.provider, reasoning);
        const size = promptChars(params.prompt);
        const sized = size !== undefined ? { promptChars: size } : {};
        const limit =
          watch.firstByteMs === undefined
            ? watch.firstByteLimit?.(ceilingMs, {
                provider: adapted.provider,
                ...reasoning,
                ...sized,
              })
            : undefined;
        const firstByteMs =
          watch.firstByteMs ?? (typeof limit === "object" ? limit.ms : limit) ?? ceilingMs;
        const deadlineInputs = typeof limit === "object" ? limit.inputs : undefined;
        const cancel = executionTimeout(
          () =>
            controller.abort(
              new ProviderUnreachableError(
                modelId,
                `No model response within ${Math.round(firstByteMs / 1000)} seconds`,
              ),
            ),
          firstByteMs,
        );
        const response = () => {
          if (signal.aborted) return;
          if (!responded) {
            responded = true;
            firstByteAt = executionClock.now();
            cancel();
            settle?.(true);
          }
          watch.progress?.();
        };
        responses.set(signal, response);
        let detail: CallDetail = {};
        details.set(signal, (reported) => {
          detail = { ...detail, ...reported };
        });
        let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;
        let abort: (() => void) | undefined;
        let completed = false;
        try {
          const interrupted = new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          });
          const collect = async (): Promise<LanguageModelV4GenerateResult> => {
            const options = { ...params, abortSignal: signal };
            let generated: Awaited<ReturnType<typeof adapted.doStream>>;
            try {
              generated = await adapted.doStream(options);
            } catch (error) {
              // Some adapters only implement generation. Keep the same deadline and signal,
              // and fall back only when streaming is explicitly unsupported, before any output.
              if (
                responded ||
                !(
                  (error instanceof Error && error.message === "Not implemented") ||
                  (UnsupportedFunctionalityError.isInstance(error) &&
                    /stream/i.test(error.functionality))
                )
              )
                throw error;
              signal.throwIfAborted();
              const result = await adapted.doGenerate(options);
              signal.throwIfAborted();
              response();
              answered = true;
              return result;
            }
            if (signal.aborted) void generated.stream.cancel().catch(() => {});
            signal.throwIfAborted();
            const streamReader = generated.stream.getReader();
            reader = streamReader;
            const content: LanguageModelV4Content[] = [];
            const blocks = new Map<
              string,
              Extract<LanguageModelV4Content, { type: "text" | "reasoning" }>
            >();
            let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
            let warnings: LanguageModelV4GenerateResult["warnings"] = [];
            let metadata: LanguageModelV4GenerateResult["response"];
            for (;;) {
              const { done, value: part } = await streamReader.read();
              signal.throwIfAborted();
              if (done) break;
              if (part.type === "error") throw part.error;
              if (part.type === "stream-start") warnings = part.warnings;
              else if (part.type === "response-metadata") metadata = part;
              else if (part.type === "text-start" || part.type === "reasoning-start") {
                const block = {
                  type: part.type === "text-start" ? "text" : "reasoning",
                  text: "",
                  providerMetadata: part.providerMetadata,
                } as const;
                blocks.set(part.id, block);
                content.push(block);
              } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
                if (part.delta) {
                  response();
                  answered = true;
                }
                const block = blocks.get(part.id);
                if (block) {
                  block.text += part.delta;
                  if (part.providerMetadata) block.providerMetadata = part.providerMetadata;
                }
              } else if (part.type === "text-end" || part.type === "reasoning-end") {
                const block = blocks.get(part.id);
                if (block && part.providerMetadata) block.providerMetadata = part.providerMetadata;
              } else if (part.type === "finish") {
                finish = part;
                response();
                answered = true;
              } else if (part.type === "tool-input-delta") {
                if (part.delta) {
                  response();
                  answered = true;
                }
              } else if (
                part.type !== "tool-input-start" &&
                part.type !== "tool-input-end" &&
                part.type !== "raw"
              ) {
                response();
                answered = true;
                content.push(part);
              }
            }
            if (!finish)
              throw new ProviderUnreachableError(
                modelId,
                "Provider stream ended without a response finish",
              );
            return {
              content,
              warnings,
              finishReason: finish.finishReason,
              usage: finish.usage,
              providerMetadata: finish.providerMetadata,
              request: generated.request,
              response: { ...generated.response, ...metadata },
            };
          };
          const result = await Promise.race([collect(), interrupted]);
          completed = true;
          return result;
        } catch (error) {
          refusal = error as typeof refusal;
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!responded && !params.abortSignal?.aborted && connectionError(error))
            throw new ProviderUnreachableError(
              modelId,
              error instanceof Error ? error.message : String(error),
            );
          // A provider refusal is a response too, and must keep its account/rate-limit handling.
          // A turn whose answer was lost before any output reached BAKED charges no active time,
          // as an outage does not: nothing usable arrived (#1957).
          if (
            !signal.aborted &&
            !(error instanceof ProviderUnreachableError) &&
            !lostAnswer(error)
          ) {
            answered = true;
            if (!responded) {
              responded = true;
              settle?.(true);
            }
          }
          throw error;
        } finally {
          cancel();
          watch.timing?.({
            provider: adapted.provider,
            ...reasoning,
            firstByteMs: firstByteAt === null ? null : Math.ceil(firstByteAt - startedAt),
            ...(answered && firstByteAt !== null
              ? { silentMs: Math.ceil(firstByteAt - startedAt) }
              : {}),
            durationMs: Math.ceil(executionClock.now() - startedAt),
            ...(firstByteMs !== ceilingMs ? { limitMs: firstByteMs } : {}),
            ...(firstByteMs !== ceilingMs && deadlineInputs ? { deadlineInputs } : {}),
            ...sized,
            ...(typeof refusal?.statusCode === "number" ? { status: refusal.statusCode } : {}),
            ...(refusal?.responseHeaders?.["retry-after"]
              ? { retryAfter: refusal.responseHeaders["retry-after"] }
              : {}),
            ...detail,
          });
          if (abort) signal.removeEventListener("abort", abort);
          responses.delete(signal);
          details.delete(signal);
          if (!answered) settle?.(false);
          if (completed) reader?.releaseLock();
          else {
            void reader?.cancel().catch(() => {});
            controller.abort();
          }
        }
      },
    },
  });
}

export function providerBackoffMs(probe: number, base = 1_000): number {
  return Math.min(PROVIDER_BACKOFF_MAX_MS, Math.max(0, base) * 2 ** Math.min(20, probe));
}

/** A fresh conversation with no tools or workflow context. The entire probe is bounded too. */
export async function probeProvider(model: LanguageModel, modelId: string, signal: AbortSignal) {
  if (typeof model === "string") throw new Error("Provider health requires a resolved model");
  const firstByteMs = providerFirstByteMs(model.provider);
  const controller = new AbortController();
  let responded = false;
  let healthy!: (result: { usage: Partial<LanguageModelUsage> }) => void;
  const partial = new Promise<{ usage: Partial<LanguageModelUsage> }>((resolve) => {
    healthy = resolve;
  });
  const cancel = executionTimeout(() => {
    // A model that has started reasoning is reachable even if its answer outlasts the probe.
    if (responded) healthy({ usage: {} });
    else controller.abort(new ProviderUnreachableError(modelId, "Provider health probe timed out"));
  }, firstByteMs);
  try {
    const request = generateText({
      model: withProviderHealth(model, modelId, {
        firstByteMs,
        progress: () => {
          responded = true;
        },
      }),
      prompt: "Reply OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.any([signal, controller.signal]),
    });
    return await Promise.race([request, partial]);
  } finally {
    cancel();
    controller.abort();
  }
}
