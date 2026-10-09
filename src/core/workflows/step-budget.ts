import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/** Per-attempt token cap used when the run policy does not set `maxAttemptTokens`. */
export const DEFAULT_MAX_ATTEMPT_TOKENS = 250_000;
/** Tool-result messages at the end of the history that stay verbatim. */
export const KEEP_RECENT_TOOL_MESSAGES = 3;
/** Tool outputs smaller than this are cheaper to replay than to re-read. */
const MIN_COMPACT_BYTES = 1500;
const PREVIEW_CHARS = 240;
// Observation tools whose output can be fetched again. Edit and check results carry
// state the agent cannot reproduce cheaply, so they are never compacted.
const COMPACTABLE_TOOLS = new Set(["read", "navigate", "bake_find", "bake_impact"]);

export interface StepUsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
}

export function stepTokens(usage: StepUsageLike, fallback: number): number {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return fallback;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export type FinalizeReason = "steps" | "tokens";

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
  if (input.stepNumber >= input.maxSteps - 1) return "steps";
  if (input.consumed + 2 * input.lastStepTokens > input.maxTokens) return "tokens";
  return null;
}

export function finalizeNotice(reason: FinalizeReason): string {
  const limit = reason === "steps" ? "step limit" : "token budget";
  return `The ${limit} for this task is reached. Do not call any other tool. Call submit_result now with the complete result for the work already done; list anything unfinished as unresolved instead of continuing.`;
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
      const original = serializeOutput(part.output);
      if (original === undefined || Buffer.byteLength(original) < MIN_COMPACT_BYTES) continue;
      const stub: JSONValue = {
        compacted: true,
        tool: part.toolName,
        input: callInputs.get(part.toolCallId) ?? null,
        evidenceIds: collectEvidenceIds(outputValue(part.output)),
        preview: original.slice(0, PREVIEW_CHARS),
        note: `${String(Buffer.byteLength(original))} bytes elided from history; call the tool again if the full output is needed.`,
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
  toolCalls: number;
  compactedBytes: number;
}

export interface AttemptUsageRecord {
  schemaVersion: 1;
  profileId: string;
  taskId: string | null;
  maxSteps: number;
  maxTokens: number;
  stopReason: "submitted" | "steps" | "tokens" | "no_submission";
  finalizedBy: FinalizeReason | null;
  totalTokens: number;
  steps: AttemptStepUsage[];
}

interface StepLike {
  usage: StepUsageLike;
  toolCalls: readonly unknown[];
}

/**
 * Step-level budget control for one agent attempt: compacts replayed tool output, switches
 * to a submit-only final step before the step or token cap is reached, and records usage.
 */
export class AttemptStepController {
  private finalizedBy: FinalizeReason | null = null;
  private noticeAt = -1;
  private readonly compactedBytes: number[] = [];
  constructor(
    private readonly options: {
      maxSteps: number;
      maxTokens: number;
      /** Submit tools available to the agent; finalizing restricts it to these. */
      submitTools: string[];
      /** Charged for a step whose provider reported no usage. */
      fallbackStepTokens: number;
    },
  ) {}
  consumed(steps: ReadonlyArray<{ usage: StepUsageLike }>): number {
    return steps.reduce(
      (sum, step) => sum + stepTokens(step.usage, this.options.fallbackStepTokens),
      0,
    );
  }
  overBudget(steps: ReadonlyArray<{ usage: StepUsageLike }>): boolean {
    return this.consumed(steps) >= this.options.maxTokens;
  }
  prepare(input: {
    stepNumber: number;
    steps: ReadonlyArray<{ usage: StepUsageLike }>;
    messages: ModelMessage[];
  }): { messages?: ModelMessage[]; activeTools?: string[]; toolChoice?: "required" } {
    const last = input.steps[input.steps.length - 1];
    this.finalizedBy ??= finalizeReason({
      stepNumber: input.stepNumber,
      maxSteps: this.options.maxSteps,
      consumed: this.consumed(input.steps),
      lastStepTokens: last ? stepTokens(last.usage, this.options.fallbackStepTokens) : 0,
      maxTokens: this.options.maxTokens,
    });
    const compacted = compactToolHistory(input.messages);
    this.compactedBytes[input.stepNumber] = compacted.savedBytes;
    if (!this.finalizedBy || this.options.submitTools.length === 0)
      return compacted.messages === input.messages ? {} : { messages: compacted.messages };
    // Keep the notice where it first appeared so the replayed prefix stays identical across
    // the remaining finalize steps.
    if (this.noticeAt < 0) this.noticeAt = compacted.messages.length;
    const messages = [...compacted.messages];
    messages.splice(this.noticeAt, 0, {
      role: "user",
      content: finalizeNotice(this.finalizedBy),
    });
    return { messages, activeTools: this.options.submitTools, toolChoice: "required" };
  }
  record(
    steps: readonly StepLike[],
    submitted: boolean,
    meta: { profileId: string; taskId: string | null },
  ): AttemptUsageRecord {
    const totalTokens = this.consumed(steps);
    return {
      schemaVersion: 1,
      profileId: meta.profileId,
      taskId: meta.taskId,
      maxSteps: this.options.maxSteps,
      maxTokens: this.options.maxTokens,
      stopReason: submitted
        ? "submitted"
        : totalTokens >= this.options.maxTokens
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
        toolCalls: step.toolCalls.length,
        compactedBytes: this.compactedBytes[index] ?? 0,
      })),
    };
  }
}
