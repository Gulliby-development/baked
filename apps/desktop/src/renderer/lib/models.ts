import { MODELS_READ } from "../client/api.js";
import { revalidateQuery } from "../client/cache.js";
import { chat, type ModelProvider } from "../client/chat.js";
import { useQuery } from "./query.js";

/**
 * How long a project's model list counts as fresh. It changes only when a provider is signed in or
 * out or a key is set, and those mark it stale in every project (`invalidateRead`).
 */
export const MODELS_STALE_MS = 5 * 60_000;

/** The `GET /v1/models` answer of a project, shared by every model picker in the window. */
export const modelsKey = (project: string) => [project, MODELS_READ] as const;

/** Fetches a project's model list in the background, so the first picker opens on it at once. */
export function prefetchModels(project: string): void {
  revalidateQuery(modelsKey(project), () => chat.models(project), MODELS_STALE_MS);
}

/**
 * The providers and models of a project for the chat composer: the cached list at once, refreshed
 * quietly when it is stale; `providers` is null only before the first answer.
 */
export function useChatModels(project: string): {
  providers: ModelProvider[] | null;
  error: string | null;
} {
  const query = useQuery(modelsKey(project), () => chat.models(project), MODELS_STALE_MS);
  if (query.hasData) return { providers: query.data?.providers ?? [], error: null };
  const { error } = query;
  return {
    providers: null,
    error:
      query.loading || error === null
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
  };
}
