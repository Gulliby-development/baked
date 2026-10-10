import { useCallback, useEffect, useRef, useState } from "react";
import { isMissingEndpoint } from "../../client/insights.js";

export type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  /** The backend predates the endpoint. */
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** Loads `fetch()` whenever `deps` change; `reload` loads again with the same inputs. */
export function useLoad<T>(
  fetch: (() => Promise<T>) | null,
  deps: readonly unknown[],
): { state: Load<T>; reload: () => void } {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const loadedTick = useRef(tick);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers list the inputs of fetch in deps.
  useEffect(() => {
    if (!fetch) return;
    let live = true;
    // A reload keeps showing the current data; new inputs show loading.
    if (loadedTick.current === tick) setState({ kind: "loading" });
    loadedTick.current = tick;
    fetch().then(
      (data) => live && setState({ kind: "ready", data }),
      (error: unknown) =>
        live &&
        setState(
          isMissingEndpoint(error)
            ? { kind: "missing" }
            : { kind: "error", message: error instanceof Error ? error.message : String(error) },
        ),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, reload };
}
