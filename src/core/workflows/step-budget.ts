import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  missingToolClaims,
  steeringNotice,
  stillStuck,
  type WatchFinding,
  type WatchStep,
  watchSteps,
} from "./progress-watch.js";
import { claimsLostTool } from "./retry.js";
import type { ProfileCompaction } from "./schemas.js";

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

/**
 * What a step counts against an attempt's token cap: its input less the cache reads, plus its
 * output. A cached prefix replayed by every step costs a fraction of new input, and counting it
 * in full ended 37 of 85 codex task attempts at the cap in bench round 21, with cache reads at
 * 71 percent of their tokens (#1070). A step whose provider reports no cache split counts whole.
 */
export function capTokens(usage: StepUsageLike, fallback: number): number {
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens;
  if (cacheRead === undefined || usage.inputTokens === undefined)
    return stepTokens(usage, fallback);
  return Math.max(0, usage.inputTokens - cacheRead) + (usage.outputTokens ?? 0);
}

/**
 * The attempt's spend on all tokens, cache reads included, is capped at this many times its cap.
 * The cap leaves cache reads out (#1070), so an attempt that loops read, edit and check cycles on a
 * growing context never reached it and ran to its step limit: notesift T004 spent 2.27M tokens in
 * one attempt, 90 percent of them cache reads, and jsonshape-update T004 2.09M on a 600k cap
 * (#1300). Finalizing there hands the task to a continuation that starts from a fresh context.
 */
export const ALL_TOKENS_FACTOR = 3;

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
  return `The ${limit} for this task is reached. Do not call any other tool. Call submit_result now with the complete result for the work already done; list anything unfinished as unresolved instead of continuing. A check you did not run is not unresolved: the host runs the task's required checks on your files, and one that fails after an edit you did not check comes back to this task once.`;
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
  /** Names of the step's tool calls, in call order; absent in records written before they were. */
  tools?: string[];
  compactedBytes: number;
  /** Model requests behind the step, when the provider reports them (Codex app-server). */
  modelRequests?: number;
  /** Earlier model responses whose usage the provider will never report (Codex app-server). */
  unreportedResponses?: number;
  /** Web searches the model ran in the step (Codex's own search, #1239); absent when none. */
  webSearches?: number;
}

export interface AttemptUsageRecord {
  schemaVersion: 1;
  profileId: string;
  taskId: string | null;
  maxSteps: number;
  /** The cap on `cappedTokens` after the step floor. */
  maxTokens: number;
  /** `error` and `aborted`: the loop threw or was cancelled; the steps before it are recorded. */
  stopReason: "submitted" | "steps" | "tokens" | "no_submission" | "error" | "aborted";
  finalizedBy: FinalizeReason | null;
  totalTokens: number;
  /**
   * Tokens counted against the cap (`capTokens`: cache reads left out); absent in records
   * written before the cap left them out, which counted `totalTokens`.
   */
  cappedTokens?: number;
  /** Sum of the steps' model requests; absent when the provider reports none. */
  modelRequests?: number;
  /**
   * Model responses whose usage was never reported, so `totalTokens` is low; absent when none.
   */
  unreportedResponses?: number;
  steps: AttemptStepUsage[];
  /** Tool calls by the code intelligence backend that answered; absent when none reported one. */
  toolBackends?: ToolBackendCount[];
  /** The reasoning effort sent to the provider; absent when none was sent (#936). */
  effort?: string;
  /** The attempt ran with Codex's own web search on (`codeWebSearch`, #1239). */
  webSearch?: boolean;
  /** Web searches the model ran, summed over the steps; absent when none. */
  webSearches?: number;
  /** Their queries in order, each cut to 200 characters, at most 50; absent when none. */
  webSearchQueries?: string[];
  /**
   * The provider reported no tokens for any step, so these are estimated from the sizes of the
   * request and the response (about 4 bytes a token); absent when the provider reported usage.
   */
  estimatedUsage?: { inputTokens: number; outputTokens: number };
}

