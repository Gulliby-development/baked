// Test-only transport redirect. Production providers and AI SDK serialization stay intact.
const endpoint = process.env.BAKED_WORKFLOW_TEST_ENDPOINT;
if (!endpoint?.startsWith("http://127.0.0.1:")) throw new Error("Missing local fixture endpoint");
const originalFetch = globalThis.fetch;
let transport = originalFetch;
const redirect = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "api.anthropic.com" || url.pathname !== "/v1/messages")
    throw new Error(`Fixture forbids unexpected network request: ${url.origin}${url.pathname}`);
  return transport(`${endpoint}${url.pathname}`, init);
}, { preconnect: originalFetch.preconnect });
// boot installs undici; retain that transport while keeping fixture traffic on loopback.
Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => redirect, set: (value: typeof fetch) => { transport = value; } });
