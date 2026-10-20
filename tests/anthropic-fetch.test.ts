import { expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { withProviderHealth } from "../src/core/llm/provider-health.js";
import { anthropicFetch } from "../src/core/llm/providers/anthropic-fetch.js";

test("a buffered Messages response preserves reasoning, tool arguments and usage without retrying", async () => {
  let calls = 0;
  const base = Object.assign(async () => {
    calls++;
    return Response.json({
      id: "msg_buffered", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: "Checking the file", signature: "signed" },
        { type: "text", text: "Ready", citations: [{ type: "web_search_result_location", url: "https://example.test/source", title: "Source", encrypted_index: "index", cited_text: "Ready" }] },
        { type: "tool_use", id: "call_edit", name: "edit_file", input: { path: "value.txt", text: "ready" } },
      ],
      stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
    });
  }, { preconnect: fetch.preconnect });
  const model = createAnthropic({ apiKey: "fixture", fetch: anthropicFetch(base) })("claude-sonnet-4-6");
  const result = await generateText({ model: withProviderHealth(model, "anthropic/fixture"), prompt: "Edit", maxRetries: 0 });
  expect(calls).toBe(1);
  expect(result.text).toBe("Ready");
  expect(result.reasoningText).toBe("Checking the file");
  expect(result.sources).toMatchObject([{ sourceType: "url", url: "https://example.test/source" }]);
  expect(result.toolCalls).toMatchObject([{ toolCallId: "call_edit", toolName: "edit_file", input: { path: "value.txt", text: "ready" } }]);
  expect(result.usage.inputTokens).toBe(28);
  expect(result.usage.outputTokens).toBe(10);
  expect(result.usage.inputTokenDetails).toMatchObject({ cacheReadTokens: 5, cacheWriteTokens: 3 });
});

test("ordinary JSON requests, error responses and SSE retain their original response", async () => {
  for (const [response, stream] of [
    [Response.json({ type: "message" }), false],
    [Response.json({ error: "refused" }, { status: 401 }), true],
    [new Response("event: message_start\n\n", { headers: { "content-type": "text/event-stream" } }), true],
  ] as const) {
    const base = Object.assign(async () => response, { preconnect: fetch.preconnect });
    expect(await anthropicFetch(base)("https://example.test/v1/messages", { body: JSON.stringify({ stream }) })).toBe(response);
  }
});

test("a JSON message without a finish reason cannot become a successful stream", async () => {
  const base = Object.assign(async () => Response.json({ type: "message", content: [], stop_reason: null }), { preconnect: fetch.preconnect });
  await expect(anthropicFetch(base)("https://example.test/v1/messages", { body: '{"stream":true}' })).rejects.toThrow("Incomplete non-streaming Messages response");
});

test.each([
  [{ type: "redacted_thinking", data: "redacted" }],
  [{ type: "compaction", content: "Earlier conversation" }],
  [{ type: "compaction", content: "Earlier conversation", signature: "signed" }],
  [{ type: "server_tool_use", id: "advisor_call", name: "advisor", input: {} }],
  [{ type: "mcp_tool_use", id: "mcp_call", name: "lookup", server_name: "fixture", input: { key: "value" } },
    { type: "mcp_tool_result", tool_use_id: "mcp_call", is_error: false, content: [{ type: "text", text: "Found" }] }],
].map((content) => ({ content })))("buffered content retains SDK generation parity: %j", async ({ content }) => {
  const base = Object.assign(async () => Response.json({
    id: "msg_parity", type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 },
  }), { preconnect: fetch.preconnect });
  const model = createAnthropic({ apiKey: "fixture", fetch: anthropicFetch(base) })("claude-sonnet-4-6");
  const options = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }] };
  const ordinary = await model.doGenerate(options);
  const streamed = await withProviderHealth(model, "anthropic/fixture").doGenerate(options);
  // The streaming SDK also emits its message-start metadata as a custom content part.
  const [start, ...blocks] = streamed.content;
  expect(start).toMatchObject({ type: "custom", kind: "anthropic.message_start", providerMetadata: { anthropic: { id: "msg_parity" } } });
  expect(blocks).toEqual(ordinary.content);
  expect(streamed.usage).toEqual(ordinary.usage);
  expect(streamed.finishReason).toEqual(ordinary.finishReason);
});
