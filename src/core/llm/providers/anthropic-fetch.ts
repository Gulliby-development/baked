import { withSessionHeaders } from "./reasoning-fetch.js";

/** Some Messages-compatible endpoints return a complete message even when stream is requested. */
export function anthropicFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const transport = withSessionHeaders(baseFetch);
  return Object.assign(
    async (...[input, init]: Parameters<typeof fetch>) => {
      const response = await transport(input, init);
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("application/json") ||
        typeof init?.body !== "string" ||
        (JSON.parse(init.body) as { stream?: unknown }).stream !== true
      )
        return response;

      const message = (await response.json()) as {
        type: string;
        content: Record<string, unknown>[];
        stop_reason: string | null;
        stop_sequence: string | null;
        usage: Record<string, number>;
        stop_details?: unknown;
        container?: unknown;
        safeguard_results?: unknown;
        context_management?: unknown;
        input_transformations?: unknown;
      };
      if (message.type !== "message" || !Array.isArray(message.content) || !message.stop_reason)
        throw new Error("Incomplete non-streaming Messages response");
      const events: Record<string, unknown>[] = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      ];
      for (const [index, block] of message.content.entries()) {
        const start = { ...block };
        const deltas: Record<string, unknown>[] = [];
        if (block.type === "text") {
          start.text = "";
          deltas.push({ type: "text_delta", text: block.text });
          if (Array.isArray(block.citations)) {
            start.citations = [];
            for (const citation of block.citations)
              deltas.push({ type: "citations_delta", citation });
          }
        } else if (block.type === "tool_use" || block.type === "server_tool_use") {
          start.input = {};
          // The SDK initializes advisor input to {}, rather than accumulating streamed arguments.
          if (block.type !== "server_tool_use" || block.name !== "advisor")
            deltas.push({ type: "input_json_delta", partial_json: JSON.stringify(block.input) });
        } else if (block.type === "thinking") {
          start.thinking = "";
          start.signature = "";
          deltas.push({ type: "thinking_delta", thinking: block.thinking });
          deltas.push({ type: "signature_delta", signature: block.signature });
        } else if (block.type === "compaction") {
          start.content = "";
          if (block.content) deltas.push({ type: "compaction_delta", content: block.content });
        }
        events.push({ type: "content_block_start", index, content_block: start });
        for (const delta of deltas) events.push({ type: "content_block_delta", index, delta });
        events.push({ type: "content_block_stop", index });
      }
      events.push({
        type: "message_delta",
        delta: {
          stop_reason: message.stop_reason,
          stop_sequence: message.stop_sequence,
          stop_details: message.stop_details,
          container: message.container,
          safeguard_results: message.safeguard_results,
        },
        usage: message.usage,
        context_management: message.context_management,
        input_transformations: message.input_transformations,
      });
      events.push({ type: "message_stop" });
      const headers = new Headers(response.headers);
      headers.set("content-type", "text/event-stream");
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { status: response.status, statusText: response.statusText, headers },
      );
    },
    { preconnect: baseFetch.preconnect },
  );
}
