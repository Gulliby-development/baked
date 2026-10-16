import { useState } from "react";
import { ApiError } from "../client/api.js";
import { git } from "../client/git.js";
import { ConfirmDialog } from "./ui/confirm-dialog.js";

/** A start refused because the folder has no Git (or no commit) that worktree execution needs. */
export const needsGit = (error: unknown): boolean =>
  error instanceof ApiError && error.reason === "git_required";

/**
 * Asks before BAKED initializes Git in the project folder (src/core/git/init.ts): `git init`, a
 * `.gitignore` when there is none and a baseline commit. `onDone` gets the backend's summary line;
 * a refusal (the folder is inside another repository) stays in the dialog.
 */
export function GitInitDialog({
  projectKey,
  open,
  why,
  onDone,
  onClose,
}: {
  projectKey: string;
  open: boolean;
  /** What needs Git, shown first: "Worktree runs need Git." */
  why: string;
  onDone: (summary: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await git.run(projectKey, { action: "init" });
      if (answer.ok) onDone(answer.message);
      else setError(answer.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open={open}
      title="Initialize Git in this folder?"
      confirmLabel={busy ? "Initializing…" : "Initialize Git"}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={() => {
        setError(null);
        onClose();
      }}
    >
      {why} BAKED runs <span className="font-mono">git init</span>, writes a{" "}
      <span className="font-mono">.gitignore</span> for dependencies, build output and secrets when
      the folder has none, and commits every other file as the baseline. Files that look like
      credentials and files over 50 MB stay out of it.
    </ConfirmDialog>
  );
}
