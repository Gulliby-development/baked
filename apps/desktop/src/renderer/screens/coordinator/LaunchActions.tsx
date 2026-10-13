import { useCallback, useEffect, useState } from "react";
import { coordinator, type LaunchedView } from "../../client/coordinator.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { launchControl, launchName, stopEffect } from "./model.js";

/** How often launched work is read again. */
const REFRESH_MS = 5000;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the coordinator launched, read every few seconds once the coordinator is `open`; null
 * before that and from an older backend without the live view. `set` takes the list a Stop or
 * Close answered with.
 */
export function useLaunched(key: string, open: boolean) {
  const [items, set] = useState<LaunchedView[] | null>(null);
  const reload = useCallback(() => {
    coordinator.launched(key).then(
      (view) => set(view.launched),
      () => set(null),
    );
  }, [key]);
  useEffect(() => {
    if (!open) return;
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload, open]);
  return { items, set, reload };
}

/**
 * Stop or Close for one launched item. Stopping a run or an initiative asks first; closing is
 * undone with Reopen in the panel's closed list.
 */
export function LaunchActions({
  projectKey,
  item,
  onChange,
}: {
  projectKey: string;
  item: LaunchedView;
  onChange: (launched: LaunchedView[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const control = launchControl(item);
  if (!control) return null;
  const act = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const answer =
        control === "stop"
          ? await coordinator.stop(projectKey, item)
          : await coordinator.close(projectKey, item);
      setAsking(false);
      onChange(answer.launched);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const name = launchName(item);
  const label = control === "stop" ? (item.kind === "initiative" ? "Pause" : "Stop") : "Close";
  return (
    <div className="flex max-w-[220px] flex-none flex-col items-end gap-1 self-center">
      <Button
        variant={control === "stop" ? "danger" : "secondary"}
        size="sm"
        disabled={busy}
        aria-label={`${label} ${name}`}
        title={
          control === "stop" ? stopEffect(item) : "Leaves the active list; Reopen brings it back"
        }
        onClick={() =>
          control === "stop" && item.kind !== "session" ? setAsking(true) : void act()
        }
      >
        {label}
      </Button>
      {error && !asking && (
        <Alert tone="error" className="px-2 py-1 text-[12px]">
          {error}
        </Alert>
      )}
      <ConfirmDialog
        open={asking}
        title={item.kind === "run" ? `Cancel run "${name}"?` : `Pause initiative "${name}"?`}
        confirmLabel={item.kind === "run" ? "Cancel run" : "Pause"}
        danger
        busy={busy}
        error={error}
        onConfirm={() => void act()}
        onClose={() => {
          setAsking(false);
          setError(null);
        }}
      >
        {stopEffect(item)}
      </ConfirmDialog>
    </div>
  );
}
