/**
 * A scope in which another project's workflow store (a policy's `sizing.historyStores`) is read
 * once. An estimate reads every history store several times (an initiative view prices its
 * features, its pool and its plan charge, each from the same history), and a store opened again
 * reads the same rows again. Inside `withHistorySnapshot`, `historySnapshot` keeps what each read
 * returned until the scope ends, so a caller that knows the stores do not change meanwhile (the
 * replay corpus between two rewinds, #2766) pays for each read once. Outside a scope every read goes
 * to the store, as before.
 *
 * A store can also be pinned to an identity that names its content (`pinHistoryStore`): the replay
 * corpus opens each history trace afresh for every initiative it replays and only ever removes runs
 * from it, so the trace file and the runs removed name what the store holds. A pinned store's reads
 * are kept for the whole process under that identity, so every start of every replay that reads the
 * same trace with the same runs removed pays for each read once (a merge queue's macOS shard spent
 * 16 minutes on one corpus file, most of it reading the same history traces again, #3014).
 */
let scope: Map<string, unknown> | null = null;

/** A pinned store's path to the identity of its content. */
const pins = new Map<string, string>();
/** Reads of pinned stores, by kind and identity, for the life of the process. */
const pinned = new Map<string, unknown>();

/** Runs `fn` with history-store reads kept for its duration; scopes nest. */
export function withHistorySnapshot<T>(fn: () => T): T {
  const outer = scope;
  scope = new Map();
  try {
    return fn();
  } finally {
    scope = outer;
  }
}

/**
 * Names the content of the store at `store` (its database file) by `identity` until it is unpinned
 * (`identity` null). The caller promises that two stores pinned to the same identity hold the same
 * rows, and pins the store again whenever its rows change.
 */
export function pinHistoryStore(store: string, identity: string | null): void {
  if (identity === null) pins.delete(store);
  else pins.set(store, identity);
}

/** Whether reads of the store at `store` are kept now: it is pinned, or a scope is open. */
export function historySnapshotting(store: string): boolean {
  return scope !== null || pins.has(store);
}

/**
 * `read()` once per `kind` of read of the store at `store` (its database file): for the life of the
 * process for a pinned store, inside a `withHistorySnapshot` scope for another, every time outside
 * one.
 */
export function historySnapshot<T>(store: string, kind: string, read: () => T): T {
  const identity = pins.get(store);
  const cache = identity === undefined ? scope : pinned;
  if (!cache) return read();
  const key = `${kind}:${identity ?? store}`;
  if (cache.has(key)) return cache.get(key) as T;
  const value = read();
  cache.set(key, value);
  return value;
}
