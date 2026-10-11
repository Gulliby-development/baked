/**
 * Forking a conversation at a message, optionally rolling the workspace back to the checkpoint of
 * that message.
 *
 * The checkpoint of a message is the end of the turn it belongs to, or the end of the previous
 * turn when the message is the user prompt that starts its turn. Rollback restores the files the
 * agent edited in later turns to the latest snapshot at or before that checkpoint. A file is left
 * in place, and reported, when the rollback could lose work: its current content is in none of
 * the conversation's snapshots (the user or another process changed it, or the turn that last
 * edited it has no snapshot), Git ignores it, it lies outside the workspace, another tab is
 * editing it, or no snapshot covers the checkpoint. `force` overwrites the first kind too. Before anything is written the current working tree is snapshotted to a backup tag,
 * so every rollback can be undone with Git.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../../types/index.js";
import {
  copyTag,
  isGitWorkspace,
  isIgnored,
  readFileAt,
  snapshotWorkspace,
  tagExists,
  workspacePath,
} from "./snapshot.js";
import { buildTurns, type CheckpointTag } from "./turns.js";

export class RollbackError extends Error {
  constructor(
    readonly code: "NOT_GIT" | "BACKUP_FAILED",
    message: string,
  ) {
    super(message);
  }
}

export interface ForkPoint {
  /** The messages up to and including the fork message. */
  messages: ChatMessage[];
  /** The turn whose end the files roll back to; 0 is before the first turn. */
  checkpoint: number;
}

export interface RollbackSkip {
  path: string;
  reason: string;
}

export interface RollbackReport {
  checkpoint: number;
  /** The snapshot tag the files were restored from. */
  snapshot: string | null;
  /** The tag holding the working tree as it was before the rollback, when anything changed. */
  backupTag: string | null;
  restored: string[];
  removed: string[];
  skipped: RollbackSkip[];
}

function slugify(text: string, maxLen = 30): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}

/** The tag name of a tab's checkpoint, as the terminal UI and the API create them. */
export function checkpointTagName(tabId: string, index: number, label: string): string {
  const slug = slugify(label);
  return `baked/cp-${tabId.slice(0, 8)}-${String(index)}${slug ? `-${slug}` : ""}`;
}

/** Where a fork at `atMessageId` (the whole conversation when absent) cuts history and files. */
export function forkPoint(messages: ChatMessage[], atMessageId?: string): ForkPoint | null {
  const turns = buildTurns(messages);
  if (atMessageId === undefined) return { messages, checkpoint: turns.length };
  const at = messages.findIndex((m) => m.id === atMessageId);
  if (at < 0) return null;
  const turn = turns.filter((t) => t.start <= at).at(-1);
  const checkpoint = !turn ? 0 : turn.start === at ? turn.index - 1 : turn.index;
  return { messages: messages.slice(0, at + 1), checkpoint };
}

/** The message a fork at checkpoint `index` cuts after: the last message of turn `index`. */
export function checkpointEndMessageId(messages: ChatMessage[], index: number): string | null {
  const turn = buildTurns(messages).find((t) => t.index === index);
  return turn ? (messages[turn.end]?.id ?? null) : null;
}

/** The tags that still match the conversation's turns and exist in the repository. */
async function validTags(
  cwd: string,
  messages: ChatMessage[],
  tags: CheckpointTag[],
): Promise<CheckpointTag[]> {
  const turns = buildTurns(messages);
  const out: CheckpointTag[] = [];
  for (const tag of tags) {
    const matches =
      tag.index === 0 || turns[tag.index - 1]?.anchorMessageId === tag.anchorMessageId;
    if (matches && (await tagExists(cwd, tag.gitTag))) out.push(tag);
  }
  return out.sort((a, b) => a.index - b.index);
}

const sameBytes = (a: Buffer | null, b: Buffer | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);

