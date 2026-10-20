import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";
import { z } from "zod";
import { WorkflowFault } from "./errors.js";
import type { RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/**
 * Record and replay of a run's model calls (#856). A recording run stores each model call of the
 * native executor as `recordings/PROFILE/TASK/ATTEMPT/N.json`: a fingerprint of the request and
 * the response. A replay run answers each call from a recording instead of the provider, until
 * the first request whose fingerprint differs, and stops there with `replay_diverged`. A fix can
 * then be checked against the exact run that showed a problem without spending model tokens.
 */

export const RECORDING_PREFIX = "recordings/";

/** One model call: the request fingerprint, a hash per prompt message, and the response. */
export const RecordedCallSchema = z
  .object({
    /** `PROFILE/TASK`, with `run` for calls outside a task. */
    key: z.string().min(1),
    /** Which attempt of this key, from 0, in the order the run started them. */
    attempt: z.number().int().min(0),
    /** Which model call of the attempt, from 0. */
    call: z.number().int().min(0),
    fingerprint: z.string(),
    messages: z.array(z.string()),
    response: z
      .object({
        content: z.array(z.unknown()),
        finishReason: z.unknown(),
        usage: z.unknown(),
        providerMetadata: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type RecordedCall = z.infer<typeof RecordedCallSchema>;

export const RecordingSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    calls: z.array(RecordedCallSchema),
  })
  .strict();
export type Recording = z.infer<typeof RecordingSchema>;

/** The key a call is recorded under: its profile and task. */
export const recordingKey = (profileId: string, taskId: string | null | undefined): string =>
  `${profileId}/${taskId ?? "run"}`;

// IDs and times the host generates differ on every run; they stand in as placeholders.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const DURATION = /("durationMs"\s*:\s*)\d+/g;

/** A value as JSON with run-specific IDs, times and durations replaced. */
export function normalized(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(UUID, "<id>")
    .replace(ISO_TIME, "<time>")
    .replace(DURATION, "$1<ms>");
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The parts of a request the harness decides: the prompt, the offered tools and the tool choice. */
export function fingerprintRequest(params: LanguageModelV4CallOptions): {
  fingerprint: string;
  messages: string[];
} {
  const messages = params.prompt.map((message) => sha(normalized(message)));
  const tools = (params.tools ?? []).map((tool) => tool.name).sort();
  return {
    fingerprint: sha(JSON.stringify({ messages, tools, toolChoice: params.toolChoice ?? null })),
    messages,
  };
}

/** Where the replay left the recording, for the run's diagnostic and the error message. */
export interface Divergence {
  key: string;
  attempt: number;
  call: number;
  /** The first prompt message that differs, or null when only the tools or the count differ. */
  message: number | null;
  detail: string;
}

function divergence(
  expected: RecordedCall | undefined,
  actual: { fingerprint: string; messages: string[] },
  params: LanguageModelV4CallOptions,
  where: { key: string; attempt: number; call: number },
): Divergence {
  if (!expected)
    return { ...where, message: null, detail: "the recording has no call at this point" };
  const first = actual.messages.findIndex((hash, index) => expected.messages[index] !== hash);
  if (first >= 0) {
    const message = params.prompt[first];
    return {
      ...where,
      message: first,
      detail: `prompt message ${first} (${message?.role ?? "?"}) differs: ${normalized(message?.content).slice(0, 300)}`,
    };
  }
  if (actual.messages.length !== expected.messages.length)
    return {
      ...where,
      message: actual.messages.length,
      detail: `the request has ${actual.messages.length} prompt messages, the recording ${expected.messages.length}`,
    };
  return { ...where, message: null, detail: "the offered tools or the tool choice differ" };
}

/** The fault that stops a replay run where it left the recording. */
export const divergenceFault = (found: Divergence): WorkflowFault =>
  new WorkflowFault(
    "INPUT_CHANGED",
    `Replay diverged from the recording at ${found.key} attempt ${found.attempt} call ${found.call}: ${found.detail}`,
    { reason: "replay_diverged", divergence: found },
  );

// A JSON round trip drops `undefined` fields (such as a finish reason's `raw`), so the call can be hashed and stored.
const responseOf = (result: LanguageModelV4GenerateResult): RecordedCall["response"] =>
  JSON.parse(
    JSON.stringify({
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage,
      ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
    }),
  ) as RecordedCall["response"];

/**
 * The model of one attempt: the provider's model that records each call (`record`), or a model
 * that answers from `replay` and records what it served, so a replay run is itself a recording.
 */
export function attemptModel(options: {
  model: () => LanguageModel;
  modelId: string;
  key: string;
  attempt: number;
  record: (call: RecordedCall) => void;
  replay?: readonly RecordedCall[];
}): LanguageModel {
  let call = 0;
  const { key, attempt } = options;
  const recorded = (
    response: RecordedCall["response"],
    request: { fingerprint: string; messages: string[] },
  ) => options.record({ key, attempt, call: call++, ...request, response });
  if (!options.replay) {
    return wrapLanguageModel({
      model: options.model() as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware: {
        wrapGenerate: async ({ doGenerate, params }) => {
          const result = await doGenerate();
          recorded(responseOf(result), fingerprintRequest(params));
          return result;
        },
      },
    }) as LanguageModel;
  }
  const calls = options.replay.filter((c) => c.key === key && c.attempt === attempt);
  const slash = options.modelId.indexOf("/");
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: slash > 0 ? options.modelId.slice(0, slash) : "replay",
    modelId: slash > 0 ? options.modelId.slice(slash + 1) : options.modelId,
    supportedUrls: {},
    doGenerate: async (params) => {
      const request = fingerprintRequest(params);
      const expected = calls.find((c) => c.call === call);
      if (expected?.fingerprint !== request.fingerprint)
        throw divergenceFault(divergence(expected, request, params, { key, attempt, call }));
      recorded(expected.response, request);
      return {
        ...(expected.response as Omit<LanguageModelV4GenerateResult, "warnings">),
        warnings: [],
      };
    },
    doStream: async () => {
      throw new WorkflowFault("CAPABILITY_DENIED", "A replayed model call cannot stream");
    },
  };
  return model;
}

/** A recording file as `workflow recording` writes it. */
export function readRecording(path: string): Recording {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new WorkflowFault("NOT_FOUND", `Cannot read the recording ${path}: ${String(error)}`);
  }
  const parsed = RecordingSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new WorkflowFault("INVALID_DEFINITION", `${path} is not a BAKED recording`, {
      validation: parsed.error.message,
    });
  return parsed.data;
}

/** A recorded call's artifact path. The attempt ID keeps attempts of one key apart. */
export const recordingPath = (key: string, attemptId: string, call: number): string =>
  `${RECORDING_PREFIX}${key}/${attemptId}/${String(call)}.json`;

/** The attempts of `key` recorded so far, from the artifact paths, in the order they were stored. */
export function recordedAttempts(paths: readonly string[], key: string): string[] {
  const prefix = `${RECORDING_PREFIX}${key}/`;
  const attempts: string[] = [];
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const attemptId = path.slice(prefix.length).split("/")[0];
    if (attemptId && !attempts.includes(attemptId)) attempts.push(attemptId);
  }
  return attempts;
}

/**
 * The calls of each key by attempt and call number, the keys in the order they were first
 * recorded. Storage order is the time an artifact was written, which two calls can share or, with
 * a clock step, invert: a macOS merge-queue run listed a replay's second call first (#1656).
 */
function inCallOrder(calls: RecordedCall[]): RecordedCall[] {
  const keys = [...new Set(calls.map((call) => call.key))];
  return keys.flatMap((key) =>
    calls
      .filter((call) => call.key === key)
      .sort((a, b) => a.attempt - b.attempt || a.call - b.call),
  );
}

/** The model calls a run recorded, in the order it stored them (`workflow recording`). */
export function runRecording(store: WorkflowStore, runId: string): Recording {
  return recordingOf(
    runId,
    store
      .artifacts(runId)
      .filter((artifact) => artifact.logical_path.startsWith(RECORDING_PREFIX))
      .map((artifact) => store.readArtifact(runId, artifact.id)),
  );
}

/** A recording of the stored `recordings/` artifacts of a run, as JSON texts. */
export function recordingOf(runId: string, artifacts: string[]): Recording {
  const calls = artifacts.map((text) => RecordedCallSchema.parse(JSON.parse(text)));
  if (!calls.length)
    throw new WorkflowFault(
      "NOT_FOUND",
      `Run ${runId} recorded no model calls; start a run with --record-model-calls to record one`,
    );
  return { schemaVersion: 1, runId, calls: inCallOrder(calls) };
}

/** A start policy that records the run's model calls, or replays them from a recording file. */
export function withModelCalls(
  policy: RunPolicy,
  options: { record?: boolean; replay?: string | undefined },
): RunPolicy {
  if (!options.record && !options.replay) return policy;
  // A missing or malformed recording is refused at the start, not at the first model call.
  if (options.replay) readRecording(options.replay);
  return {
    ...policy,
    modelCalls: {
      ...policy.modelCalls,
      ...(options.record ? { record: true } : {}),
      ...(options.replay ? { replay: options.replay } : {}),
    },
  };
}
