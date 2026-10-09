/**
 * Worker-safe leaf module for compaction text-building.
 *
 * Used by io.worker.ts (buildConvoText handler) and by summarize.ts on the
 * main thread. Stays dependency-free — no provider registry, no LLM SDK
 * runtime, no UI imports. Adding deps here re-poisons the worker bundle
 * (see scripts/build.ts canary).
 *
 * `buildFullConvoText` was extracted from summarize.ts on 2026-05-27 to
 * sever the worker→TUI import chain that caused "Worker has been
 * terminated" failures in 2.18.x compiled binaries.
 */

import type { ModelMessage } from "ai";

export function buildFullConvoText(messages: ModelMessage[], charBudget: number): string {
  const parts: string[] = [];
  let chars = 0;

  for (const msg of messages) {
    if (chars >= charBudget) break;
    const text = messageTextFull(msg);
    if (!text) continue;
    const chunk = `${msg.role}: ${text}`;
    const limited = chunk.length > 2000 ? `${chunk.slice(0, 2000)}...` : chunk;
    parts.push(limited);
    chars += limited.length;
  }

  return parts.join("\n\n");
}

function messageTextFull(msg: ModelMessage): string | undefined {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null) {
        if ("text" in part) {
          texts.push(String((part as { text: string }).text));
        } else if ("type" in part) {
          const typed = part as { type: string; toolName?: string; result?: unknown };
          if (typed.type === "tool-result") {
            const resultStr = typed.result != null ? JSON.stringify(typed.result) : "null";
            texts.push(
              `[tool-result: ${typed.toolName ?? "unknown"} → ${resultStr.slice(0, 1500)}]`,
            );
          } else if (typed.type === "tool-call") {
            texts.push(`[tool-call: ${typed.toolName ?? "unknown"}]`);
          }
        }
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}
