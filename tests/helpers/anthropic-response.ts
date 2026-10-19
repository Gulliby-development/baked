/** Minimal Messages API SSE fixture, including cache usage and structured tool arguments. */
export function anthropicResponse(message: {
  id: string;
  model: string;
  type: string;
  role: string;
  content: unknown[];
  stop_reason: string;
  usage: Record<string, number>;
}): Response {
  const events: Record<string, unknown>[] = [{
    type: "message_start", message: { ...message, content: [], stop_reason: null },
  }];
  for (const [index, raw] of message.content.entries()) {
    const block = raw as { type: string; text?: string; input?: unknown };
    events.push({ type: "content_block_start", index, content_block: {
      ...block, ...(block.type === "tool_use" ? { input: {} } : { text: "" }),
    } });
    events.push({ type: "content_block_delta", index, delta: block.type === "tool_use"
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  }
  events.push({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
  events.push({ type: "message_stop" });
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
