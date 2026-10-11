/**
 * Chat turns as checkpoints: each non-steering user message starts turn N (1-based), and the turn
 * runs until the next one. The files a turn edited come from its successful edit tool calls.
 */
import type { ChatMessage } from "../../types/index.js";

export const EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "rename_file",
  "rename_symbol",
  "move_symbol",
  "refactor",
  "undo_edit",
]);

const READ_TOOLS = new Set([
  "Read",
  "bake_grep",
  "navigate",
  "Grep",
  "Glob",
  "bake_find",
  "bake_analyze",
  "analyze",
]);

/** A git snapshot of the workspace at the end of turn `index`; index 0 is before the first turn. */
export interface CheckpointTag {
  index: number;
  anchorMessageId: string;
  gitTag: string;
}

export interface Turn {
  index: number;
  /** The user message that starts the turn. */
  anchorMessageId: string;
  /** Position of the anchor in the message list. */
  start: number;
  /** Position of the turn's last message. */
  end: number;
  filesEdited: string[];
}

export function extractFilesFromToolCalls(msg: ChatMessage): { read: string[]; edited: string[] } {
  const read: string[] = [];
  const edited: string[] = [];
  if (!msg.toolCalls) return { read, edited };

  for (const tc of msg.toolCalls) {
    if (EDIT_TOOLS.has(tc.name) && tc.result?.success) {
      const p = tc.args.path ?? tc.args.file;
      if (typeof p === "string") edited.push(p);
      // rename_file has from/to
      if (typeof tc.args.from === "string") edited.push(tc.args.from);
      if (typeof tc.args.to === "string" && tc.name === "rename_file") edited.push(tc.args.to);
    }
    if (READ_TOOLS.has(tc.name)) {
      const p = tc.args.path ?? tc.args.file;
      if (typeof p === "string") read.push(p);
      // Read tool can have files array
      if (Array.isArray(tc.args.files)) {
        for (const f of tc.args.files) {
          if (typeof f === "object" && f && typeof (f as { path?: string }).path === "string") {
            read.push((f as { path: string }).path);
          }
        }
      }
    }
    // dispatch and other tools that report their edits
    if (tc.result?.filesEdited) {
      for (const f of tc.result.filesEdited as string[]) edited.push(f);
    }
  }
  return { read: [...new Set(read)], edited: [...new Set(edited)] };
}

export function isTurnStart(msg: ChatMessage): boolean {
  return msg.role === "user" && !msg.isSteering;
}

/** The turns of a conversation, in order. Messages before the first user message belong to none. */
export function buildTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  messages.forEach((msg, i) => {
    if (isTurnStart(msg)) {
      turns.push({
        index: turns.length + 1,
        anchorMessageId: msg.id,
        start: i,
        end: i,
        filesEdited: [],
      });
      return;
    }
    const current = turns.at(-1);
    if (!current) return;
    current.end = i;
    if (msg.role !== "assistant") return;
    for (const f of extractFilesFromToolCalls(msg).edited)
      if (!current.filesEdited.includes(f)) current.filesEdited.push(f);
  });
  return turns;
}
