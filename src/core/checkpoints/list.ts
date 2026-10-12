/**
 * The checkpoint list of a conversation, shared by the local API (`GET /v1/sessions/ID/checkpoints`)
 * and the command line (`baked session checkpoints`): one entry per turn, with what an undo to it
 * would keep, and the undone turns a redo can put back.
 */
import type { ChatMessage } from "../../types/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildTurns, type CheckpointTag } from "./turns.js";
import type { RedoTurn } from "./undo.js";

const PROMPT_CHARS = 120;

export interface CheckpointEntry {
  /** Turn N, from 1; undoing to N keeps turns 1 to N. */
  index: number;
  /** The user message that starts the turn. */
  anchorMessageId: string;
  /** The turn's last message. */
  endMessageId: string;
  /** First line of the prompt, at most 120 characters. */
  prompt: string;
  startedAt: number;
  filesEdited: string[];
  /** A workspace snapshot was taken at the end of the turn, so its files can be restored. */
  snapshot: boolean;
}

export interface RedoEntry {
  index: number;
  anchorMessageId: string;
  prompt: string;
}

export interface CheckpointList {
  checkpoints: CheckpointEntry[];
  /** Undone turns a redo puts back, oldest first. */
  redo: RedoEntry[];
}

export function promptLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, PROMPT_CHARS);
}

export function listCheckpoints(
  messages: ChatMessage[],
  tags: readonly CheckpointTag[],
  redo: readonly RedoTurn[] = [],
): CheckpointList {
  const snapshots = new Set(tags.map((t) => t.index));
  return {
    checkpoints: buildTurns(messages).map((turn) => {
      const anchor = messages[turn.start];
      return {
        index: turn.index,
        anchorMessageId: turn.anchorMessageId,
        endMessageId: messages[turn.end]?.id ?? turn.anchorMessageId,
        prompt: promptLine(anchor?.content ?? ""),
        startedAt: anchor?.timestamp ?? 0,
        filesEdited: turn.filesEdited,
        snapshot: snapshots.has(turn.index),
      };
    }),
    redo: redo.map((t) => ({
      index: t.index,
      anchorMessageId: t.anchorMessageId,
      prompt: promptLine(t.messages[0]?.content ?? ""),
    })),
  };
}

export class SavedCheckpointsError extends Error {}

/** The checkpoints of a saved session's active conversation. */
export function savedSessionCheckpoints(
  store: SessionManager,
  session: string,
): CheckpointList & { sessionId: string } {
  const id = store.findByPrefix(session);
  if (!id) throw new SavedCheckpointsError(`Session ${session} not found`);
  const data = store.loadSession(id);
  if (!data) throw new SavedCheckpointsError(`Session ${session} could not be read`);
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  if (!tab) return { sessionId: id, checkpoints: [], redo: [] };
  return {
    sessionId: id,
    ...listCheckpoints(
      data.tabMessages.get(tab.id) ?? [],
      tab.checkpointTags ?? [],
      tab.redoTurns ?? [],
    ),
  };
}
