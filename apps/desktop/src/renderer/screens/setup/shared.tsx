import { type DependencyList, type ReactNode, useCallback, useEffect, useState } from "react";
import { isMissingEndpoint, isNoProject } from "../../client/setup.js";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "missing" }
  | { state: "no-project" }
  | { state: "error"; message: string };

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Loads once per dependency change; a 404 from an older backend becomes `missing`, and one from a
 * folder without baked/project.json becomes `no-project`.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: DependencyList,
): [Loaded<T>, () => void, (data: T) => void] {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers name the inputs of `load`.
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setValue({ state: "ready", data }),
      (error: unknown) =>
        live &&
        setValue(
          isMissingEndpoint(error)
            ? { state: "missing" }
            : isNoProject(error)
              ? { state: "no-project" }
              : { state: "error", message: errorText(error) },
        ),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((data: T) => setValue({ state: "ready", data }), []);
  return [value, reload, set];
}

export function NeedsNewer({ what }: { what: string }) {
  return (
    <div className="banner setup-needs">
      Needs a newer BAKED: this project's backend cannot show {what} yet. Update BAKED, or point
      Settings → BAKED executable at a newer one.
    </div>
  );
}

/** The non-ready states of a `Loaded`, or null when the data is there. */
export function LoadState({ value, what }: { value: Loaded<unknown>; what: string }) {
  if (value.state === "loading") return <div className="muted">Loading {what}…</div>;
  if (value.state === "missing") return <NeedsNewer what={what} />;
  if (value.state === "no-project")
    return (
      <div className="empty">
        This folder has no <span className="mono">baked/project.json</span> yet. Run{" "}
        <span className="mono">baked project init</span> in the folder to create one.
      </div>
    );
  if (value.state === "error") return <div className="banner error">{value.message}</div>;
  return null;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "warn" | "err" }) {
  return <span className={`setup-tag${tone ? ` ${tone}` : ""}`}>{children}</span>;
}
