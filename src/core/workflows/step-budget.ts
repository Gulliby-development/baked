import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  steeringNotice,
  stillStuck,
  type WatchFinding,
  type WatchStep,
  watchSteps,
} from "./progress-watch.js";

/** Per-attempt token cap used when the run policy does not set `maxAttemptTokens`. */
export const DEFAULT_MAX_ATTEMPT_TOKENS = 250_000;
/**
 * Steps an attempt may always take, whatever one step costs on its provider. Token caps are sized
 * from history, and a provider whose steps cost several times more (Codex replays a fixed ~20k
 * prompt per step) otherwise ran out of an attempt after 3-8 steps.
 */
export const MIN_ATTEMPT_STEPS = 10;
/** Tool-result messages at the end of the history that stay verbatim. */
export const KEEP_RECENT_TOOL_MESSAGES = 3;
/** Tool outputs smaller than this are cheaper to replay than to re-read. */
const MIN_COMPACT_BYTES = 1500;
const PREVIEW_CHARS = 240;
// Observation tools whose output can be fetched again. Edit and check results carry
// state the agent cannot reproduce cheaply, so they are never compacted.
const COMPACTABLE_TOOLS = new Set(["read", "navigate", "bake_find", "bake_impact"]);
/** Input allowance for the system prompt and tool definitions before any usage is reported. */
const FIRST_STEP_ALLOWANCE = 8192;
/** Smallest output reserved for a step. */
const MIN_OUTPUT_ESTIMATE = 4096;

export interface StepUsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokenDetails?:
    | { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }
    | undefined;
}

export function stepTokens(usage: StepUsageLike, fallback: number): number {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return fallback;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** `watcher`: the progress watcher ended a stuck attempt early (`progress-watch.ts`). */
export type FinalizeReason = "steps" | "tokens" | "watcher";
/** Steps after a steering message before the same stuck pattern ends the attempt. */
export const WATCH_STOP_AFTER = 3;

/**
 * Decide whether the next step must be the final one. Each step replays the whole history,
 * so the next step costs at least as much as the last one; finalizing while two such steps
 * still fit leaves room for one rejected submission and its correction.
 */
export function finalizeReason(input: {
  stepNumber: number;
  maxSteps: number;
  consumed: number;
  lastStepTokens: number;
  maxTokens: number;
}): FinalizeReason | null {
  // Two forced steps when the cap allows: a submission the schema or the stage validators reject
  // otherwise has no step left to be corrected (url-shortener 6a2a4f9c ended on a rejected submit).
  if (input.stepNumber >= (input.maxSteps > 2 ? input.maxSteps - 2 : input.maxSteps - 1))
    return "steps";
  if (input.consumed + 2 * input.lastStepTokens > input.maxTokens) return "tokens";
  return null;
}

export function finalizeNotice(reason: FinalizeReason, watched?: WatchFinding): string {
  if (reason === "watcher")
    return `The progress watcher ended this attempt early: ${watched?.detail ?? "the same pattern continued after the warning"}. Do not call any other tool. Call submit_result now with the work already done and list what blocks you as unresolved.`;
  const limit = reason === "steps" ? "step limit" : "token budget";
  return `The ${limit} for this task is reached. Do not call any other tool. Call submit_result now with the complete result for the work already done; list anything unfinished as unresolved instead of continuing. The host runs the checks after you, so a check you did not run again is not unresolved.`;
}

/** Notice added once when an attempt that must edit has only read for several steps. */
export function editNudgeNotice(steps: number): string {
  return `You have only read files for the last ${steps} steps. What you read is in your context: apply the edits now with multi_edit or edit_file, then call submit_result. Read again only a span you have not seen.`;
}

/** Notice added after a step whose output reached the output token cap. */
export function truncationNotice(maxOutputTokens: number | undefined): string {
  const limit = maxOutputTokens ? `the ${maxOutputTokens}-token output limit` : "the output limit";
  return `Your last response reached ${limit} and was cut off, so the tool call in it did not run as written. Split the change into smaller calls: a multi_edit with a few short hunks per call, or one edit_file per region, instead of one large edit.`;
}

/**
 * Replace large outputs of older observation tool calls with a short stub. The stub keeps
 * every evidence ID, because results must cite them. The transformation is deterministic,
 * so a message compacted once is byte-identical on later steps and the cached prefix up to
 * the newest compacted message stays valid.
 */
export function compactToolHistory(
  messages: ModelMessage[],
  keepRecent = KEEP_RECENT_TOOL_MESSAGES,
): { messages: ModelMessage[]; savedBytes: number } {
  const toolIndexes: number[] = [];
  for (const [index, message] of messages.entries())
    if (message.role === "tool") toolIndexes.push(index);
  const cutoff = toolIndexes[toolIndexes.length - keepRecent];
  if (cutoff === undefined) return { messages, savedBytes: 0 };

  const callInputs = new Map<string, JSONValue>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content)
      if (part.type === "tool-call")
        callInputs.set(
          part.toolCallId,
          JSON.parse(JSON.stringify(part.input ?? null)) as JSONValue,
        );
  }

  let savedBytes = 0;
  let result: ModelMessage[] | undefined;
  for (let index = 0; index < cutoff; index++) {
    const message = messages[index];
    if (message?.role !== "tool") continue;
    let content: typeof message.content | undefined;
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "tool-result" || !COMPACTABLE_TOOLS.has(part.toolName)) continue;
      if (part.toolName === "read" && targetedRead(callInputs.get(part.toolCallId))) continue;
      const original = serializeOutput(part.output);
      if (original === undefined || Buffer.byteLength(original) < MIN_COMPACT_BYTES) continue;
      const stub: JSONValue = {
        compacted: true,
        tool: part.toolName,
        input: callInputs.get(part.toolCallId) ?? null,
        evidenceIds: collectEvidenceIds(outputValue(part.output)),
        preview: original.slice(0, PREVIEW_CHARS),
        // The read tool answers a repeated whole-file read with "already in your context"
        // unless asked for a fresh read.
        note: `${String(Buffer.byteLength(original))} bytes elided from history; call the tool again${part.toolName === "read" ? " with fresh: true" : ""} if the full output is needed.`,
      };
      const replacement = { type: "json" as const, value: stub };
      savedBytes += Buffer.byteLength(original) - Buffer.byteLength(JSON.stringify(stub));
      content ??= [...message.content];
      content[partIndex] = { ...part, output: replacement };
    }
    if (content) {
      result ??= [...messages];
      result[index] = { ...message, content };
    }
  }
  return result ? { messages: result, savedBytes } : { messages, savedBytes: 0 };
}

