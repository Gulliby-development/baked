/**
 * What the chat agent remembers across sessions, as the memory browsers show it: the terminal UI's
 * `/memory`, the local API's `/v1/memory` and the desktop's Chat memory page. Workflow run memory
 * is a different store (src/core/workflows/project-memory.ts).
 */
import type { MemoryManager, ScopedMemory } from "./manager.js";
import type { MemoryCategory, MemoryRecord, MemoryScope, MemoryScopeConfig } from "./types.js";

export interface ChatMemoryEntry {
  id: string;
  scope: MemoryScope;
  category: MemoryCategory | null;
  summary: string;
  details: string;
  topics: string[];
  source: "user" | "agent";
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
  pinned: boolean;
  hidden: boolean;
}

export interface ChatMemorySettings extends MemoryScopeConfig {
  shareWithRuns: boolean;
  /** Where these settings are saved. */
  settingsScope: "project" | "global";
}

export interface ChatMemoryView {
  settings: ChatMemorySettings;
  entries: ChatMemoryEntry[];
  hidden: ChatMemoryEntry[];
  /** Set when enough sessions and stale memories piled up since the last cleanup. */
  cleanupHint: { sessions: number; total: number; stale: number } | null;
}

export type CleanupKind = "duplicate" | "dead" | "stale" | "similar";

/** A memory the cleanup suggests hiding: a duplicate, one whose files are gone, unused or similar. */
export interface CleanupCandidate {
  id: string;
  scope: MemoryScope;
  kind: CleanupKind;
  summary: string;
  /** Why it is listed, e.g. which memory it duplicates or which files are missing. */
  detail: string;
  /** The memory a duplicate or similar one would give way to. */
  keeperId?: string;
}

export interface CleanupAction {
  id: string;
  scope: MemoryScope;
  action: "hide" | "pin";
}

export type ChatMemoryEdit =
  | { action: "pin" | "unpin" | "hide" | "restore"; scope: MemoryScope; id: string }
  | {
      action: "edit";
      scope: MemoryScope;
      id: string;
      summary: string;
      details?: string;
      category?: MemoryCategory | null;
    };

const oneLine = (text: string): string => text.replace(/[\n\r]+/g, " ");

function entry(m: MemoryRecord, scope: MemoryScope): ChatMemoryEntry {
  return {
    id: m.id,
    scope,
    category: m.category,
    summary: m.summary,
    details: m.details,
    topics: m.topics,
    source: m.source,
    createdAt: m.created_at,
    lastUsedAt: m.last_used_at,
    useCount: m.use_count,
    pinned: m.pinned,
    hidden: m.hidden,
  };
}

const scoped = (m: ScopedMemory): ChatMemoryEntry => entry(m, m.scope);

export function chatMemorySettings(manager: MemoryManager): ChatMemorySettings {
  return {
    ...manager.scopeConfig,
    shareWithRuns: manager.scopeConfig.shareWithRuns ?? false,
    settingsScope: manager.settingsScope,
  };
}

/** Active memories of both scopes, then hidden ones that can be restored. */
export function chatMemoryView(manager: MemoryManager): ChatMemoryView {
  const all = manager.list("all", { includeHidden: true });
  return {
    settings: chatMemorySettings(manager),
    entries: all.filter((m) => !m.hidden).map(scoped),
    hidden: all.filter((m) => m.hidden).map(scoped),
    cleanupHint: manager.cleanupHint(),
  };
}

/**
 * Applies one change to a memory. Returns false when the memory does not exist. Editing keeps the
 * memory's ID, topics and pin, and makes a hidden memory visible again.
 */
export function editChatMemory(manager: MemoryManager, edit: ChatMemoryEdit): boolean {
  const record = manager.read(edit.scope, edit.id);
  if (!record) return false;
  switch (edit.action) {
    case "pin":
      return manager.pin(edit.scope, edit.id);
    case "unpin":
      return manager.unpin(edit.scope, edit.id);
    case "hide":
      return manager.softDelete(edit.scope, edit.id);
    case "restore":
      return manager.restore(edit.scope, edit.id);
    case "edit":
      manager.write(edit.scope, {
        id: edit.id,
        summary: edit.summary,
        details: edit.details ?? record.details,
        category: edit.category === undefined ? record.category : edit.category,
        topics: record.topics,
        source: record.source,
      });
      return true;
  }
}

