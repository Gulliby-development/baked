/**
 * Undoing and redoing turns of a saved session from the command line: the active conversation of
 * the session is rewound and saved back, with its undone turns, as the local API does.
 */
import type { ModelMessage } from "ai";
import type { SessionManager } from "../sessions/manager.js";
import { rebuildCoreMessages } from "../sessions/rebuild.js";
import type { RollbackReport } from "./fork.js";
import { redoTurn, undoTurns } from "./undo.js";

export interface SavedRewindInput {
  store: SessionManager;
  cwd: string;
  /** Session id or unique prefix. */
  session: string;
  action: "undo" | "redo";
  /** Undo: keep the conversation up to the end of this turn (the turn before the last by default). */
  toCheckpoint?: number;
  force?: boolean;
}

export interface SavedRewindResult {
  sessionId: string;
  action: "undo" | "redo";
  /** Undo: the checkpoint the conversation went back to; redo: the turn put back. */
  checkpoint: number;
  messageCount: number;
  /** Turns a redo can still put back. */
  redoCount: number;
  rollback: RollbackReport;
}

export class SessionRewindError extends Error {}

export async function rewindSavedSession(input: SavedRewindInput): Promise<SavedRewindResult> {
  const id = input.store.findByPrefix(input.session);
  if (!id) throw new SessionRewindError(`Session ${input.session} not found`);
  const data = input.store.loadSession(id);
  if (!data) throw new SessionRewindError(`Session ${input.session} could not be read`);
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  if (!tab) throw new SessionRewindError(`Session ${input.session} has no conversation`);

  const common = {
    cwd: input.cwd,
    messages: data.tabMessages.get(tab.id) ?? [],
    redo: tab.redoTurns ?? [],
    tags: tab.checkpointTags ?? [],
    backupTag: `baked/${input.action}-backup-${crypto.randomUUID().slice(0, 8)}`,
    ...(input.force ? { force: true } : {}),
  };
  const result =
    input.action === "undo"
      ? await undoTurns({
          ...common,
          ...(input.toCheckpoint !== undefined ? { toCheckpoint: input.toCheckpoint } : {}),
        })
      : await redoTurn(common).then((r) => ({ ...r, checkpoint: r.turn }));

  const tabMessages = new Map(data.tabMessages);
  tabMessages.set(tab.id, result.messages);
  const core = new Map<string, ModelMessage[]>(data.tabCoreMessages ?? []);
  core.set(tab.id, rebuildCoreMessages(result.messages));
  const meta = {
    ...data.meta,
    updatedAt: Date.now(),
    tabs: data.meta.tabs.map((t) => (t.id === tab.id ? { ...t, redoTurns: result.redo } : t)),
  };
  await input.store.saveSession(meta, tabMessages, core);
  return {
    sessionId: id,
    action: input.action,
    checkpoint: result.checkpoint,
    messageCount: result.messages.length,
    redoCount: result.redo.length,
    rollback: result.rollback,
  };
}
