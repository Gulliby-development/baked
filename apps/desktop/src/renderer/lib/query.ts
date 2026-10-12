import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  cacheId,
  DEFAULT_STALE_MS,
  fetchQuery,
  type QueryKey,
  type QuerySnapshot,
  readQuery,
  revalidateQuery,
  revalidateShown,
  setQueryData,
  subscribeQuery,
} from "../client/cache.js";

export type { QueryKey } from "../client/cache.js";

export interface Query<T> extends QuerySnapshot<T> {
  /** Nothing to show yet: no cached answer and the first fetch runs. */
  loading: boolean;
  /** Fetches again now; the current data stays on screen until the answer arrives. */
  refresh: () => void;
  /** Replaces the cached answer, e.g. with the view a write returned. */
  set: (data: T) => void;
}

const NONE: QuerySnapshot<never> = {
  data: undefined,
  hasData: false,
  error: null,
  updatedAt: null,
  fetching: false,
};
const noop = () => () => {};

let focusHooked = false;
function refreshOnFocus(): void {
  if (focusHooked || typeof window === "undefined") return;
  focusHooked = true;
  window.addEventListener("focus", revalidateShown);
}

/**
 * Reads `key` through the shared cache: the cached answer at once, a background fetch when it is
 * older than `staleMs` or a write made it stale. A null key reads nothing.
 */
export function useQuery<T>(
  key: QueryKey | null,
  fetcher: () => Promise<T>,
  staleMs = DEFAULT_STALE_MS,
): Query<T> {
  const id = key ? cacheId(key) : null;
  // The key is rebuilt on every render; `id` is its identity.
  const keyRef = useRef(key);
  keyRef.current = key;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the identity of the key read.
  const subscribe = useCallback(
    (listener: () => void) => {
      const current = keyRef.current;
      return current ? subscribeQuery(current, listener) : noop();
    },
    [id],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    id ? readQuery<T>(id) : (NONE as QuerySnapshot<T>),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the identity of the key read.
  useEffect(() => {
    const current = keyRef.current;
    if (!current) return;
    refreshOnFocus();
    revalidateQuery(current, () => fetcherRef.current(), staleMs);
  }, [id, staleMs]);

  const refresh = useCallback(() => {
    const current = keyRef.current;
    if (current) void fetchQuery(current, () => fetcherRef.current());
  }, []);
  const set = useCallback((data: T) => {
    const current = keyRef.current;
    if (current) setQueryData(current, data);
  }, []);

  return {
    ...snapshot,
    loading: id !== null && !snapshot.hasData && (snapshot.fetching || snapshot.error === null),
    refresh,
    set,
  };
}
