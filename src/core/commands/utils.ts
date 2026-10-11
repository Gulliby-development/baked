import type { CommandContext } from "./types.js";

export function sysMsg(ctx: CommandContext, content: string): void {
  ctx.chat.setMessages((prev) => [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ]);
}
