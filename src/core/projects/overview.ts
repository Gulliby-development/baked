import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../sessions/manager.js";
import type { RunState } from "../workflows/schemas.js";
import { WorkflowStore } from "../workflows/store.js";

/** Sessions and runs of a known project, read from its own stores without changing them. */
export interface ProjectOverview {
  sessions: number;
  lastSessionAt: number | null;
  /** Runs that are not completed, failed or cancelled. */
  activeRuns: number;
  /** Pending requests and blocked runs: what waits for a person in this folder. */
  attention: number;
}

const ACTIVE: readonly RunState[] = ["created", "running", "waiting", "paused", "blocked"];

/** Counts sessions and runs in a folder's `.baked/`; a missing or unreadable store counts as empty. */
export function projectOverview(folder: string): ProjectOverview {
  const overview: ProjectOverview = {
    sessions: 0,
    lastSessionAt: null,
    activeRuns: 0,
    attention: 0,
  };
  if (!existsSync(folder)) return overview;
  try {
    const sessions = new SessionManager(folder).listSessions();
    overview.sessions = sessions.length;
    for (const s of sessions)
      if (overview.lastSessionAt === null || s.updatedAt > overview.lastSessionAt)
        overview.lastSessionAt = s.updatedAt;
  } catch {
    // Sessions this build cannot read are left out.
  }
  if (!existsSync(join(folder, ".baked", "workflows.sqlite"))) return overview;
  let store: WorkflowStore | null = null;
  try {
    store = new WorkflowStore(folder, true);
    const counts = store.statusCounts();
    overview.activeRuns = ACTIVE.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
    overview.attention = store.attention().length;
  } catch {
    // A store this build cannot read is left out.
  } finally {
    store?.close();
  }
  return overview;
}
