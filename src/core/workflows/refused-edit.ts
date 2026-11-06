import { type RecoveryAdvice, recoveryAdvice } from "./remedies-model.js";
import type { RuntimeState } from "./types.js";

/**
 * True when a refused edit's root (an intent root, relative to the project) is the run root, the
 * only root whose refused file `--accept-workspace` can keep (`heldRefusal`, #2609). A task worktree
 * (a batch worker, a best-of-N candidate) is rebuilt from the run root on resume, so its file is no
 * workspace change to accept (#2928).
 */
export function refusalInRunRoot(state: Pick<RuntimeState, "worktree">, root: string): boolean {
  return root === (state.worktree?.path ?? "");
}

/**
 * The stop of an attempt whose edits of `path` were refused `count` times (#954): in the run root,
 * keep the file with `--accept-workspace` or restore what the run wrote; in a task worktree, which
 * the next pass rebuilds, resume or revise, since there is nothing to accept (#2928). Every refusal
 * site builds its advice here.
 */
export function refusedEditAdvice(input: {
  runId: string;
  attemptId: string;
  path: string;
  count: number;
  root: string;
  runRoot: boolean;
}): RecoveryAdvice {
  const { runId, attemptId, path, count, root } = input;
  const head = `Edits to ${path} were refused ${String(count)} times in attempt ${attemptId}: File changed outside this attempt.`;
  if (input.runRoot)
    return recoveryAdvice(
      `${head} Keep the file as it is with \`baked workflow resume ${runId} --accept-workspace\`, or put back the content the run wrote and resume`,
      `Edits to ${path} were refused ${count} times because the file changed outside this attempt. Keep these changes, or restore the content the run wrote before retrying.`,
      { action: "accept-workspace", runId },
    );
  return recoveryAdvice(
    `${head} The refusal was in the task worktree ${root}, which is rebuilt from the run root on resume, so there is no workspace change to accept. Resume with \`baked workflow resume ${runId}\`, or revise the task`,
    `Edits to ${path} were refused ${count} times in a task worktree that is rebuilt on resume. Resume the run, or revise the task.`,
    { action: "resume", runId },
    { action: "revise", runId },
  );
}
