/**
 * Rewinding a conversation in place to a checkpoint, and redoing the turns a rewind dropped.
 *
 * A rewind to checkpoint N keeps the turns up to and including N and drops the later ones into a
 * redo list; with file rollback the files the dropped turns edited go back to their content at N,
 * with the safeguards of `rollbackToCheckpoint`. A redo brings back the oldest dropped turn and,
 * when its rewind rolled files back, moves the files it edited forward to their content after it.
 */
import type { ChatMessage } from "../../types/index.js";
import { type RollbackReport, rollbackToCheckpoint } from "./fork.js";
import { buildTurns, type CheckpointTag } from "./turns.js";

export interface CheckpointSummary {
  index: number;
  /** The user message that starts the turn. */
  anchorMessageId: string;
  /** The turn's last message; a fork at it keeps the whole turn. */
  endMessageId: string;
  /** The first line of the prompt, at most 120 characters. */
  prompt: string;
  startedAt: number;
  filesEdited: string[];
  /** True when a workspace snapshot was taken at the end of the turn. */
  snapshot: boolean;
}

/** A turn a rewind dropped, kept so a redo can bring it back. */
export interface RedoTurn {
  index: number;
  anchorMessageId: string;
  prompt: string;
  messages: ChatMessage[];
  /** True when the rewind rolled the files back, so a redo moves them forward again. */
  filesRolledBack: boolean;
}

const promptLine = (text: string): string => (text.split("\n")[0] ?? "").slice(0, 120);

/** The checkpoints (turns) of a conversation, oldest first. */
export function listCheckpoints(
  messages: ChatMessage[],
  tags: CheckpointTag[],
): CheckpointSummary[] {
  return buildTurns(messages).map((turn) => {
    const anchor = messages[turn.start];
    return {
      index: turn.index,
      anchorMessageId: turn.anchorMessageId,
      endMessageId: messages[turn.end]?.id ?? turn.anchorMessageId,
      prompt: promptLine(anchor?.content ?? ""),
      startedAt: anchor?.timestamp ?? 0,
      filesEdited: turn.filesEdited,
      snapshot: tags.some(
        (t) => t.index === turn.index && t.anchorMessageId === turn.anchorMessageId,
      ),
    };
  });
}

export class RewindError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NOTHING_TO_REDO",
    message: string,
  ) {
    super(message);
  }
}

/** The conversation with every redo turn put back after it, in turn order. */
export function fullHistory(messages: ChatMessage[], redo: RedoTurn[]): ChatMessage[] {
  return [...messages, ...[...redo].sort((a, b) => a.index - b.index).flatMap((r) => r.messages)];
}

export interface RewindInput {
  cwd: string;
  messages: ChatMessage[];
  /** Turns an earlier rewind dropped; the new rewind adds to them. */
  redo: RedoTurn[];
  checkpoint: number;
  tags: CheckpointTag[];
  rollbackFiles: boolean;
  force?: boolean;
  backupTag: string;
  claimedBy?: (absPath: string) => string | null;
}

export interface RewindResult {
  messages: ChatMessage[];
  redo: RedoTurn[];
  rollback: RollbackReport | null;
}

/** Keeps the turns up to checkpoint `checkpoint` (0 keeps none) and drops the rest into `redo`. */
export async function rewindConversation(input: RewindInput): Promise<RewindResult> {
  const { messages, checkpoint } = input;
  const turns = buildTurns(messages);
  if (!Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint > turns.length)
    throw new RewindError("NOT_FOUND", `Checkpoint #${String(checkpoint)} not found`);
  const first = turns[checkpoint];
  if (!first) return { messages, redo: input.redo, rollback: null };
  // Files of turns an earlier chat-only rewind dropped are still at their latest content.
  const from = Math.max(
    turns.length,
    ...input.redo.filter((r) => !r.filesRolledBack).map((r) => r.index),
  );
  const rollback = input.rollbackFiles
    ? await rollbackToCheckpoint({
        cwd: input.cwd,
        messages: fullHistory(messages, input.redo),
        from,
        checkpoint,
        tags: input.tags,
        backupTag: input.backupTag,
        ...(input.force ? { force: true } : {}),
        ...(input.claimedBy ? { claimedBy: input.claimedBy } : {}),
      })
    : null;
  const dropped: RedoTurn[] = turns.slice(checkpoint).map((turn) => ({
    index: turn.index,
    anchorMessageId: turn.anchorMessageId,
    prompt: promptLine(messages[turn.start]?.content ?? ""),
    messages: messages.slice(turn.start, turn.end + 1),
    filesRolledBack: input.rollbackFiles,
  }));
  const earlier = input.rollbackFiles
    ? input.redo.map((r) => ({ ...r, filesRolledBack: true }))
    : input.redo;
  return {
    messages: messages.slice(0, first.start),
    redo: [...dropped, ...earlier].sort((a, b) => a.index - b.index),
    rollback,
  };
}

export interface RedoInput {
  cwd: string;
  messages: ChatMessage[];
  redo: RedoTurn[];
  tags: CheckpointTag[];
  force?: boolean;
  backupTag: string;
  claimedBy?: (absPath: string) => string | null;
}

/** Brings back the oldest dropped turn, and its files when its rewind rolled them back. */
export async function redoTurn(input: RedoInput): Promise<RewindResult & { checkpoint: number }> {
  const [next, ...rest] = [...input.redo].sort((a, b) => a.index - b.index);
  if (!next) throw new RewindError("NOTHING_TO_REDO", "Nothing to redo");
  const current = buildTurns(input.messages).length;
  const rollback = next.filesRolledBack
    ? await rollbackToCheckpoint({
        cwd: input.cwd,
        messages: fullHistory(input.messages, input.redo),
        from: current,
        checkpoint: next.index,
        tags: input.tags,
        backupTag: input.backupTag,
        ...(input.force ? { force: true } : {}),
        ...(input.claimedBy ? { claimedBy: input.claimedBy } : {}),
      })
    : null;
  return {
    messages: [...input.messages, ...next.messages],
    redo: rest,
    rollback,
    checkpoint: next.index,
  };
}
