import {
  borrowIntelligence,
  INTELLIGENCE_RELAY_CALLBACK,
  type IntelligenceRelayRequest,
} from "../../src/core/workers/intelligence-relay.js";
import { createWorkerHandler } from "../../src/core/workers/rpc.js";

// Borrows the parent thread's intelligence worker, like the workflow worker does in the terminal UI.
const ctx = createWorkerHandler({
  findSymbol: async (cwd: unknown, name: unknown) => {
    const { client } = await borrowIntelligence(cwd as string, (request: IntelligenceRelayRequest) =>
      ctx.requestCallback(INTELLIGENCE_RELAY_CALLBACK, request),
    );
    return { ready: client.isReady, location: await client.findSymbol(name as string) };
  },
});
