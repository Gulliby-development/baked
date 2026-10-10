import type { Load } from "./useLoad.js";

/**
 * Loading, error and "Needs a newer BAKED" states of an insight screen. `missing` replaces the
 * newer-BAKED notice when a 404 means the item does not exist rather than an old backend.
 */
export function LoadState({
  state,
  what,
  missing,
}: {
  state: Exclude<Load<unknown>, { kind: "ready" }>;
  what: string;
  missing?: string;
}) {
  switch (state.kind) {
    case "loading":
      return <div className="muted">Loading…</div>;
    case "error":
      return <div className="banner error">{state.message}</div>;
    case "missing":
      return missing ? (
        <div className="empty">{missing}</div>
      ) : (
        <div className="empty ins-newer">
          <strong>Needs a newer BAKED</strong>
          <span>
            {what} need a newer <code className="mono">baked serve</code> than the one running this
            project. Update BAKED, then restart the project.
          </span>
        </div>
      );
  }
}