/**
 * A read of line ranges or symbols only. It is kept verbatim: it is small and chosen for the
 * edit, and once stubbed the agent reads the same ranges again instead of editing.
 */
function targetedRead(input: JSONValue | undefined): boolean {
  const files = asRecord(input)?.files;
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((file) => {
      const spec = asRecord(file);
      return !!spec?.target || (Array.isArray(spec?.ranges) && spec.ranges.length > 0);
    })
  );
}

function asRecord(value: JSONValue | undefined): Record<string, JSONValue | undefined> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JSONValue | undefined>)
    : null;
}

function outputValue(output: unknown): unknown {
  if (output && typeof output === "object" && "value" in output) return output.value;
  return undefined;
}

function serializeOutput(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || !("type" in output)) return undefined;
  const value = outputValue(output);
  if (output.type === "text" || output.type === "error-text")
    return typeof value === "string" ? value : undefined;
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(value);
  return undefined;
}

function collectEvidenceIds(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceIds(item, found, depth + 1);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^evidenceIds?$/.test(key)) {
      for (const id of Array.isArray(item) ? item : [item])
        if (typeof id === "string" && !found.includes(id)) found.push(id);
    } else collectEvidenceIds(item, found, depth + 1);
  }
  return found;
}

export interface AttemptStepUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Absent in records written before cache writes were recorded. */
  cacheWriteTokens?: number | null;
  toolCalls: number;
  compactedBytes: number;
}

export interface AttemptUsageRecord {
  schemaVersion: 1;
  profileId: string;
  taskId: string | null;
  maxSteps: number;
  maxTokens: number;
  /** `error` and `aborted`: the loop threw or was cancelled; the steps before it are recorded. */
  stopReason: "submitted" | "steps" | "tokens" | "no_submission" | "error" | "aborted";
  finalizedBy: FinalizeReason | null;
  totalTokens: number;
  steps: AttemptStepUsage[];
}

export interface StepLike {
  usage: StepUsageLike;
  finishReason?: string;
  toolCalls: readonly unknown[];
}

/**
 * Step-level budget control for one agent attempt: compacts replayed tool output, switches
 * to a submit-only final step before the step or token cap is reached, and records usage.
 */
