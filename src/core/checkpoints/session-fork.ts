/**
 * Forking a saved session from the command line: the active conversation of the session, cut at
 * a message or a checkpoint, saved as a new session; optionally with file rollback.
 */
import type { ModelMessage } from "ai";
import type { SessionManager } from "../sessions/manager.js";
import { rebuildCoreMessages } from "../sessions/rebuild.js";
import type { SessionMeta, TabMeta } from "../sessions/types.js";
import {
  checkpointEndMessageId,
  copyCheckpointTags,
  forkPoint,
  type RollbackReport,
  rollbackToCheckpoint,
} from "./fork.js";

export interface SavedForkInput {
  store: SessionManager;
  cwd: string;
  /** Session id or unique prefix. */
  session: string;
  atMessageId?: string;
  /** Cut after the last message of checkpoint (turn) N instead of at a message. */
  checkpoint?: number;
  rollbackFiles?: boolean;
  force?: boolean;
}

export interface SavedForkResult {
  sessionId: string;
  title: string;
  messageCount: number;
  checkpoint: number;
  rollback: RollbackReport | null;
}

export class SessionForkError extends Error {}

export async function forkSavedSession(input: SavedForkInput): Promise<SavedForkResult> {
  const id = input.store.findByPrefix(input.session);
  if (!id) throw new SessionForkError(`Session ${input.session} not found`);
  const data = input.store.loadSession(id);
  if (!data) throw new SessionForkError(`Session ${input.session} could not be read`);
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  if (!tab) throw new SessionForkError(`Session ${input.session} has no conversation`);
  const all = data.tabMessages.get(tab.id) ?? [];

  let at = input.atMessageId;
  if (input.checkpoint !== undefined) {
    const end = checkpointEndMessageId(all, input.checkpoint);
    if (!end) throw new SessionForkError(`Checkpoint #${String(input.checkpoint)} not found`);
    at = end;
  }
  const point = forkPoint(all, at);
  if (!point) throw new SessionForkError(`Message ${at} not found`);

  const newId = crypto.randomUUID();
  const newTabId = crypto.randomUUID();
  const sourceTags = tab.checkpointTags ?? [];
  const rollback = input.rollbackFiles
    ? await rollbackToCheckpoint({
        cwd: input.cwd,
        messages: all,
        checkpoint: point.checkpoint,
        tags: sourceTags,
        backupTag: `baked/fork-backup-${newId.slice(0, 8)}`,
        force: input.force === true,
      })
    : null;
  const copied = await copyCheckpointTags(input.cwd, sourceTags, point.checkpoint, newTabId);

  const messages = point.messages.map((m) => ({ ...m }));
  const sourceCore = data.tabCoreMessages?.get(tab.id);
  const core: ModelMessage[] =
    point.messages.length === all.length && sourceCore ? sourceCore : rebuildCoreMessages(messages);
  const title = `${data.meta.customTitle ?? data.meta.title} (fork)`;
  const now = Date.now();
  const { workflowRunId: _run, checkpointTags: _tags, ...rest } = tab;
  const newTab: TabMeta = {
    ...rest,
    id: newTabId,
    label: `${tab.label}-fork`,
    sessionId: newId,
    tokenUsage: { prompt: 0, completion: 0, total: 0, cacheRead: 0 },
    messageRange: { startLine: 0, endLine: messages.length },
    ...(copied.length > 0 ? { checkpointTags: copied } : {}),
  };
  const meta: SessionMeta = {
    ...data.meta,
    id: newId,
    title: data.meta.title,
    customTitle: title,
    startedAt: now,
    updatedAt: now,
    activeTabId: newTabId,
    tabs: [newTab],
  };
  await input.store.saveSession(meta, new Map([[newTabId, messages]]), new Map([[newTabId, core]]));
  return {
    sessionId: newId,
    title,
    messageCount: messages.length,
    checkpoint: point.checkpoint,
    rollback,
  };
}
