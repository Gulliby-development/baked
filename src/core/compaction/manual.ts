/**
 * Compaction of a conversation's model messages on request ("Compact now"): the older messages
 * become one summary, the most recent ones stay verbatim. The terminal UI's `/compact` and the
 * local API's `POST /v1/sessions/ID/compact` share these steps, so both front ends cut, summarize
 * and reassemble a conversation the same way.
 */
import type { JSONObject } from "@ai-sdk/provider";
import { generateText, type ModelMessage } from "ai";
import { recordModelCall } from "../diagnostics/model-events.js";
import { supportsTemperature } from "../llm/provider-options.js";
import type { IOClient } from "../workers/io-client.js";
import {
  extractFromAssistantMessage,
  extractFromToolCall,
  extractFromToolResult,
  extractFromUserMessage,
} from "./extractor.js";
import { buildV2Summary } from "./summarize.js";
import { type CompactionConfig, DEFAULT_COMPACTION_CONFIG } from "./types.js";
import { WorkingStateManager } from "./working-state.js";

/** Fewer model messages than this leave nothing worth compacting. */
export const MIN_COMPACT_MESSAGES = 4;
/** A summary shorter than this is treated as a failed compaction and the context is kept. */
export const MIN_SUMMARY_CHARS = 50;

export interface CompactionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Fills a working state from saved model messages, as the incremental extraction would have. */
export function rehydrateWorkingState(wsm: WorkingStateManager, messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role === "user") {
      extractFromUserMessage(wsm, msg);
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      extractFromAssistantMessage(wsm, msg);
      for (const part of msg.content) {
        if (typeof part === "object" && "type" in part && part.type === "tool-call") {
          const tc = part as { toolName: string; input: Record<string, unknown> };
          extractFromToolCall(wsm, tc.toolName, tc.input);
        }
      }
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && "type" in part && part.type === "tool-result") {
          const tr = part as { toolName: string; output: unknown };
          extractFromToolResult(wsm, tr.toolName, tr.output);
        }
      }
    }
  }
}

/**
 * Splits a conversation into the messages to summarize and the `keepRecent` (or a few more)
 * kept verbatim. The cut never separates a tool call from its result, and the kept part starts
 * with a user message so it follows the summary's assistant acknowledgement.
 */
export function splitForCompaction(
  core: ModelMessage[],
  keepRecent: number,
): { older: ModelMessage[]; recent: ModelMessage[] } {
  let keepStart = Math.max(0, core.length - keepRecent);
  while (keepStart > 0 && core[keepStart]?.role === "tool") keepStart--;
  if (keepStart > 0 && core[keepStart]?.role === "assistant") keepStart--;
  return { older: core.slice(0, keepStart), recent: core.slice(keepStart) };
}

function formatForSummary(m: ModelMessage, charLimit: number): string {
  const role = m.role;
  if (typeof m.content === "string") return `${role}: ${m.content.slice(0, charLimit)}`;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((p) => {
        if (typeof p === "object" && p !== null) {
          if ("text" in p) return String((p as { text: string }).text).slice(0, charLimit);
          if ("type" in p && (p as { type: string }).type === "tool-result") {
            const tr = p as { toolName?: string; result?: unknown };
            const resultStr = tr.result != null ? JSON.stringify(tr.result) : "null";
            return `[tool-result: ${tr.toolName ?? "unknown"} → ${resultStr.slice(0, 8000)}]`;
          }
        }
        return JSON.stringify(p).slice(0, 3000);
      })
      .join("\n");
    return `${role}: ${parts}`;
  }
  return `${role}: [complex content]`;
}

/** The prompt of the full-summary (v1) strategy; `planContext` is the active plan, if any. */
export function v1CompactionPrompt(older: ModelMessage[], planContext = ""): string {
  const convoText = older.map((m) => formatForSummary(m, 6000)).join("\n\n");
  return [
    "You are summarizing the older portion of a coding assistant conversation.",
    "The most recent messages will be preserved verbatim — focus on summarizing what came before.",
    "Output ONLY the structured summary below. Do not include any meta-commentary about the summarization process.",
    "",
    "Create a structured summary with these sections:",
    "",
    "## Environment",
    "Project type, key technologies, working directory, any config details mentioned.",
    "",
    "## Files Touched",
    "Every file path that was read, edited, or created. For EDITS: include the specific old→new changes (function signatures, variable names, logic). For READS: note key content found.",
    "",
    "## Tool Results",
    "Key tool results that inform future decisions: grep matches, test output, diagnostics, build errors. Include literal output where it matters — don't just say 'tests passed', say which tests and any warnings.",
    "",
    "## Key Decisions",
    "Architectural choices, design patterns chosen, trade-offs discussed.",
    "",
    "## Work Completed",
    "What was accomplished. Include specific function names, variable names, code patterns.",
    "",
    "## Errors & Resolutions",
    "Problems encountered and how they were resolved. Include the actual error messages.",
    "",
    "## Current State",
    "What was being worked on at the end of this section. What remains to be done.",
    planContext
      ? `\n${planContext}\nINCLUDE the plan progress above VERBATIM in ## Current State so the agent knows which steps are done/active/pending.`
      : "",
    "",
    "Be thorough — preserve specific details (file contents, error messages, code changes).",
    "CRITICAL: Preserve specific details from tool results (file contents, error messages, test output). Generic summaries like 'edited file X' are useless — include WHAT was changed.",
    "",
    "CONVERSATION TO SUMMARIZE:",
    convoText,
  ].join("\n");
}