export class AttemptStepController {
  private finalizedBy: FinalizeReason | null = null;
  /** Notices injected into the history, by message index, so later steps replay them in place. */
  private readonly notices: { at: number; content: string }[] = [];
  private finalizeNoticed = false;
  private truncatedStep = -1;
  private nudged = false;
  /** Steps taken when the watcher steered, and what ended the attempt early. */
  private steered: { at: number; finding: WatchFinding } | null = null;
  private watchDone = false;
  private watchStop: WatchFinding | null = null;
  private readonly compactedBytes: number[] = [];
  /** Serialized size of the messages sent with each step, to estimate the next one. */
  private readonly sentBytes: number[] = [];
  constructor(
    private readonly options: {
      maxSteps: number;
      maxTokens: number;
      /** Submit tools available to the agent; finalizing restricts it to these. */
      submitTools: string[];
      /** Charged for a step whose provider reported no usage. */
      fallbackStepTokens: number;
      /** Output cap of one step; bounds the output estimate of the next step. */
      maxOutputTokens?: number;
      /** For an attempt that must edit: read-only steps in a row before it is told to edit. */
      editNudgeAfterReads?: number;
      /**
       * Steps the token cap always allows: the cap grows to this many steps at the attempt's
       * average step cost so far, up to `ceilingTokens`.
       */
      minSteps?: number;
      /** Hard limit the step floor never passes, such as what the run budget still allows. */
      ceilingTokens?: number;
      /**
       * The progress watcher: a first stuck signal adds one steering message, the same kind of
       * signal `WATCH_STOP_AFTER` steps later finalizes the attempt. `onSignal` records both.
       */
      watch?: {
        mustEdit: boolean;
        onSignal: (finding: WatchFinding, action: "steered" | "stopped") => void;
      };
    },
  ) {}
  get maxTokens(): number {
    return this.options.maxTokens;
  }
  /** The token cap after the step floor, given the steps taken so far. */
  tokenCap(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    const { maxTokens, minSteps, ceilingTokens } = this.options;
    if (!minSteps || steps.length === 0) return maxTokens;
    const floor = Math.ceil((this.consumed(steps) / steps.length) * minSteps);
    return Math.max(maxTokens, Math.min(floor, ceilingTokens ?? maxTokens));
  }
  /**
   * Tokens the attempt holds once the next step runs: its spend so far plus an estimate of that
   * step. The input estimate starts from the input tokens the provider reported for the last
   * step and adds the bytes appended since (or subtracts the bytes compaction removed) at three
   * bytes per token. The output estimate is twice the largest output seen, at least 4096 tokens
   * and at most the step cap. Before any usage is known, the messages are counted at three bytes
   * per token plus a fixed allowance for the system prompt and tool definitions.
   */
  reservation(steps: ReadonlyArray<{ usage: StepUsageLike }>, messages: ModelMessage[]): number {
    const bytes = Buffer.byteLength(JSON.stringify(messages));
    const maxOutput = this.options.maxOutputTokens ?? Number.POSITIVE_INFINITY;
    const last = steps[steps.length - 1];
    const lastSent = this.sentBytes[steps.length - 1];
    const lastInput = last?.usage.inputTokens;
    const input =
      lastInput !== undefined && lastSent !== undefined
        ? Math.max(0, lastInput + Math.ceil((bytes - lastSent) / 3))
        : Math.ceil(bytes / 3) + FIRST_STEP_ALLOWANCE;
    const largestOutput = Math.max(0, ...steps.map((step) => step.usage.outputTokens ?? 0));
    const output = Math.min(maxOutput, Math.max(MIN_OUTPUT_ESTIMATE, 2 * largestOutput));
    return this.consumed(steps) + input + output;
  }
  consumed(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    return steps.reduce(
      (sum, step) => sum + stepTokens(step.usage, this.options.fallbackStepTokens),
      0,
    );
  }
  overBudget(steps: ReadonlyArray<{ usage: StepUsageLike }>): boolean {
    return this.consumed(steps) >= this.tokenCap(steps);
  }
  prepare(input: {
    stepNumber: number;
    steps: ReadonlyArray<
      {
        usage: StepUsageLike;
        finishReason?: string;
      } & WatchStep
    >;
    messages: ModelMessage[];
  }): { messages?: ModelMessage[]; activeTools?: string[]; toolChoice?: "required" } {
    const last = input.steps[input.steps.length - 1];
    this.finalizedBy ??= finalizeReason({
      stepNumber: input.stepNumber,
      maxSteps: this.options.maxSteps,
      consumed: this.consumed(input.steps),
      lastStepTokens: last ? stepTokens(last.usage, this.options.fallbackStepTokens) : 0,
      maxTokens: this.tokenCap(input.steps),
    });
    const watch = this.options.watch;
    let steer: WatchFinding | null = null;
    // One steering message per attempt; the stop follows only when the steered pattern goes on.
    if (watch && !this.watchDone && this.finalizedBy === null && this.options.submitTools.length) {
      if (!this.steered) {
        const finding = watchSteps(input.steps, { mustEdit: watch.mustEdit });
        if (finding) {
          this.steered = { at: input.steps.length, finding };
          steer = finding;
          watch.onSignal(finding, "steered");
        }
      } else {
        const { at, finding } = this.steered;
        const state = stillStuck(finding, input.steps, at, WATCH_STOP_AFTER);
        if (state === "progress") this.watchDone = true;
        else if (state === "stuck") {
          this.watchDone = true;
          this.finalizedBy = "watcher";
          this.watchStop = finding;
          watch.onSignal(finding, "stopped");
        }
      }
    }
    const compacted = compactToolHistory(input.messages);
    this.compactedBytes[input.stepNumber] = compacted.savedBytes;
    const finalizing = this.finalizedBy !== null && this.options.submitTools.length > 0;
    // A step cut off at the output cap usually carried an oversized edit; say so once, unless
    // the attempt is already finalizing and no further edit can run.
    if (last?.finishReason === "length" && this.truncatedStep < input.steps.length && !finalizing) {
      this.truncatedStep = input.steps.length;
      this.notices.push({
        at: compacted.messages.length,
        content: truncationNotice(this.options.maxOutputTokens),
      });
    }
    if (steer) this.notices.push({ at: compacted.messages.length, content: steeringNotice(steer) });
    const nudgeAfter = this.options.editNudgeAfterReads;
    if (nudgeAfter && !this.nudged && !finalizing) {
      let reads = 0;
      for (const step of [...input.steps].reverse()) {
        const calls = step.toolCalls ?? [];
        if (calls.length === 0 || !calls.every((call) => COMPACTABLE_TOOLS.has(call.toolName)))
          break;
        reads++;
      }
      if (reads >= nudgeAfter) {
        this.nudged = true;
        this.notices.push({ at: compacted.messages.length, content: editNudgeNotice(reads) });
      }
    }
    if (finalizing && this.finalizedBy && !this.finalizeNoticed) {
      this.finalizeNoticed = true;
      this.notices.push({
        at: compacted.messages.length,
        content: finalizeNotice(this.finalizedBy, this.watchStop ?? undefined),
      });
    }
    let messages = compacted.messages;
    if (this.notices.length > 0) {
      // Keep each notice where it first appeared so the replayed prefix stays identical.
      messages = [...compacted.messages];
      for (const [offset, notice] of this.notices.entries())
        messages.splice(notice.at + offset, 0, { role: "user", content: notice.content });
    }
    this.sentBytes[input.stepNumber] = Buffer.byteLength(JSON.stringify(messages));
    if (!finalizing) return messages === input.messages ? {} : { messages };
    return { messages, activeTools: this.options.submitTools, toolChoice: "required" };
  }
  record(
    steps: readonly StepLike[],
    submitted: boolean,
    meta: { profileId: string; taskId: string | null },
    failure?: "error" | "aborted",
  ): AttemptUsageRecord {
    const totalTokens = this.consumed(steps);
    const maxTokens = this.tokenCap(steps);
    return {
      schemaVersion: 1,
      profileId: meta.profileId,
      taskId: meta.taskId,
      maxSteps: this.options.maxSteps,
      maxTokens,
      stopReason: failure
        ? failure
        : submitted
          ? "submitted"
          : totalTokens >= maxTokens
            ? "tokens"
            : steps.length >= this.options.maxSteps
              ? "steps"
              : "no_submission",
      finalizedBy: this.finalizedBy,
      totalTokens,
      steps: steps.map((step, index) => ({
        inputTokens: step.usage.inputTokens ?? null,
        outputTokens: step.usage.outputTokens ?? null,
        cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? null,
        cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? null,
        toolCalls: step.toolCalls.length,
        compactedBytes: this.compactedBytes[index] ?? 0,
      })),
    };
  }
}