/** Calls of one tool answered by one backend (lsp with its server, tree-sitter, regex, repo-map). */
export interface ToolBackendCount {
  tool: string;
  backend: string;
  server: string | null;
  calls: number;
}

export interface StepLike {
  usage: StepUsageLike;
  finishReason?: string;
  toolCalls: readonly unknown[];
  providerMetadata?: unknown;
}

/** The tool name of a step's tool call, as the AI SDK reports it; `unknown` when it has none. */
export function toolCallName(call: unknown): string {
  const name = (call as { toolName?: unknown } | null)?.toolName;
  return typeof name === "string" ? name : "unknown";
}

/** Responses whose usage a provider reports as lost before this step (Codex app-server, #820). */
export function stepUnreportedResponses(
  step: Pick<StepLike, "providerMetadata">,
): number | undefined {
  const count = (step.providerMetadata as { codex?: { unreportedResponses?: unknown } } | undefined)
    ?.codex?.unreportedResponses;
  return typeof count === "number" && count > 0 ? count : undefined;
}

/** Model requests a step cost, when the provider reports them (Codex app-server `responses`). */
export function stepModelRequests(step: Pick<StepLike, "providerMetadata">): number | undefined {
  const requests = (step.providerMetadata as { codex?: { responses?: unknown } } | undefined)?.codex
    ?.responses;
  return typeof requests === "number" ? requests : undefined;
}

