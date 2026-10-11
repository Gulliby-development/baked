import { Alert } from "../../components/ui/alert.js";
import { Empty } from "../../components/ui/empty.js";
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
      return <div className="text-dim-foreground">Loading…</div>;
    case "error":
      return <Alert tone="error">{state.message}</Alert>;
    case "missing":
      return missing ? (
        <Empty>{missing}</Empty>
      ) : (
        <Empty className="flex flex-col items-center gap-[6px]">
          <strong className="text-foreground">Needs a newer BAKED</strong>
          <span>
            {what} need a newer <code className="font-mono">baked serve</code> than the one running
            this project. Update BAKED, then restart the project.
          </span>
        </Empty>
      );
  }
}
