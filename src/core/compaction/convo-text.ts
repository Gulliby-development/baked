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

/**
 * The text of a tool-result part for a summary prompt. AI SDK parts carry it in `output`
 * (`text`/`error-text` strings, `json`/`error-json` values, `content` parts); `result` is the
 * pre-v5 field a session saved long ago may still hold.
 */
export function toolResultText(part: object): string {
  const { output, result } = part as { output?: unknown; result?: unknown };
  if (output === undefined || output === null)
    return result != null ? JSON.stringify(result) : "null";
  if (typeof output !== "object") return String(output);
  const { type, value } = output as { type?: string; value?: unknown };
  if ((type === "text" || type === "error-text") && typeof value === "string") return value;
  if (type === "content" && Array.isArray(value))
    return value
      .map((p: { type?: string; text?: string }) =>
        typeof p?.text === "string" ? p.text : `[${p?.type ?? "part"}]`,
      )
      .join("\n");
  if (type === "execution-denied") return "[execution denied]";
  if (value !== undefined) return JSON.stringify(value);
  return JSON.stringify(output);
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
          const typed = part as { type: string; toolName?: string };
          if (typed.type === "tool-result") {
            texts.push(
              `[tool-result: ${typed.toolName ?? "unknown"} → ${toolResultText(part).slice(0, 1500)}]`,
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
