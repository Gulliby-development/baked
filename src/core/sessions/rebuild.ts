import type { ModelMessage, TextPart, ToolCallPart } from "ai";
import { modelMessageSchema } from "ai";
import { z } from "zod/v4";
import type { ChatMessage } from "../../types/index.js";

const coreArraySchema = z.array(modelMessageSchema);

/**
 * Validate deserialized core messages against the current AI SDK schema.
 * Returns the messages if valid, null if they need to be rebuilt from ChatMessages.
 */
export function validateCoreMessages(messages: unknown[]): ModelMessage[] | null {
  const result = coreArraySchema.safeParse(messages);
  return result.success ? result.data : null;
}

export function rebuildCoreMessages(messages: ChatMessage[]): ModelMessage[] {
  const core: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      core.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const parts: Array<TextPart | ToolCallPart> = [];
        if (msg.content) {
          parts.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          });
        }
        core.push({ role: "assistant", content: parts });
        const toolResults = msg.toolCalls.map((tc) => ({
          type: "tool-result" as const,
          toolCallId: tc.id,
          toolName: tc.name,
          output: { type: "text" as const, value: tc.result?.output ?? "" },
        }));
        core.push({ role: "tool", content: toolResults });
      } else {
        core.push({ role: "assistant", content: msg.content });
      }
    }
  }
  return core;
}
