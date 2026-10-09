import { useEffect, useState } from "react";
import {
  fetchProviderModels,
  getCachedModels,
  type ProviderModelInfo,
} from "../core/llm/models.js";

interface UseProviderModelsReturn {
  models: ProviderModelInfo[];
  loading: boolean;
  error?: string;
}

export function useProviderModels(providerId: string | null): UseProviderModelsReturn {
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!providerId) {
      setModels([]);
      setLoading(false);
      setError(undefined);
      return;
    }

    // Check cache synchronously first
    const cached = getCachedModels(providerId);
    if (cached) {
      setModels(cached);
      setLoading(false);
      setError(undefined);
      return;
    }

    // Otherwise fetch asynchronously
    setLoading(true);
    setError(undefined);
    let cancelled = false;

    const timer = setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        setError("Model fetch timed out — showing cached models");
      }
    }, 15_000);

    fetchProviderModels(providerId).then((result) => {
      if (!cancelled) {
        clearTimeout(timer);
        setModels(result.models);
        setError(result.error);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [providerId]);

  return { models, loading, error };
}
