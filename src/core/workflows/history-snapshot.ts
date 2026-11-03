/**
 * A scope in which another project's workflow store (a policy's `sizing.historyStores`) is read
 * once. An estimate reads every history store several times (an initiative view prices its
 * features, its pool and its plan charge, each from the same history), and a store opened again
 * reads the same rows again. Inside `withHistorySnapshot`, `historySnapshot` keeps what each read
 * returned until the scope ends, so a caller that knows the stores do not change meanwhile (the
 * replay corpus between two rewinds, #2766) pays for each read once. Outside a scope every read goes
 * to the store, as before.
 */
let scope: Map<string, unknown> | null = null;

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

/** `read()` once per `key` inside a `withHistorySnapshot` scope; every time outside one. */
export function historySnapshot<T>(key: string, read: () => T): T {
  if (!scope) return read();
  if (scope.has(key)) return scope.get(key) as T;
  const value = read();
  scope.set(key, value);
  return value;
}
