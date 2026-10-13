/**
 * The renderer's query cache: the last answer of each read, kept per project for the life of the
 * window so a screen opened again shows it at once and refreshes it in the background
 * (stale-while-revalidate). React reads it through `useQuery` (`lib/query.ts`); writes made through
 * `call()` mark the project's entries stale.
 */

/** A project key, the name of the read, then its inputs. Two reads with the same key share data. */
export type QueryKey = readonly [project: string, name: string, ...inputs: readonly unknown[]];

export interface QuerySnapshot<T> {
  /** The last answer, kept while a refresh runs and after a refresh fails. */
  data: T | undefined;
  hasData: boolean;
  /** The error of the last fetch; null once one succeeds. */
  error: unknown;
  /** When `data` arrived (epoch ms), or null before the first answer. */
  updatedAt: number | null;
  fetching: boolean;
}

/** How long an answer counts as fresh unless a read asks otherwise. */
export const DEFAULT_STALE_MS = 30_000;
/** Entries kept for screens that are closed; the least recently used go first. */
const MAX_IDLE_ENTRIES = 200;

interface Entry {
  project: string;
  /** The name of the read, the second part of its key. */
  name: string;
  snapshot: QuerySnapshot<unknown>;
  listeners: Set<() => void>;
  inflight: Promise<void> | null;
  /** Bumped by every invalidation; an answer fetched under an older one is already stale. */
  generation: number;
  /** The generation `data` was fetched under. */
  dataGeneration: number;
  /** The fetcher of the last mounted reader, used to refresh on window focus. */
  fetcher: (() => Promise<unknown>) | null;
  staleMs: number;
  usedAt: number;
}

const EMPTY: QuerySnapshot<never> = {
  data: undefined,
  hasData: false,
  error: null,
  updatedAt: null,
  fetching: false,
};

const entries = new Map<string, Entry>();
let now: () => number = Date.now;

export function cacheId(key: QueryKey): string {
  return JSON.stringify(key);
}

function entry(key: QueryKey): Entry {
  const id = cacheId(key);
  let found = entries.get(id);
  if (!found) {
    found = {
      project: key[0],
      name: key[1],
      snapshot: EMPTY,
      listeners: new Set(),
      inflight: null,
      generation: 0,
      dataGeneration: 0,
      fetcher: null,
      staleMs: DEFAULT_STALE_MS,
      usedAt: now(),
    };
    entries.set(id, found);
    evict();
  }
  found.usedAt = now();
  return found;
}

function evict(): void {
  const idle = [...entries].filter(([, e]) => e.listeners.size === 0 && !e.inflight);
  if (idle.length <= MAX_IDLE_ENTRIES) return;
  idle.sort(([, a], [, b]) => a.usedAt - b.usedAt);
  for (const [id] of idle.slice(0, idle.length - MAX_IDLE_ENTRIES)) entries.delete(id);
}

function update(target: Entry, patch: Partial<QuerySnapshot<unknown>>): void {
  target.snapshot = { ...target.snapshot, ...patch };
  for (const listener of [...target.listeners]) listener();
}

/** The cached state of a key, by its `cacheId`. */
export function readQuery<T>(id: string): QuerySnapshot<T> {
  return (entries.get(id)?.snapshot ?? EMPTY) as QuerySnapshot<T>;
}

export function subscribeQuery(key: QueryKey, listener: () => void): () => void {
  const target = entry(key);
  target.listeners.add(listener);
  return () => {
    target.listeners.delete(listener);
    target.usedAt = now();
  };
}

function isStale(target: Entry): boolean {
  const { hasData, updatedAt } = target.snapshot;
  if (!hasData || updatedAt === null) return true;
  return target.dataGeneration !== target.generation || now() - updatedAt >= target.staleMs;
}

/**
 * Fetches `key` now unless a fetch is already running; the answer replaces the data, a failure
 * keeps it and records the error. A fetch that an invalidation overtook runs again while someone
 * still shows the data.
 */
export function fetchQuery<T>(key: QueryKey, fetcher: () => Promise<T>): Promise<void> {
  const target = entry(key);
  if (target.inflight) return target.inflight;
  const generation = target.generation;
  update(target, { fetching: true });
  const done = fetcher().then(
    (data) => {
      target.dataGeneration = generation;
      update(target, { data, hasData: true, error: null, updatedAt: now(), fetching: false });
    },
    (error: unknown) => update(target, { error, fetching: false }),
  );
  target.inflight = done.finally(() => {
    target.inflight = null;
    if (target.generation !== generation && target.listeners.size > 0)
      void fetchQuery(key, fetcher);
  });
  return target.inflight;
}

/** Fetches `key` when it has no data or its data is stale; otherwise leaves the cached answer. */
export function revalidateQuery<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  staleMs = DEFAULT_STALE_MS,
): void {
  const target = entry(key);
  target.fetcher = fetcher;
  target.staleMs = staleMs;
  if (isStale(target)) void fetchQuery(key, fetcher);
}

/** Stores an answer a screen already has, such as the view a write returned. */
export function setQueryData<T>(key: QueryKey, data: T): void {
  const target = entry(key);
  target.dataGeneration = target.generation;
  update(target, { data, hasData: true, error: null, updatedAt: now() });
}

/**
 * Marks every entry of a project stale after a write. Screens keep showing what they have; each
 * entry is fetched again when a screen next shows it, or when the window regains focus.
 */
export function invalidateProject(project: string): void {
  for (const target of entries.values()) if (target.project === project) target.generation += 1;
}

/**
 * Marks one read stale in every project, for a change outside any one project such as a provider
 * sign-in, and refreshes it at once where a screen shows it.
 */
export function invalidateRead(name: string): void {
  for (const [id, target] of entries) {
    if (target.name !== name) continue;
    target.generation += 1;
    if (target.listeners.size > 0 && target.fetcher)
      void fetchQuery(JSON.parse(id) as QueryKey, target.fetcher);
  }
}

/** Refreshes the stale entries that a mounted screen shows, e.g. when the window regains focus. */
export function revalidateShown(): void {
  for (const [id, target] of entries) {
    if (target.listeners.size === 0 || !target.fetcher || !isStale(target)) continue;
    void fetchQuery(JSON.parse(id) as QueryKey, target.fetcher);
  }
}

/** Drops the cache; tests use it with a fake clock. */
export function resetQueryCache(clock: () => number = Date.now): void {
  entries.clear();
  now = clock;
}
