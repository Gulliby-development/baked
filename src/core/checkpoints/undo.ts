/**
 * Undoing and redoing chat turns, shared by the terminal UI (`/undo`, `/redo`), the local API and
 * the command line.
 *
 * Undo to checkpoint N drops the turns after N from the conversation and restores the files they
 * edited to checkpoint N through `rollbackToCheckpoint`, so it leaves the same files in place a
 * fork with rollback would (changes no snapshot holds, ignored files, files outside the workspace
 * or claimed by another tab) and backs up the working tree first. The dropped turns go on a redo
 * stack, oldest first. Redo puts the oldest one back and restores the files it edited to its own
 * snapshot. A new turn makes the stack stale; front ends clear it then.
 */
import { resolve } from "node:path";
import type { ChatMessage } from "../../types/index.js";
import { RollbackError, type RollbackReport, rollbackToCheckpoint } from "./fork.js";
import { deleteTag } from "./snapshot.js";
import { buildTurns, type CheckpointTag } from "./turns.js";

/** A turn an undo dropped, with its messages, kept so a redo can put it back. */
export interface RedoTurn {
  index: number;
  anchorMessageId: string;
  messages: ChatMessage[];
}

export class TurnUndoError extends Error {
  constructor(
    readonly code: "NOTHING_TO_UNDO" | "NOTHING_TO_REDO" | "INVALID_CHECKPOINT",
    message: string,
  ) {
    super(message);
  }
}

export interface RewindOptions {
  cwd: string;
  tags: CheckpointTag[];
  /** The tag name for the backup snapshot taken before files change. */
  backupTag: string;
  force?: boolean;
  /** The label of another tab editing the file, which leaves the file in place. */
  claimedBy?: (absPath: string) => string | null;
}

export interface UndoResult {
  checkpoint: number;
  /** The conversation up to the end of turn `checkpoint`. */
  messages: ChatMessage[];
  /** The redo stack after the undo: the dropped turns and the earlier stack, oldest first. */
  redo: RedoTurn[];
  rollback: RollbackReport;
}

export interface RedoResult {
  /** The turn put back. */
  turn: number;
  messages: ChatMessage[];
  redo: RedoTurn[];
  rollback: RollbackReport;
}

/** The checkpoint a plain undo goes back to: the end of the turn before the last one. */
export function defaultUndoCheckpoint(messages: ChatMessage[]): number | null {
  const turns = buildTurns(messages).length;
  return turns > 0 ? turns - 1 : null;
}

/** Undoes the turns after checkpoint `toCheckpoint` (the last turn by default). */
export async function undoTurns(
  input: RewindOptions & { messages: ChatMessage[]; redo?: RedoTurn[]; toCheckpoint?: number },
): Promise<UndoResult> {
  const turns = buildTurns(input.messages);
  if (turns.length === 0) throw new TurnUndoError("NOTHING_TO_UNDO", "Nothing to undo");
  const checkpoint = input.toCheckpoint ?? turns.length - 1;
  if (!Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint >= turns.length)
    throw new TurnUndoError(
      "INVALID_CHECKPOINT",
      `Checkpoint #${String(checkpoint)} is not before the last turn (#${String(turns.length)})`,
    );
  const rollback = await restoreFiles(input, input.messages, checkpoint);
  const dropped = turns.slice(checkpoint);
  const cut = dropped[0]?.start ?? input.messages.length;
  const undone: RedoTurn[] = dropped.map((t) => ({
    index: t.index,
    anchorMessageId: t.anchorMessageId,
    messages: input.messages.slice(t.start, t.end + 1),
  }));
  return {
    checkpoint,
    messages: input.messages.slice(0, cut),
    redo: [...undone, ...(input.redo ?? [])].sort((a, b) => a.index - b.index),
    rollback,
  };
}

/** Puts back the oldest undone turn and restores the files it edited to its snapshot. */
export async function redoTurn(
  input: RewindOptions & { messages: ChatMessage[]; redo: RedoTurn[] },
): Promise<RedoResult> {
  const [next, ...rest] = input.redo;
  if (!next) throw new TurnUndoError("NOTHING_TO_REDO", "Nothing to redo");
  const turns = buildTurns(input.messages).length;
  if (next.index !== turns + 1)
    throw new TurnUndoError(
      "NOTHING_TO_REDO",
      "The conversation changed since the undo, so the undone turns cannot be put back",
    );
  const messages = [...input.messages, ...next.messages];
  const rollback = await restoreFiles({ ...input, editedIn: [next.index] }, messages, next.index);
  return { turn: next.index, messages, redo: rest, rollback };
}

/**
 * The file rollback of an undo or redo. Outside Git the conversation still rewinds and every file
 * the turns edited is reported as left in place.
 */
async function restoreFiles(
  input: RewindOptions & { editedIn?: number[] },
  messages: ChatMessage[],
  checkpoint: number,
): Promise<RollbackReport> {
  try {
    return await rollbackToCheckpoint({
      cwd: input.cwd,
      messages,
      checkpoint,
      tags: input.tags,
      backupTag: input.backupTag,
      ...(input.force ? { force: true } : {}),
      ...(input.claimedBy ? { claimedBy: input.claimedBy } : {}),
      ...(input.editedIn ? { editedIn: input.editedIn } : {}),
    });
  } catch (err) {
    if (!(err instanceof RollbackError) || err.code !== "NOT_GIT") throw err;
    const files = new Set<string>();
    for (const turn of buildTurns(messages)) {
      const counts = input.editedIn ? input.editedIn.includes(turn.index) : turn.index > checkpoint;
      if (counts) for (const f of turn.filesEdited) files.add(resolve(input.cwd, f));
    }
    return {
      checkpoint,
      snapshot: null,
      backupTag: null,
      restored: [],
      removed: [],
      skipped: [...files].map((path) => ({
        path,
        reason: "the workspace is not a Git repository",
      })),
    };
  }
}

/**
 * Drops the redo stack before the conversation moves on: returns the snapshot tags that still
 * describe one of its turns and deletes the Git tags of the undone turns.
 */
export async function dropRedoTags(
  cwd: string,
  messages: ChatMessage[],
  tags: CheckpointTag[],
): Promise<CheckpointTag[]> {
  const anchors = new Map<number, string>();
  for (const t of buildTurns(messages)) anchors.set(t.index, t.anchorMessageId);
  const keep: CheckpointTag[] = [];
  for (const tag of tags) {
    if (tag.index === 0 || anchors.get(tag.index) === tag.anchorMessageId) keep.push(tag);
    else await deleteTag(cwd, tag.gitTag);
  }
  return keep;
}
