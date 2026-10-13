/**
 * The saved session of a headless run (`--save-session`, `--chat`): the conversation it resumes
 * with `--session ID`, the per-turn workspace snapshots that `baked session undo` and `redo`
 * restore files from, and the save back to the same session id.
 */
import type { ModelMessage } from "ai";
import { ensureBaseSnapshot, snapshotTurnEnd } from "../core/checkpoints/fork.js";
import type { CheckpointTag } from "../core/checkpoints/turns.js";
import { dropRedoTags, type RedoTurn } from "../core/checkpoints/undo.js";
import { SessionManager } from "../core/sessions/manager.js";
import { rebuildCoreMessages } from "../core/sessions/rebuild.js";
import type { SessionMeta, TabMeta } from "../core/sessions/types.js";
import type { BakeMode, ChatEffort, ChatMessage } from "../types/index.js";

const HEADLESS_TAB = "headless";

export interface HeadlessSession {
  id: string;
  /** The conversation this run continues: the session's active tab, or a new headless tab. */
  tabId: string;
  /** The saved session this run resumed; null for a new session. */
  meta: SessionMeta | null;
  /** The messages and model history saved before this run. */
  messages: ChatMessage[];
  core: ModelMessage[];
  checkpointTags: CheckpointTag[];
  redoTurns: RedoTurn[];
}

/** A new session with a fresh id. */
export function newHeadlessSession(): HeadlessSession {
  return {
    id: crypto.randomUUID(),
    tabId: HEADLESS_TAB,
    meta: null,
    messages: [],
    core: [],
    checkpointTags: [],
    redoTurns: [],
  };
}

/** The saved session with this id or unique prefix, to continue; null when there is none. */
export function openHeadlessSession(
  store: SessionManager,
  idOrPrefix: string,
): HeadlessSession | null {
  const id = store.findByPrefix(idOrPrefix);
  const data = id ? store.loadSession(id) : null;
  if (!id || !data) return null;
  // The conversation `baked session undo`, `checkpoints` and the local API work on.
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  if (!tab) return { ...newHeadlessSession(), id, meta: data.meta };
  const messages = data.tabMessages.get(tab.id) ?? [];
  return {
    id,
    tabId: tab.id,
    meta: data.meta,
    messages,
    core: data.tabCoreMessages?.get(tab.id) ?? rebuildCoreMessages(messages),
    checkpointTags: tab.checkpointTags ?? [],
    redoTurns: tab.redoTurns ?? [],
  };
}

const byIndex = (a: CheckpointTag, b: CheckpointTag) => a.index - b.index;

function addTag(session: HeadlessSession, tag: CheckpointTag): void {
  session.checkpointTags = [
    ...session.checkpointTags.filter((t) => t.index !== tag.index),
    tag,
  ].sort(byIndex);
}

/**
 * Before a turn: forgets the undone turns a new turn makes unreachable (and their snapshots), and
 * snapshots the workspace when the conversation has no snapshot yet, as the chat sessions do.
 */
export async function beginHeadlessTurn(
  session: HeadlessSession,
  cwd: string,
  before: ChatMessage[],
): Promise<void> {
  if (session.redoTurns.length > 0) {
    session.checkpointTags = await dropRedoTags(cwd, before, session.checkpointTags);
    session.redoTurns = [];
  }
  const base = await ensureBaseSnapshot(cwd, session.id, before, session.checkpointTags);
  if (base) addTag(session, base);
}

/** After a turn: snapshots the workspace when the turn edited files. */
export async function endHeadlessTurn(
  session: HeadlessSession,
  cwd: string,
  messages: ChatMessage[],
  prompt: string,
): Promise<void> {
  const tag = await snapshotTurnEnd(cwd, session.id, messages, prompt);
  if (tag) addTag(session, tag);
}

export interface HeadlessSaveInput {
  /** The whole conversation: the resumed messages and this run's turns. */
  messages: ChatMessage[];
  tokens: { input: number; output: number; cacheRead: number };
  cwd: string;
  modelId: string;
  mode: BakeMode;
  effort: ChatEffort;
}

/**
 * Saves the conversation under the session's own id. A resumed session keeps its other tabs, its
 * title and its token usage so far; the model history keeps what was saved and adds this run's
 * turns.
 */
export async function saveHeadlessSession(
  store: SessionManager,
  session: HeadlessSession,
  input: HeadlessSaveInput,
): Promise<void> {
  const prior = session.meta?.tabs.find((t) => t.id === session.tabId);
  const used = prior?.tokenUsage;
  const tab: TabMeta = {
    label: "Headless",
    planMode: false,
    planRequest: null,
    coAuthorCommits: false,
    ...prior,
    id: session.tabId,
    activeModel: input.modelId,
    sessionId: session.id,
    ...(input.effort !== "default" ? { effort: input.effort } : {}),
    tokenUsage: {
      ...used,
      prompt: (used?.prompt ?? 0) + input.tokens.input,
      completion: (used?.completion ?? 0) + input.tokens.output,
      total: (used?.total ?? 0) + input.tokens.input + input.tokens.output,
      cacheRead: (used?.cacheRead ?? 0) + input.tokens.cacheRead,
    },
    messageRange: { startLine: 0, endLine: input.messages.length },
  };
  // Empty lists are left out of the saved tab (undefined is not written).
  tab.checkpointTags = session.checkpointTags.length > 0 ? session.checkpointTags : undefined;
  tab.redoTurns = session.redoTurns.length > 0 ? session.redoTurns : undefined;
  const added = input.messages.slice(session.messages.length);
  await store.saveTab(
    session.id,
    tab,
    input.messages,
    [...session.core, ...rebuildCoreMessages(added)],
    {
      title: SessionManager.deriveTitle(input.messages),
      cwd: input.cwd,
      bakeMode: input.mode,
      activeTabId: session.meta?.activeTabId ?? session.tabId,
    },
  );
}
