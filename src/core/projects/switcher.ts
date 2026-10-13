import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type SessionListEntry, SessionManager } from "../sessions/manager.js";
import type { RunSnapshot } from "../workflows/schemas.js";
import { type AttentionRow, WorkflowStore } from "../workflows/store.js";
import { type KnownProject, type KnownProjectOptions, listKnownProjects } from "./known.js";
import { type ProjectOverview, projectOverview } from "./overview.js";
import { realPath } from "./paths.js";
import { ProjectService } from "./service.js";

/** How many recently opened, unpinned projects the status-bar badge reads besides pinned ones. */
export const BADGE_RECENT_LIMIT = 10;

/** Other existing projects the badge reads: every pinned one and the most recently opened. */
export function badgeProjects(
  projects: readonly KnownProject[],
  currentPath: string,
  recentLimit = BADGE_RECENT_LIMIT,
): KnownProject[] {
  const current = realPath(currentPath);
  const others = projects.filter((p) => p.exists && p.path !== current);
  const recent = others
    .filter((p) => !p.pinned)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, recentLimit);
  return [...others.filter((p) => p.pinned), ...recent];
}

export interface WaitingElsewhere {
  /** Requests and blocked runs waiting for a person, summed over the projects read. */
  waiting: number;
  /** How many of those projects have anything waiting. */
  projects: number;
}

/**
 * Sums what waits for a person in other projects. Yields between folders so the terminal UI keeps
 * rendering, and counts a folder that cannot be read as having nothing waiting.
 */
