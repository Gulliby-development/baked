/**
 * Rewinding a saved session in place from the command line, and redoing what it dropped.
 *
 * The rewind and redo run on `rewindConversation` and `redoTurn`, as the local API does. Between
 * invocations the dropped turns are saved with the session's tab, next to the id of the message
 * the conversation ended with after the rewind. Any later change to the conversation (a new turn
 * in the terminal UI, a fork, a compaction) ends it somewhere else, and the saved turns are
 * discarded instead of being put back after it.
 */
import type { ChatMessage } from "../../types/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { rebuildCoreMessages } from "../sessions/rebuild.js";
import type { SessionMeta, TabMeta } from "../sessions/types.js";
import type { RollbackReport } from "./fork.js";
import {
  type CheckpointSummary,
  listCheckpoints,
  type RedoTurn,
  redoTurn,
  rewindConversation,
} from "./rewind.js";

export class SessionRewindError extends Error {}

export interface RedoSummary {
  index: number;
  prompt: string;
  filesRolledBack: boolean;
}

export interface SavedCheckpoints {
  sessionId: string;
  checkpoints: CheckpointSummary[];
  redo: RedoSummary[];
}

export interface SavedRewindResult {
  sessionId: string;
  /** The checkpoint the conversation now ends at. */
  checkpoint: number;
  messageCount: number;
  rollback: RollbackReport | null;
  redo: RedoSummary[];
}

interface Loaded {
  id: string;
  data: NonNullable<ReturnType<SessionManager["loadSession"]>>;
  tab: TabMeta;
  messages: ChatMessage[];
  redo: RedoTurn[];
}

function load(store: SessionManager, session: string): Loaded {
  const id = store.findByPrefix(session);
  if (!id) throw new SessionRewindError(`Session ${session} not found`);
  const data = store.loadSession(id);
  if (!data) throw new SessionRewindError(`Session ${session} could not be read`);
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  if (!tab) throw new SessionRewindError(`Session ${session} has no conversation`);
  const messages = data.tabMessages.get(tab.id) ?? [];
  const lastId = messages.at(-1)?.id ?? null;
  const redo = tab.redo && tab.redo.afterMessageId === lastId ? tab.redo.turns : [];
  return { id, data, tab, messages, redo };
}

const summaries = (redo: RedoTurn[]): RedoSummary[] =>
  redo.map(({ index, prompt, filesRolledBack }) => ({ index, prompt, filesRolledBack }));

async function save(
  store: SessionManager,
  loaded: Loaded,
  messages: ChatMessage[],
  redo: RedoTurn[],
): Promise<void> {
  const { data, tab } = loaded;
  const { redo: _old, ...rest } = tab;
  const nextTab: TabMeta = {
    ...rest,
    ...(redo.length > 0
      ? { redo: { afterMessageId: messages.at(-1)?.id ?? null, turns: redo } }
      : {}),
  };
  const meta: SessionMeta = {
    ...data.meta,
    updatedAt: Date.now(),
    tabs: data.meta.tabs.map((t) => (t.id === tab.id ? nextTab : t)),
  };
  const tabMessages = new Map(data.tabMessages);
  tabMessages.set(tab.id, messages);
  const core = new Map(data.tabCoreMessages ?? []);
  if (messages.length !== loaded.messages.length) core.set(tab.id, rebuildCoreMessages(messages));
  await store.saveSession(meta, tabMessages, core);
}

/** The checkpoints of a saved session's active conversation and the turns a redo can bring back. */
export function listSavedCheckpoints(store: SessionManager, session: string): SavedCheckpoints {
  const { id, tab, messages, redo } = load(store, session);
  return {
    sessionId: id,
    checkpoints: listCheckpoints(messages, tab.checkpointTags ?? []),
    redo: summaries(redo),
  };
}

export interface SavedRewindInput {
  store: SessionManager;
  cwd: string;
  /** Session id or unique prefix. */
  session: string;
  /** Keep the turns up to and including this one; 0 keeps none. */
  checkpoint: number;
  rollbackFiles?: boolean;
  force?: boolean;
}

export async function rewindSavedSession(input: SavedRewindInput): Promise<SavedRewindResult> {
  const loaded = load(input.store, input.session);
  const result = await rewindConversation({
    cwd: input.cwd,
    messages: loaded.messages,
    redo: loaded.redo,
    checkpoint: input.checkpoint,
    tags: loaded.tab.checkpointTags ?? [],
    rollbackFiles: input.rollbackFiles === true,
    backupTag: `baked/rewind-backup-${crypto.randomUUID().slice(0, 8)}`,
    ...(input.force ? { force: true } : {}),
  });
  await save(input.store, loaded, result.messages, result.redo);
  return {
    sessionId: loaded.id,
    checkpoint: input.checkpoint,
    messageCount: result.messages.length,
    rollback: result.rollback,
    redo: summaries(result.redo),
  };
}

export interface SavedRedoInput {
  store: SessionManager;
  cwd: string;
  session: string;
  force?: boolean;
}

/** Brings back the oldest turn a command-line rewind dropped, with its files when rolled back. */
export async function redoSavedSession(input: SavedRedoInput): Promise<SavedRewindResult> {
  const loaded = load(input.store, input.session);
  const result = await redoTurn({
    cwd: input.cwd,
    messages: loaded.messages,
    redo: loaded.redo,
    tags: loaded.tab.checkpointTags ?? [],
    backupTag: `baked/redo-backup-${crypto.randomUUID().slice(0, 8)}`,
    ...(input.force ? { force: true } : {}),
  });
  await save(input.store, loaded, result.messages, result.redo);
  return {
    sessionId: loaded.id,
    checkpoint: result.checkpoint,
    messageCount: result.messages.length,
    rollback: result.rollback,
    redo: summaries(result.redo),
  };
}
