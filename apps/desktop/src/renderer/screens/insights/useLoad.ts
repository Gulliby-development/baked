import { isMissingEndpoint } from "../../client/insights.js";
import { type QueryKey, useQuery } from "../../lib/query.js";

export type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  /** The backend predates the endpoint. */
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * Reads `key` through the shared query cache: the last answer at once, refreshed in the
 * background; `reload` fetches again and keeps showing the current data. A null `fetch` reads
 * nothing.
 */
export function useLoad<T>(
  fetch: (() => Promise<T>) | null,
  key: QueryKey,
): { state: Load<T>; reload: () => void } {
  const query = useQuery(fetch ? key : null, fetch ?? never);
  return { state: toLoad(query), reload: query.refresh };
}

const never = (): Promise<never> => new Promise(() => {});

function toLoad<T>(query: {
  hasData: boolean;
  data: T | undefined;
  error: unknown;
  loading: boolean;
}): Load<T> {
  if (query.hasData) return { kind: "ready", data: query.data as T };
  if (query.loading || query.error === null) return { kind: "loading" };
  if (isMissingEndpoint(query.error)) return { kind: "missing" };
  return {
    kind: "error",
    message: query.error instanceof Error ? query.error.message : String(query.error),
  };
}
