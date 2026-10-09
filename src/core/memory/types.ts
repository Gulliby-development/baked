export type MemoryScope = "global" | "project";

/**
 * Memory scope configuration.
 * - writeScope: where new memories are saved. Default 'project' (safer than global).
 * - readScope:  which memories are visible to recall.
 */
export interface MemoryScopeConfig {
  writeScope: MemoryScope | "none";
  readScope: MemoryScope | "all" | "none";
}

export type MemoryCategory = "pref" | "decision" | "gotcha" | "context";

export const MEMORY_CATEGORIES: MemoryCategory[] = ["pref", "decision", "gotcha", "context"];

export type MemorySource = "user" | "agent";

export interface MemoryRecord {
  id: string;
  category: MemoryCategory | null;
  summary: string;
  details: string;
  topics: string[];
  source: MemorySource;
  session_id: string | null;
  created_at: string;
  last_used_at: string;
  use_count: number;
  content_hash: string;
  pinned: boolean;
  hidden: boolean;
  superseded_by: string | null;
}

export interface MemoryFileRef {
  memory_id: string;
  file_id: number | null;
  path: string;
}

export interface MemoryRecallSignals {
  fts_unicode: number | null;
  fts_trigram: number | null;
  recency: number;
  use_count: number;
  file_affinity: number;
  /** Co-change neighbor affinity (0 or 1). Set when memory's file_paths
   *  intersects the git co-change neighbors of currently-edited files.
   *  Soft signal — bounded weight, can't dominate direct file_affinity. */
  cochange_affinity: number;
  blast_radius: number;
  pinned: number;
  /** Cosine similarity in [0,1]; null when no embedding/query. */
  semantic: number | null;
  /** Rank position among semantic candidates (1-indexed); null when no embedding match. */
  semantic_rank: number | null;
}

export interface MemoryRecallResult {
  record: MemoryRecord;
  /** Which scope DB this candidate came from. */
  scope: MemoryScope;
  score: number;
  normalized_score: number;
  signals: MemoryRecallSignals;
}

export interface MemoryIndex {
  scope: MemoryScope;
  total: number;
  byCategory: Record<MemoryCategory, number>;
  pinned: number;
}
/**
 * Shared template for the synthetic assistant ack that pairs with the
 * <recalled_memories> user message. Compaction extractor matches the same
 * shape (see compaction/extractor.ts) — keep them in sync via this helper.
 */
export function MEMORY_RECALL_ACK(count: number): string {
  return `Acknowledged — ${String(count)} relevant memor${count === 1 ? "y" : "ies"} surfaced.`;
}

/** Regex that matches MEMORY_RECALL_ACK output of any count. */
export const MEMORY_RECALL_ACK_PATTERN = /^Acknowledged — \d+ relevant memor(?:y|ies) surfaced\.$/;
/**
 * Human-readable badge of which recall signals fired for a memory.
 * Used in <recalled_memories> injection so the agent (and the user, via
 * tool-display formatting) can see WHY a memory was surfaced. Order is
 * stable: strongest signal first. Empty string when nothing fired (the
 * memory came in via usage-fallback only).
 */
export function describeRecallSignals(signals: MemoryRecallSignals): string {
  const parts: string[] = [];
  if (signals.file_affinity > 0) parts.push("file");
  if (signals.cochange_affinity > 0) parts.push("co-change");
  if (signals.semantic !== null && signals.semantic >= 0.4) {
    parts.push(`sem ${signals.semantic.toFixed(2)}`);
  } else if (signals.semantic_rank !== null) {
    parts.push("sem");
  }
  if (signals.fts_unicode !== null) parts.push("fts");
  else if (signals.fts_trigram !== null) parts.push("trigram");
  if (signals.pinned > 0) parts.push("★");
  return parts.join(", ");
}