/** Changes the scope settings; `settingsScope` moves the saved settings between project and global. */
export function setChatMemorySettings(
  manager: MemoryManager,
  change: Partial<ChatMemorySettings>,
): ChatMemorySettings {
  const { settingsScope, ...scopes } = change;
  if (settingsScope && settingsScope !== manager.settingsScope)
    manager.setSettingsScope(settingsScope);
  if (scopes.writeScope || scopes.readScope || scopes.shareWithRuns !== undefined) {
    const { shareWithRuns: _, ...current } = manager.scopeConfig;
    const share = scopes.shareWithRuns ?? manager.scopeConfig.shareWithRuns ?? false;
    manager.scopeConfig = {
      ...current,
      writeScope: scopes.writeScope ?? current.writeScope,
      readScope: scopes.readScope ?? current.readScope,
      ...(share ? { shareWithRuns: true } : {}),
    };
  }
  return chatMemorySettings(manager);
}

/**
 * Cleanup suggestions: exact duplicates, memories whose linked files are all gone, the stalest
 * unpinned ones, and members of similarity clusters other than the cluster's keeper (pinned, then
 * most used, then most recent). A memory is listed once, under the first reason found.
 */
export function chatMemoryCleanup(
  manager: MemoryManager,
  fileExists: (path: string) => boolean,
): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  const listed = (id: string, scope: MemoryScope) =>
    out.some((c) => c.id === id && c.scope === scope);
  for (const group of manager.findDuplicates("all")) {
    for (const dupe of group.dupes) {
      out.push({
        id: dupe.id,
        scope: group.scope,
        kind: "duplicate",
        summary: oneLine(dupe.summary),
        detail: `dup of ${group.kept.id.slice(0, 8)}`,
        keeperId: group.kept.id,
      });
    }
  }
  for (const dead of manager.findDeadFileRefs("all", fileExists)) {
    out.push({
      id: dead.record.id,
      scope: dead.scope,
      kind: "dead",
      summary: oneLine(dead.record.summary),
      detail: dead.deadPaths.slice(0, 2).join(", ") + (dead.deadPaths.length > 2 ? "…" : ""),
    });
  }
  for (const stale of manager.staleCandidates("all", 25)) {
    if (listed(stale.record.id, stale.scope)) continue;
    out.push({
      id: stale.record.id,
      scope: stale.scope,
      kind: "stale",
      summary: oneLine(stale.record.summary),
      detail: `${stale.ageDays.toFixed(0)}d unused, ×${String(stale.record.use_count)}`,
    });
  }
  for (const cluster of manager.similarClusters("all", 0.7)) {
    if (cluster.members.length < 2) continue;
    const [keeper, ...rest] = [...cluster.members].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.use_count !== b.use_count) return b.use_count - a.use_count;
      return Date.parse(b.last_used_at) - Date.parse(a.last_used_at);
    });
    if (!keeper) continue;
    for (const member of rest) {
      if (listed(member.id, cluster.scope)) continue;
      out.push({
        id: member.id,
        scope: cluster.scope,
        kind: "similar",
        summary: oneLine(member.summary),
        detail: `~${keeper.id.slice(0, 8)} (${(cluster.avgWeight * 100).toFixed(0)}%)`,
        keeperId: keeper.id,
      });
    }
  }
  return out;
}

/** Hides or pins the chosen cleanup candidates and records that a cleanup ran. */
export function applyChatMemoryCleanup(
  manager: MemoryManager,
  actions: readonly CleanupAction[],
): { hidden: number; pinned: number } {
  let hidden = 0;
  let pinned = 0;
  for (const a of actions) {
    if (a.action === "hide" && manager.softDelete(a.scope, a.id)) hidden++;
    else if (a.action === "pin" && manager.pin(a.scope, a.id)) pinned++;
  }
  manager.noteCleanupCompleted();
  return { hidden, pinned };
}
