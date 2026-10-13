import { useQuery } from "../lib/query.js";
import { MODELS_READ } from "./api.js";
import { chat, type ModelProvider } from "./chat.js";

/** The models a chat can pick, read through the query cache that every model picker shares. */
export interface ChatModels {
  /** Null until the first answer; a later refresh keeps the last list. */
  providers: ModelProvider[] | null;
  /** Why the first fetch failed; null while the list loads or once one is cached. */
  error: string | null;
  /** Fetches again only when the cached list is stale. */
  revalidate: () => void;
}

/**
 * `GET /v1/models` of a project, fetched once its backend runs and kept in the shared cache, so a
 * model or effort menu opens on the list at once. A null project reads nothing.
 */
export function useChatModels(project: string | null): ChatModels {
  const query = useQuery(project === null ? null : [project, MODELS_READ], () =>
    chat.models(project ?? ""),
  );
  const { error, revalidate } = query;
  return {
    providers: query.hasData ? (query.data?.providers ?? null) : null,
    error:
      query.hasData || query.loading || error === null
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
    revalidate,
  };
}
