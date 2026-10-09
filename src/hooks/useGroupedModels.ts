import { useEffect, useState } from "react";
import {
  fetchGroupedModels,
  getCachedGroupedModels,
  type ProviderModelInfo,
  type SubProvider,
} from "../core/llm/models.js";

interface UseGroupedModelsReturn {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  loading: boolean;
  error?: string;
}

export function useGroupedModels(providerId: string | null): UseGroupedModelsReturn {
  const [subProviders, setSubProviders] = useState<SubProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModelInfo[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!providerId) {
      setSubProviders([]);
      setModelsByProvider({});
      setLoading(false);
      setError(undefined);
      return;
    }

    const cached = getCachedGroupedModels(providerId);
    if (cached) {
      setSubProviders(cached.subProviders);
      setModelsByProvider(cached.modelsByProvider);
      setLoading(false);
      setError(cached.error);
      return;
    }

    setLoading(true);
    setError(undefined);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        setError("Provider fetch timed out — showing cached data");
      }
    }, 15_000);

    fetchGroupedModels(providerId).then((result) => {
      if (!cancelled) {
        clearTimeout(timer);
        setSubProviders(result.subProviders);
        setModelsByProvider(result.modelsByProvider);
        setError(result.error);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [providerId]);

  return { subProviders, modelsByProvider, loading, error };
}
