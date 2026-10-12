import type { ModelCatalog } from "./model-choices.js";
import { fetchProviderModels } from "./models.js";
import { checkProviders } from "./provider.js";
import { getModelEffortLevels } from "./provider-options.js";

/**
 * The models of every provider, or of one with `only`: `configured` is whether a key or login is
 * available, and a provider without one lists no models. `GET /v1/models`, the routing pickers and
 * `baked workflow models` read it.
 */
export async function loadModelCatalog(only?: string): Promise<ModelCatalog> {
  const statuses = (await checkProviders()).filter((p) => only === undefined || p.id === only);
  const providers = await Promise.all(
    statuses.map(async (status) => {
      const fetched = status.available ? await fetchProviderModels(status.id) : { models: [] };
      return {
        id: status.id,
        name: status.name,
        configured: status.available,
        models: fetched.models.map((m) => {
          const id = `${status.id}/${m.id}`;
          const efforts = getModelEffortLevels(id);
          return {
            id,
            name: m.name,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            ...(efforts.length > 0 ? { efforts } : {}),
          };
        }),
        ...("error" in fetched && fetched.error ? { error: fetched.error } : {}),
      };
    }),
  );
  return { providers };
}
