import { getActiveSessionId } from "../../../stores/session.js";

// Fetch function alias — avoids Bun's typeof fetch which includes preconnect
export type ReasoningFetchFn = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
/** Stamp the active chat's conversation id onto a request's headers as both
 *  `x-session-id` and `x-session-affinity` — the keys gateways/routers use for
 *  sticky provider routing (prompt-cache locality). No-op when no session is
 *  active or the headers are already set. Mutates a Headers clone, returns it. */
function applySessionHeaders(init: RequestInit | undefined): RequestInit | undefined {
  const sessionId = getActiveSessionId();
  if (!sessionId) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("x-session-id")) headers.set("x-session-id", sessionId);
  if (!headers.has("x-session-affinity")) headers.set("x-session-affinity", sessionId);
  return { ...init, headers };
}

/** Wrap a fetch so every request carries the active chat's session headers,
 *  optionally composing with reasoning-body injection so a provider needs a
 *  single fetch override. Always returns a wrapper — session stamping applies
 *  to every provider regardless of reasoning config. Pass a `baseFetch` to wrap
 *  a non-global fetch (defaults to the global `fetch`). */
export function createSessionFetchWrapper(
  reasoningBody: Record<string, unknown> = {},
  baseFetch: ReasoningFetchFn = fetch,
): ReasoningFetchFn {
  const hasReasoning = Object.keys(reasoningBody).length > 0;

  return async (input, init): Promise<Response> => {
    let nextInit = applySessionHeaders(init);

    if (hasReasoning && nextInit?.body && typeof nextInit.body === "string") {
      try {
        const parsed = JSON.parse(nextInit.body) as Record<string, unknown>;
        nextInit = { ...nextInit, body: JSON.stringify({ ...parsed, ...reasoningBody }) };
      } catch {}
    }

    return baseFetch(input, nextInit);
  };
}

/** Bare session-header fetch wrapper for providers using a native SDK with no
 *  reasoning-body injection (Claude, OpenAI, Copilot).
 *  Drop in as the SDK's `fetch` option. */
export function withSessionHeaders(baseFetch: ReasoningFetchFn = fetch): ReasoningFetchFn {
  return async (input, init): Promise<Response> => baseFetch(input, applySessionHeaders(init));
}