async function readCurrent(abs: string): Promise<Buffer | null> {
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

/** True when one of the conversation's snapshots holds exactly this content of the file. */
async function inSomeSnapshot(
  cwd: string,
  tags: CheckpointTag[],
  rel: string,
  current: Buffer | null,
): Promise<boolean> {
  for (const tag of [...tags].reverse())
    if (sameBytes(current, await readFileAt(cwd, tag.gitTag, rel))) return true;
  return false;
}

export interface RollbackInput {
  cwd: string;
  /** The whole conversation being forked, including the turns after the checkpoint. */
  messages: ChatMessage[];
  checkpoint: number;
  tags: CheckpointTag[];
  /** The tag name for the backup snapshot taken before files change. */
  backupTag: string;
  force?: boolean;
  /** The label of another tab editing the file, which leaves the file in place. */
  claimedBy?: (absPath: string) => string | null;
  /** The turns whose edited files are restored; every turn after `checkpoint` when absent. */
  editedIn?: number[];
}

/**
 * Restores the files edited after `checkpoint` (or in the `editedIn` turns) to their content at
 * that checkpoint.
 */
export async function rollbackToCheckpoint(input: RollbackInput): Promise<RollbackReport> {
  const { cwd, checkpoint } = input;
  const report: RollbackReport = {
    checkpoint,
    snapshot: null,
    backupTag: null,
    restored: [],
    removed: [],
    skipped: [],
  };
  const turns = buildTurns(input.messages);
  const files = new Map<string, { abs: string }>();
  for (const turn of turns) {
    if (input.editedIn ? !input.editedIn.includes(turn.index) : turn.index <= checkpoint) continue;
    for (const file of turn.filesEdited) {
      const abs = resolve(cwd, file);
      const rel = workspacePath(cwd, abs);
      if (rel === null) {
        if (!report.skipped.some((s) => s.path === abs))
          report.skipped.push({ path: abs, reason: "outside the workspace" });
        continue;
      }
      files.set(rel, { abs });
    }
  }
  if (files.size === 0) return report;
  if (!(await isGitWorkspace(cwd)))
    throw new RollbackError("NOT_GIT", "File rollback needs the workspace to be a Git repository");

  const tags = await validTags(cwd, input.messages, input.tags);
  const ref = tags.filter((t) => t.index <= checkpoint).at(-1) ?? null;
  report.snapshot = ref?.gitTag ?? null;

  const plan: { rel: string; abs: string; target: Buffer | null }[] = [];
  for (const [rel, { abs }] of files) {
    const skip = (reason: string) => report.skipped.push({ path: abs, reason });
    const owner = input.claimedBy?.(abs);
    if (owner) {
      skip(`being edited in ${owner}`);
      continue;
    }
    if (await isIgnored(cwd, rel)) {
      skip("ignored by Git, so no snapshot holds it");
      continue;
    }
    if (!ref) {
      skip(`no snapshot at or before checkpoint #${String(checkpoint)}`);
      continue;
    }
    const untaggedEdit = turns.some(
      (t) =>
        t.index > ref.index &&
        t.index <= checkpoint &&
        t.filesEdited.some((f) => workspacePath(cwd, resolve(cwd, f)) === rel),
    );
    if (untaggedEdit) {
      skip(`edited in a turn up to checkpoint #${String(checkpoint)} that has no snapshot`);
      continue;
    }
    const current = await readCurrent(abs);
    const target = await readFileAt(cwd, ref.gitTag, rel);
    if (sameBytes(current, target)) continue;
    if (!input.force && !(await inSomeSnapshot(cwd, tags, rel, current))) {
      skip("has changes no checkpoint holds (use force to overwrite)");
      continue;
    }
    plan.push({ rel, abs, target });
  }
  if (plan.length === 0) return report;

  if (!(await snapshotWorkspace(cwd, input.backupTag, `baked fork backup before #${checkpoint}`)))
    throw new RollbackError("BACKUP_FAILED", "Could not snapshot the workspace before rollback");
  report.backupTag = input.backupTag;

  for (const { abs, target } of plan) {
    try {
      if (target === null) {
        if (existsSync(abs)) await unlink(abs);
        report.removed.push(abs);
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, target);
        report.restored.push(abs);
      }
    } catch (err) {
      report.skipped.push({
        path: abs,
        reason: `could not be written: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return report;
}

/**
 * Copies the snapshots at or before `checkpoint` to tags of the new tab, so the fork can fork and
 * roll back again, and deleting either session keeps the other's snapshots.
 */
export async function copyCheckpointTags(
  cwd: string,
  tags: CheckpointTag[],
  checkpoint: number,
  tabId: string,
): Promise<CheckpointTag[]> {
  const out: CheckpointTag[] = [];
  for (const tag of tags) {
    if (tag.index > checkpoint) continue;
    const name = checkpointTagName(tabId, tag.index, "fork");
    if (await copyTag(cwd, tag.gitTag, name)) out.push({ ...tag, gitTag: name });
  }
  return out;
}

/** Snapshots the workspace as the state before turn `nextTurn` when the tab has no snapshot yet. */
export async function ensureBaseSnapshot(
  cwd: string,
  tabId: string,
  messages: ChatMessage[],
  tags: CheckpointTag[],
): Promise<CheckpointTag | null> {
  if (tags.length > 0 || !(await isGitWorkspace(cwd))) return null;
  const turns = buildTurns(messages);
  const index = turns.length;
  const tag: CheckpointTag = {
    index,
    anchorMessageId: turns.at(-1)?.anchorMessageId ?? "",
    gitTag: checkpointTagName(tabId, index, "base"),
  };
  return (await snapshotWorkspace(cwd, tag.gitTag, `baked checkpoint ${String(index)}`))
    ? tag
    : null;
}