export async function waitingElsewhere(
  currentPath: string,
  opts: KnownProjectOptions & { overview?: (folder: string) => ProjectOverview } = {},
): Promise<WaitingElsewhere> {
  const read = opts.overview ?? projectOverview;
  const result: WaitingElsewhere = { waiting: 0, projects: 0 };
  let projects: KnownProject[];
  try {
    projects = badgeProjects(listKnownProjects(opts), currentPath);
  } catch {
    return result;
  }
  for (const project of projects) {
    await new Promise<void>((done) => setTimeout(done, 0));
    try {
      const { attention } = read(project.path);
      if (attention > 0) {
        result.waiting += attention;
        result.projects++;
      }
    } catch {
      // An unreadable folder adds nothing to the badge.
    }
  }
  return result;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The badge text, or null when nothing waits elsewhere. */
export function waitingBadgeText(w: WaitingElsewhere): string | null {
  if (w.waiting <= 0) return null;
  return `${w.waiting} waiting in ${w.projects === 1 ? "another project" : "other projects"}`;
}

/** Run requests and blocked runs of a folder, read-only; a folder without runs has none. */
export function folderAttention(folder: string): AttentionRow[] {
  if (!existsSync(join(folder, ".baked", "workflows.sqlite"))) return [];
  let store: WorkflowStore | null = null;
  try {
    store = new WorkflowStore(folder, true);
    return store.attention();
  } catch {
    // A store this build cannot read has nothing to show.
    return [];
  } finally {
    store?.close();
  }
}

export interface ProjectWaiting {
  name: string;
  path: string;
  current: boolean;
  items: AttentionRow[];
}

/**
 * What waits for a person in this project and in the other projects the badge reads, oldest
 * request first in each; projects with nothing waiting are left out. Yields between folders.
 */
export async function waitingAcrossProjects(
  currentPath: string,
  opts: KnownProjectOptions & { read?: (folder: string) => AttentionRow[] } = {},
): Promise<ProjectWaiting[]> {
  const read = opts.read ?? folderAttention;
  const here = realPath(currentPath);
  let others: KnownProject[] = [];
  try {
    others = badgeProjects(listKnownProjects(opts), here);
  } catch {
    // Without the project list only this project is read.
  }
  const folders = [
    { name: projectName(here, opts), path: here, current: true },
    ...others.map((p) => ({ name: p.name, path: p.path, current: false })),
  ];
  const result: ProjectWaiting[] = [];
  for (const folder of folders) {
    await new Promise<void>((done) => setTimeout(done, 0));
    const items = [...read(folder.path)].sort((a, b) => a.created_at - b.created_at);
    if (items.length) result.push({ ...folder, items });
  }
  return result;
}

/** One line such as "3 sessions · 1 active run · 2 waiting". */
export function overviewLine(o: ProjectOverview): string {
  const parts = [plural(o.sessions, "session"), plural(o.activeRuns, "active run")];
  if (o.attention) parts.push(`${o.attention} waiting`);
  return parts.join(" · ");
}

/** The picker's short form: "3 sessions · 1 active · 2 waiting", leaving out zero counts. */
export function overviewBrief(o: ProjectOverview): string {
  const parts = [plural(o.sessions, "session")];
  if (o.activeRuns) parts.push(`${o.activeRuns} active`);
  if (o.attention) parts.push(`${o.attention} waiting`);
  return parts.join(" · ");
}

/** "name  path" in at most `max` characters; the path keeps its end, the name its start. */
export function fitLabel(name: string, path: string, max: number): string {
  if (name.length + 2 + path.length <= max) return `${name}  ${path}`;
  const room = max - name.length - 3;
  if (room >= 8) return `${name}  …${path.slice(-(room - 1))}`;
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** The name shown for a folder: its known-project name, else the folder name. */
export function projectName(folder: string, opts: KnownProjectOptions = {}): string {
  const path = realPath(folder);
  try {
    const known = listKnownProjects(opts).find((p) => p.path === path);
    if (known) return known.name;
  } catch {
    // Fall back to the folder name.
  }
  return basename(path) || path;
}

/**
 * Resolves a folder the user typed: `~` is the home directory, a relative path is taken from
 * `cwd`. Returns the real path, or an error message for a missing path or a file.
 */
export function resolveFolderInput(
  input: string,
  cwd: string,
): { path: string } | { error: string } {
  const raw = input.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!raw) return { error: "Enter a folder path." };
  const home = process.env.HOME ?? homedir();
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (!existsSync(absolute)) return { error: `${absolute} does not exist.` };
  try {
    if (!statSync(absolute).isDirectory()) return { error: `${absolute} is not a folder.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { path: realPath(absolute) };
}

export interface ProjectDetails {
  name: string;
  path: string;
  /** The manifest's project ID, or null for a plain folder. */
  projectId: string | null;
  sessions: SessionListEntry[];
  runs: RunSnapshot[];
  attention: AttentionRow[];
  /** The working set from `baked/project.json`; null for a plain folder. */
  workingSet: { entries: string[]; files: number; skipped: number } | null;
}

/** Sessions, runs and requests of the folder this process works in, read without changing them. */
export function projectDetails(
  folder: string,
  opts: KnownProjectOptions & { limit?: number } = {},
): ProjectDetails {
  const path = realPath(folder);
  const limit = opts.limit ?? 20;
  const details: ProjectDetails = {
    name: projectName(path, opts),
    path,
    projectId: null,
    sessions: [],
    runs: [],
    attention: [],
    workingSet: null,
  };
  try {
    details.sessions = new SessionManager(path)
      .listSessions()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    // Sessions this build cannot read are left out.
  }
  if (existsSync(join(path, ".baked", "workflows.sqlite"))) {
    let store: WorkflowStore | null = null;
    try {
      store = new WorkflowStore(path, true);
      details.runs = store.list(Math.min(100, limit)).items;
      details.attention = store.attention();
    } catch {
      // A store this build cannot read is left out.
    } finally {
      store?.close();
    }
  }
  try {
    const service = new ProjectService(path, opts.configDir ? { configDir: opts.configDir } : {});
    if (service.current()) {
      const summary = service.summary(limit);
      details.projectId = summary.id;
      details.workingSet = {
        entries: summary.workingSet.entries,
        files: summary.workingSet.files.length,
        skipped: summary.workingSet.skipped.length,
      };
    }
  } catch {
    // An invalid manifest leaves a plain folder.
  }
  return details;
}

/**
 * Runs of `folder` this process executes, read from the workspace leases: a run started from the
 * panel and one an initiative drives in the background both hold a lease with this process ID.
 */
export function runsExecutingInProcess(folder: string, pid = process.pid): string[] {
  if (!existsSync(join(folder, ".baked", "workflows.sqlite"))) return [];
  let store: WorkflowStore | null = null;
  try {
    store = new WorkflowStore(folder, true);
    const runs = new Set<string>();
    for (const lease of store.leases()) {
      if (!lease.run_id) continue;
      const owner = JSON.parse(lease.process_identity_json) as {
        pid?: number;
        exitedWorkerOwner?: string;
      };
      if (owner.pid !== pid || owner.exitedWorkerOwner === lease.owner_id) continue;
      if (store.run(lease.run_id).status === "running") runs.add(lease.run_id);
    }
    return [...runs];
  } catch {
    return [];
  } finally {
    store?.close();
  }
}
