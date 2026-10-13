import { useEffect, useState } from "react";
import { formatBytes as bytes } from "../../client/diagnostics.js";
import {
  errorText,
  runs,
  runWorktrees,
  WORKTREES_CAPABILITY,
  type WorktreeCleanup,
  type WorktreeEntry,
  type WorktreeUsage,
} from "../../client/runs.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";

/** One row of the worktree list: size, the run that owns it and why a cleanup keeps it. */
export function worktreeLine(w: WorktreeEntry): string {
  const owner = w.featureId ? `${w.featureId} · ${w.status}` : "run removed by cleanup";
  const tasks = w.directories.filter((d) => d.task).length;
  return [
    owner,
    tasks ? `${tasks} task worktree${tasks === 1 ? "" : "s"}` : null,
    w.kept ? `kept: ${w.kept}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Worktrees… on the run list, as `baked workflow worktrees`: the disk use of every run worktree
 * and a cleanup of those whose run ended. Branches stay; Discard worktree on a run deletes one.
 */
export function RunsWorktrees({
  projectKey,
  onChanged,
}: {
  projectKey: string;
  onChanged: () => void;
}) {
  const [offered, setOffered] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<WorktreeUsage | null>(null);
  const [cleaned, setCleaned] = useState<WorktreeCleanup | null>(null);

  useEffect(() => {
    let live = true;
    runs.capabilities(projectKey).then(
      (caps) => live && setOffered(caps.includes(WORKTREES_CAPABILITY)),
      () => live && setOffered(false),
    );
    return () => {
      live = false;
    };
  }, [projectKey]);

  if (!offered) return null;

  const work = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const show = () => {
    setOpen(true);
    setCleaned(null);
    setUsage(null);
    void work(async () => setUsage(await runWorktrees.list(projectKey)));
  };
  const clean = () =>
    void work(async () => {
      const result = await runWorktrees.clean(projectKey);
      setCleaned(result);
      setUsage(result);
      onChanged();
    });
  const cleanable = usage?.worktrees.filter((w) => w.cleanable) ?? [];

  return (
    <>
      <Button variant="secondary" size="md" onClick={show}>
        Worktrees…
      </Button>
      <Dialog open={open} onOpenChange={(next) => !next && !busy && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run worktrees</DialogTitle>
            <DialogDescription>
              Disk use of the run and task worktrees under .baked/worktrees. Cleanup removes those
              of completed, failed and cancelled runs; their branches stay.
            </DialogDescription>
          </DialogHeader>
          {error && <Alert tone="error">{error}</Alert>}
          {cleaned && (
            <span role="status" className="text-[13px]">
              Removed {cleaned.removed.length} worktree{cleaned.removed.length === 1 ? "" : "s"} (
              {bytes(cleaned.removedBytes)}).
              {cleaned.failed.map((f) => ` Kept ${f.runId}: ${f.error}`).join("")}
            </span>
          )}
          {usage && (
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto text-[13px]">
              {usage.worktrees.length === 0 && <span>No run worktrees on disk.</span>}
              {usage.worktrees.map((w) => (
                <div key={w.runId} className="flex gap-3">
                  <span className="w-20 shrink-0 text-right font-mono">{bytes(w.bytes)}</span>
                  <span className="min-w-0">
                    <span className="font-mono">{w.runId}</span>
                    <span className="block text-muted-foreground">{worktreeLine(w)}</span>
                  </span>
                </div>
              ))}
              <span className="mt-2 font-medium">
                Total {bytes(usage.bytes)}; cleanup frees {bytes(usage.cleanableBytes)}
                {usage.trashBytes ? `; ${bytes(usage.trashBytes)} waits in .baked/trash` : ""}.
              </span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="md" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </Button>
            {cleanable.length > 0 && (
              <Button variant="danger" size="md" disabled={busy} onClick={clean}>
                Remove {cleanable.length} worktree{cleanable.length === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
