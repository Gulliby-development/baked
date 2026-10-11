import { resolve } from "node:path";
import type { IntelligenceClient, IntelligenceState } from "./intelligence-client.js";
import type { WorkerLike } from "./rpc.js";

/**
 * Lets a second thread use the intelligence worker a client on another thread owns, so one process
 * runs one repository scan and one set of language servers. In the terminal UI the workflow worker
 * borrows the main thread's worker: calls and their results pass through the main thread.
 */

/** What a borrowing thread asks the owning thread. */
export type IntelligenceRelayRequest =
  | { op: "attach"; cwd: string }
  | { op: "call"; cwd: string; method: string; args: unknown[] };

/** The callback name a workflow worker sends relay requests under. */
export const INTELLIGENCE_RELAY_CALLBACK = "intelligence";

/** Methods only the owner may call: they scan, wipe or stop the shared worker, or set its summaries. */
const OWNER_ONLY = new Set([
  "close",
  "scan",
  "clear",
  "setSemanticMode",
  "generateAstSummaries",
  "generateSyntheticSummaries",
  "generateSemanticSummaries",
  "clearFreeSummaries",
  "clearSemanticSummaries",
]);
/** Events a borrower needs to keep its cached state current. */
const RELAYED_EVENTS = new Set(["scan-complete"]);

/** Serves relay requests from the owning thread's current intelligence client. */
export function serveIntelligenceRelay(
  getClient: () => IntelligenceClient | null,
  forward: (event: string, data: unknown) => void,
): { handle(request: IntelligenceRelayRequest): Promise<unknown>; dispose(): void } {
  let tapped: IntelligenceClient | null = null;
  let untap: (() => void) | null = null;
  return {
    async handle(request) {
      const client = getClient();
      if (!client || resolve(client.getCwd()) !== resolve(request.cwd))
        throw new Error("No intelligence worker to share for this workspace");
      if (client !== tapped) {
        untap?.();
        tapped = client;
        untap = client.tapEvents((event, data) => {
          if (RELAYED_EVENTS.has(event)) forward(event, data);
        });
      }
      if (request.op === "attach") return client.snapshotState();
      if (OWNER_ONLY.has(request.method))
        throw new Error(`${request.method} is reserved for the intelligence worker's owner`);
      return client.relayCall(request.method, request.args);
    },
    dispose() {
      untap?.();
      untap = null;
      tapped = null;
    },
  };
}

/** A `WorkerLike` whose calls go to the owning thread instead of a worker of its own. */
export class IntelligenceRelayTransport implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(private readonly send: (method: string, args: unknown[]) => Promise<unknown>) {}
  postMessage(message: unknown): void {
    // Init and dispose messages belong to the owner's worker; only calls cross the relay.
    const msg = message as { type?: string; id?: number; method?: string; args?: unknown[] };
    if (msg.type !== "call" || typeof msg.id !== "number" || typeof msg.method !== "string") return;
    const id = msg.id;
    this.send(msg.method, msg.args ?? []).then(
      (data) => this.deliver({ type: "result", id, data }),
      (err: unknown) =>
        this.deliver({
          type: "error",
          id,
          message: err instanceof Error ? err.message : String(err),
        }),
    );
  }
  /** Delivers an event the owner's worker emitted. */
  emit(event: string, data: unknown): void {
    this.deliver({ type: "event", event, data });
  }
  addEventListener(): void {}
  terminate(): void {}
  unref(): void {}
  private deliver(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/**
 * Attaches to the owning thread's intelligence worker. Rejects when the owner has none for `cwd`;
 * the caller then starts a worker of its own.
 */
export async function borrowIntelligence(
  cwd: string,
  request: (request: IntelligenceRelayRequest) => Promise<unknown>,
): Promise<{ client: IntelligenceClient; transport: IntelligenceRelayTransport }> {
  const state = (await request({ op: "attach", cwd })) as IntelligenceState;
  const transport = new IntelligenceRelayTransport((method, args) =>
    request({ op: "call", cwd, method, args }),
  );
  const { IntelligenceClient } = await import("./intelligence-client.js");
  const client = new IntelligenceClient(cwd, () => transport);
  client.adoptState(state);
  return { client, transport };
}
