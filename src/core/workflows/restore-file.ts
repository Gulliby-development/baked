import { syntaxErrors } from "../intelligence/syntax-check.js";
import { intentRoot } from "./effects.js";
import { readKept } from "./rollback.js";
import type { WorkflowStore } from "./store.js";

/**
 * The content `restore_file` puts back for a file the task's edits left unparsable (#1835): the
 * newest pre-image of the task's own edits of the file that parses, so the edits before the bad
 * one stay. When none parses, the file as it was before the task's first edit, whose errors are
 * not the task's. The task's edits of every attempt count: the restart of negotiate T004 (bench
 * round 56) began from the broken file, so its own first pre-image was already broken.
 */
export async function restorableVersion(
  store: WorkflowStore,
  input: { runId: string; root: string; path: string; taskId: string | null; attemptId: string },
): Promise<{ content: Buffer; editsUndone: number } | { reason: string }> {
  const generations = store.attemptTaskGenerations(input.runId);
  const ofTask = (attemptId: string) =>
    attemptId === input.attemptId ||
    (input.taskId !== null && generations.get(attemptId)?.taskId === input.taskId);
  const edits = store.effects(input.runId).filter((effect) => {
    if (effect.kind !== "file_patch" || !ofTask(effect.attempt_id)) return false;
    if (effect.status !== "applied" && effect.status !== "reconciled") return false;
    const intent = JSON.parse(effect.intent_json) as { path?: unknown };
    return intent.path === input.path && intentRoot(effect.intent_json) === input.root;
  });
  const first = edits[0];
  if (!first) return { reason: `This task has not edited ${input.path}; edit it instead.` };
  for (let i = edits.length - 1; i >= 0; i--) {
    const hash = edits[i]?.before_hash;
    if (!hash) continue;
    const content = readKept(store, input.runId, hash);
    if (!content) continue;
    if (!(await syntaxErrors(input.path, content.toString("utf8"))).length)
      return { content, editsUndone: edits.length - i };
  }
  if (!first.before_hash)
    return {
      reason: `${input.path} did not exist before this task and no version of it parsed; write it again with write_file.`,
    };
  const content = readKept(store, input.runId, first.before_hash);
  return content
    ? { content, editsUndone: edits.length }
    : {
        reason: `The content of ${input.path} before this task was not kept; fix it with edit_file.`,
      };
}