/**
 * The compacted conversation: the summary as a user message, an assistant acknowledgement, then
 * the kept messages without leading or orphaned tool results, which a provider would reject.
 */
export function assembleCompacted(summary: string, recent: ModelMessage[]): ModelMessage[] {
  let validStart = 0;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i]?.role === "tool") validStart = i + 1;
    else break;
  }
  // After the acknowledgement (assistant), an assistant message would break the alternation.
  if (validStart < recent.length && recent[validStart]?.role === "assistant") validStart++;
  const validRecent = validStart > 0 ? recent.slice(validStart) : recent;
  const sanitized: ModelMessage[] = [];
  for (const msg of validRecent) {
    if (msg.role === "tool" && sanitized.at(-1)?.role !== "assistant") continue;
    sanitized.push(msg);
  }
  if (sanitized.length === 0) {
    const lastUser = recent.findLast((m) => m.role === "user");
    if (lastUser) sanitized.push(lastUser);
  }
  return [
    { role: "user", content: summary },
    { role: "assistant", content: "Continuing." },
    ...sanitized,
  ];
}

/** Characters of a conversation's content, for estimating its tokens after compaction. */
export function messageChars(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content))
      return sum + m.content.reduce((s: number, p: unknown) => s + JSON.stringify(p).length, 0);
    return sum;
  }, 0);
}

export type CompactResult =
  | {
      status: "compacted";
      messages: ModelMessage[];
      summary: string;
      /** How many model messages the summary replaced. */
      compacted: number;
      strategy: "v1" | "v2";
      usage?: CompactionUsage;
    }
  | { status: "skipped"; reason: string };

/** Whether a conversation has enough older messages to compact; the reason when it has not. */
export function compactionBlocker(core: ModelMessage[], keepRecent: number): string | null {
  if (core.length < MIN_COMPACT_MESSAGES)
    return `Not enough conversation to compact (need at least ${MIN_COMPACT_MESSAGES} messages).`;
  if (splitForCompaction(core, keepRecent).older.length < 2)
    return "Not enough older messages to compact (recent messages are already preserved).";
  return null;
}

/**
 * Compacts a conversation with the configured strategy outside the terminal UI. The v2 strategy
 * rebuilds its working state from the messages, since nothing extracted it while they streamed.
 */
export async function compactConversation(opts: {
  core: ModelMessage[];
  config: Partial<CompactionConfig> | undefined;
  modelId: string;
  model: Parameters<typeof generateText>[0]["model"];
  providerOptions?: Record<string, JSONObject>;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  ioClient?: IOClient;
}): Promise<CompactResult> {
  const { core, config, model, modelId } = opts;
  const keepRecent = config?.keepRecent ?? DEFAULT_COMPACTION_CONFIG.keepRecent ?? 4;
  const blocker = compactionBlocker(core, keepRecent);
  if (blocker) return { status: "skipped", reason: blocker };
  const { older, recent } = splitForCompaction(core, keepRecent);
  const strategy = config?.strategy ?? DEFAULT_COMPACTION_CONFIG.strategy;
  let summary: string;
  let usage: CompactionUsage | undefined;
  if (strategy === "v2") {
    const wsm = new WorkingStateManager(config);
    rehydrateWorkingState(wsm, core);
    const result = await buildV2Summary({
      wsm,
      olderMessages: older,
      ...(config?.llmExtraction !== false ? { model } : {}),
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
      skipLlm: config?.llmExtraction === false,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      ...(opts.ioClient ? { ioClient: opts.ioClient } : {}),
    });
    summary = result.summary;
    usage = result.usage;
  } else {
    const startedAt = Date.now();
    const result = await generateText({
      model,
      ...(supportsTemperature(modelId) ? { temperature: 0 } : {}),
      maxOutputTokens: 8192,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      ...(opts.providerOptions && Object.keys(opts.providerOptions).length > 0
        ? { providerOptions: opts.providerOptions }
        : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
      prompt: v1CompactionPrompt(older),
    });
    summary = result.text;
    const details = (
      result.usage as {
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      }
    ).inputTokenDetails;
    usage = {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cacheReadTokens: details?.cacheReadTokens ?? 0,
      cacheWriteTokens: details?.cacheWriteTokens ?? 0,
    };
    recordModelCall({
      modelId,
      source: "compaction",
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      state: "ok",
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
    });
  }
  if (!summary || summary.trim().length < MIN_SUMMARY_CHARS)
    return {
      status: "skipped",
      reason: "Compaction produced an empty or too-short summary; the context was kept.",
    };
  return {
    status: "compacted",
    messages: assembleCompacted(summary, recent),
    summary,
    compacted: older.length,
    strategy: strategy === "v2" ? "v2" : "v1",
    ...(usage ? { usage } : {}),
  };
}
