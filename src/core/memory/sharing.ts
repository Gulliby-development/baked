import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findMemoryConfig } from "./manager.js";

/** Chat memories a workflow run reads at most when sharing is on. */
export const SHARED_WITH_RUNS = 10;
const MAX_SHARED = 300;

export interface SharedChatMemory {
  category: "pref" | "decision" | "gotcha" | "context" | null;
  summary: string;
  pinned: boolean;
}

/** Whether the project's memory settings turn on the exchange with run memory (#818). */
export function sharingWithRuns(cwd: string, globalDir?: string): boolean {
  return findMemoryConfig(cwd, globalDir)?.config.shareWithRuns === true;
}

/**
 * The chat memories new workflow runs of a project read when `shareWithRuns` is on: this
 * project's memories that are pinned or are a decision, preference or gotcha, pinned first, then
 * the most recently used. Global memories, hidden or superseded ones and unpinned context notes
 * stay out, so runs get the project's settled knowledge rather than the chat's scratch notes.
 */
export function chatMemoriesForRuns(cwd: string, globalDir?: string): SharedChatMemory[] {
  if (!sharingWithRuns(cwd, globalDir)) return [];
  const path = join(cwd, ".baked", "memory.db");
  if (!existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db
      .query<{ category: SharedChatMemory["category"]; summary: string; pinned: number }, [number]>(
        `SELECT category, summary, pinned FROM memories
         WHERE hidden = 0 AND superseded_by IS NULL
           AND (pinned = 1 OR category IN ('decision', 'pref', 'gotcha'))
         ORDER BY pinned DESC, last_used_at DESC, created_at DESC LIMIT ?`,
      )
      .all(SHARED_WITH_RUNS);
    return rows.map((r) => {
      const flat = r.summary.split(/\s+/).filter(Boolean).join(" ");
      return {
        category: r.category,
        summary: flat.length > MAX_SHARED ? `${flat.slice(0, MAX_SHARED - 1)}…` : flat,
        pinned: r.pinned === 1,
      };
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