/** Queries of the web searches a step ran, when the provider reports them (Codex, #1239). */
export function stepWebSearchQueries(step: Pick<StepLike, "providerMetadata">): string[] {
  const codex = (step.providerMetadata as { codex?: { webSearchQueries?: unknown } } | undefined)
    ?.codex;
  const queries = codex?.webSearchQueries;
  return Array.isArray(queries) ? queries.map((q) => (typeof q === "string" ? q : "")) : [];
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
  /** Whether the session was told which edit tools it has, after it said it had none. */
  private toolsNamed = false;
  private readonly compactedBytes: number[] = [];
  /** Whether compaction has started; once on, it stays on so the cached prefix keeps matching. */
  private compacting = false;
  /** Serialized size of the messages sent with each step, to estimate the next one. */
  private readonly sentBytes: number[] = [];
  /** The ceiling on all tokens, which `growCeiling` may raise during the attempt. */
  private ceiling: number | undefined;
  /** Whether the ceiling, not the attempt's own cap, finalized the attempt. */
  private ceilingStop = false;
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
      /**
       * Hard limit on all tokens, cache reads included, such as what the run budget still allows:
       * the step floor never passes it and the attempt finalizes before it.
       */
      ceilingTokens?: number;
      /**
       * Asked when the ceiling alone would finalize the attempt, with the tokens the attempt needs
       * for two more steps like its last: the run budget may grow to cover them. Returns the
       * ceiling now, all tokens included.
       */
      growCeiling?: (tokens: number) => number;
      /** The profile's compaction settings; unset compacts from the first step. */
      compaction?: ProfileCompaction;
      /**
       * The progress watcher: a first stuck signal adds one steering message, the same kind of
       * signal `WATCH_STOP_AFTER` steps later finalizes the attempt. `onSignal` records both.
       */
      watch?: {
        mustEdit: boolean;
        /** The edit tools of the session, named back to a worker that says it has none. */
        editTools?: string[];
        onSignal: (finding: WatchFinding, action: "steered" | "stopped") => void;
      };
    },
  ) {
    this.ceiling = options.ceilingTokens;
  }
  get maxTokens(): number {
    return this.options.maxTokens;
  }
  /** Whether the run's free budget, not the attempt's cap or steps, ended the attempt early. */
  get stoppedByCeiling(): boolean {
    return this.ceilingStop;
  }
  /** The token cap after the step floor, given the steps taken so far. */
  tokenCap(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    const { maxTokens, minSteps } = this.options;
    if (!minSteps || steps.length === 0) return maxTokens;
    const floor = Math.ceil((this.capped(steps) / steps.length) * minSteps);
    return Math.max(maxTokens, Math.min(floor, this.ceiling ?? maxTokens));
  }
  /** Tokens the steps count against the cap; see `capTokens`. */
  capped(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    return steps.reduce(
      (sum, step) => sum + capTokens(step.usage, this.options.fallbackStepTokens),
      0,
    );
  }
  /**
   * The cap on all tokens, cache reads included: `ALL_TOKENS_FACTOR` times the token cap, and never
   * below the step floor (`minSteps` steps at the attempt's average step, all tokens counted).
   */
  allTokensCap(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    const { minSteps } = this.options;
    const floor =
      minSteps && steps.length ? Math.ceil((this.consumed(steps) / steps.length) * minSteps) : 0;
    return Math.max(ALL_TOKENS_FACTOR * this.tokenCap(steps), floor);
  }
  /** Whether the steps used the cap, the all-token cap, or all the tokens the ceiling allows. */
  private atCap(steps: ReadonlyArray<{ usage: StepUsageLike }>): boolean {
    const ceiling = this.ceiling;
    const consumed = this.consumed(steps);
    return (
      this.capped(steps) >= this.tokenCap(steps) ||
      consumed >= this.allTokensCap(steps) ||
      (ceiling !== undefined && consumed >= ceiling)
    );
  }
  /** Whether the next step would pass the all-token cap; the step limit is decided before it. */
  private allTokensReason(
    stepNumber: number,
    steps: ReadonlyArray<{ usage: StepUsageLike }>,
  ): FinalizeReason | null {
    const last = steps[steps.length - 1];
    return finalizeReason({
      stepNumber,
      maxSteps: Number.POSITIVE_INFINITY,
      consumed: this.consumed(steps),
      lastStepTokens: last ? stepTokens(last.usage, this.options.fallbackStepTokens) : 0,
      maxTokens: this.allTokensCap(steps),
    });
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
  /**
   * Whether the ceiling finalizes the next step. The attempt's cap leaves cache reads out and the
   * ceiling counts them, so an attempt the run admitted on its cap could be finalized after one
   * step it had not the budget to repeat: md-site T012 started with 546k left, its first step
   * cost 186k, and it submitted failed without an edit (#1298). The run budget grows first,
   * on the same rules as any call past it.
   */
  private ceilingReason(
    stepNumber: number,
    steps: ReadonlyArray<{ usage: StepUsageLike }>,
  ): FinalizeReason | null {
    if (this.ceiling === undefined) return null;
    const last = steps[steps.length - 1];
    const lastStepTokens = last ? stepTokens(last.usage, this.options.fallbackStepTokens) : 0;
    const consumed = this.consumed(steps);
    const reason = (maxTokens: number) =>
      finalizeReason({
        stepNumber,
        maxSteps: this.options.maxSteps,
        consumed,
        lastStepTokens,
        maxTokens,
      });
    if (reason(this.ceiling) !== "tokens") return reason(this.ceiling);
    const grow = this.options.growCeiling;
    if (grow) this.ceiling = Math.max(this.ceiling, grow(consumed + 2 * lastStepTokens));
    const final = reason(this.ceiling);
    this.ceilingStop = final === "tokens";
    return final;
  }
  /** Serialized size of the messages the newest step sent; undefined before the first. */
  lastSentBytes(): number | undefined {
    return this.sentBytes.findLast((bytes) => bytes !== undefined);
  }
  consumed(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    return steps.reduce(
      (sum, step) => sum + stepTokens(step.usage, this.options.fallbackStepTokens),
      0,
    );
  }
  overBudget(steps: ReadonlyArray<{ usage: StepUsageLike }>): boolean {
    return this.atCap(steps);
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
    const fallback = this.options.fallbackStepTokens;
    this.finalizedBy ??=
      finalizeReason({
        stepNumber: input.stepNumber,
        maxSteps: this.options.maxSteps,
        consumed: this.capped(input.steps),
        lastStepTokens: last ? capTokens(last.usage, fallback) : 0,
        maxTokens: this.tokenCap(input.steps),
      }) ??
      this.allTokensReason(input.stepNumber, input.steps) ??
      this.ceilingReason(input.stepNumber, input.steps);
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
    // A worker that says it has no edit tool while the session has some is told which it has; a
    // second such claim without an edit since ends the attempt, outside the one steering (#1360).
    let namedTools: WatchFinding | null = null;
    const editTools = watch?.editTools ?? [];
    if (
      watch?.mustEdit &&
      editTools.length &&
      this.finalizedBy === null &&
      this.options.submitTools.length
    ) {
      const claims = missingToolClaims(input.steps, claimsLostTool);
      const tools = editTools.join(", ");
      if (claims.length >= 2 && this.toolsNamed) {
        this.finalizedBy = "watcher";
        this.watchDone = true;
        this.watchStop = {
          signal: "no-edit-tool",
          detail: `the worker said twice that it has no edit tool, while this session has ${tools}`,
        };
        watch.onSignal(this.watchStop, "stopped");
      } else if (claims.length >= 1 && !this.toolsNamed) {
        this.toolsNamed = true;
        namedTools = {
          signal: "no-edit-tool",
          detail: `the worker said it has no edit tool, while this session has ${tools}`,
        };
        watch.onSignal(namedTools, "steered");
      }
    }
    const compaction = this.options.compaction;
    const startAt =
      compaction?.startAtTokens ??
      (compaction?.startAtShare !== undefined
        ? compaction.startAtShare * this.options.maxTokens
        : 0);
    this.compacting ||= this.capped(input.steps) >= startAt;
    const compacted = this.compacting
      ? compactToolHistory(input.messages, compaction?.keepRecent)
      : { messages: input.messages, savedBytes: 0 };
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
    if (namedTools)
      this.notices.push({ at: compacted.messages.length, content: steeringNotice(namedTools) });
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
    const cappedTokens = this.capped(steps);
    const maxTokens = this.tokenCap(steps);
    const requests = steps.map(stepModelRequests);
    const reported = requests.filter((r): r is number => r !== undefined);
    const unreported = steps.map(stepUnreportedResponses);
    const lost = unreported.reduce<number>((sum, n) => sum + (n ?? 0), 0);
    const searches = steps.map(stepWebSearchQueries);
    const queries = searches.flat();
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
          : this.atCap(steps)
            ? "tokens"
            : steps.length >= this.options.maxSteps
              ? "steps"
              : "no_submission",
      finalizedBy: this.finalizedBy,
      totalTokens,
      cappedTokens,
      ...(reported.length ? { modelRequests: reported.reduce((a, b) => a + b, 0) } : {}),
      ...(lost ? { unreportedResponses: lost } : {}),
      ...(queries.length
        ? {
            webSearches: queries.length,
            webSearchQueries: queries.slice(0, 50).map((q) => q.slice(0, 200)),
          }
        : {}),
      steps: steps.map((step, index) => ({
        inputTokens: step.usage.inputTokens ?? null,
        outputTokens: step.usage.outputTokens ?? null,
        cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? null,
        cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? null,
        toolCalls: step.toolCalls.length,
        ...(step.toolCalls.length ? { tools: step.toolCalls.map(toolCallName) } : {}),
        compactedBytes: this.compactedBytes[index] ?? 0,
        ...(requests[index] !== undefined ? { modelRequests: requests[index] } : {}),
        ...(unreported[index] !== undefined ? { unreportedResponses: unreported[index] } : {}),
        ...(searches[index]?.length ? { webSearches: searches[index]?.length } : {}),
      })),
    };
  }
}
