import { Agent, setGlobalDispatcher, fetch as undiciFetch } from "undici";

const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  connections: 64,
  pipelining: 0,
  headersTimeout: 30 * 60_000,
  bodyTimeout: 30 * 60_000,
  connectTimeout: 30_000,
});

setGlobalDispatcher(agent);

let installed = false;

/**
 * Install undici's `fetch` as `globalThis.fetch`. Idempotent. Must be
 * invoked once at process boot, before any provider is constructed.
 */
export function installGlobalFetch(): void {
  if (installed) return;
  installed = true;
  const undiciTyped = undiciFetch as unknown as typeof fetch;
  // Preserve Bun's `preconnect` so callers that use `fetch.preconnect(url)`
  // still work. Bun's preconnect warms its own pool, not undici's — so
  // calling it becomes a no-op for request routing, but it won't throw.
  if (typeof fetch.preconnect === "function" && typeof undiciTyped.preconnect !== "function") {
    (undiciTyped as unknown as { preconnect: typeof fetch.preconnect }).preconnect =
      fetch.preconnect.bind(fetch);
  }
  globalThis.fetch = undiciTyped;
}
