/**
 * Disk use of BAKED's own data and its cleanup actions, shared by the terminal UI's `/storage`
 * menu and the local API's `/v1/diagnostics/storage`. Project data lives in `<workspace>/.baked`,
 * global data in the user configuration directory (`~/.baked`). Clearing the repository map
 * needs the running context manager, so callers do that one themselves.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../platform/index.js";
import { SessionManager } from "../sessions/manager.js";

export interface StorageDirs {
  /** `<workspace>/.baked`. */
  projectDir: string;
  /** The user configuration directory, `~/.baked` unless `LOCALAPPDATA` names another. */
  globalDir: string;
}

export function storageDirs(workspace: string, globalDir: string = configDir()): StorageDirs {
  return { projectDir: join(workspace, ".baked"), globalDir };
}

export function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function dirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fp = join(dirPath, entry);
    try {
      const s = statSync(fp);
      total += s.isDirectory() ? dirSize(fp) : s.size;
    } catch {
      // skip
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface StorageSizes extends StorageDirs {
  repoMap: number;
  projectMemory: number;
  sessions: number;
  sessionCount: number;
  plans: number;
  projectConfig: number;
  projectTotal: number;
  history: number;
  globalMemory: number;
  globalConfig: number;
  bins: number;
  globalTotal: number;
}

const sizes = (dir: string, ...names: string[]): number =>
  names.reduce((sum, name) => sum + fileSize(join(dir, name)), 0);

/** Bytes per kind of data, with the project and global totals. */
export function computeStorageSizes(dirs: StorageDirs): StorageSizes {
  const { projectDir, globalDir } = dirs;
  const repoMap = sizes(projectDir, "repomap.db", "repomap.db-wal", "repomap.db-shm");
  const projectMemory = sizes(projectDir, "memory.db", "memory.db-wal");
  const sessions = dirSize(join(projectDir, "sessions"));
  const plans = dirSize(join(projectDir, "plans"));
  const projectConfig = sizes(projectDir, "config.json", "forbidden.json");
  const history = sizes(globalDir, "history.db", "history.db-wal");
  const globalMemory = sizes(globalDir, "memory.db", "memory.db-wal");
  const globalConfig = sizes(globalDir, "config.json", "secrets.json");
  const bins = dirSize(join(globalDir, "bin"));
  return {
    projectDir,
    globalDir,
    repoMap,
    projectMemory,
    sessions,
    sessionCount: countSessions(projectDir),
    plans,
    projectConfig,
    projectTotal: repoMap + projectMemory + sessions + plans + projectConfig,
    history,
    globalMemory,
    globalConfig,
    bins,
    globalTotal: history + globalMemory + globalConfig + bins,
  };
}

function countSessions(projectDir: string): number {
  const dir = join(projectDir, "sessions");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/** Deletes every saved plan of the project; returns the bytes freed. */
export function clearPlans(dirs: StorageDirs): number {
  const plansDir = join(dirs.projectDir, "plans");
  const before = dirSize(plansDir);
  if (before === 0) return 0;
  rmSync(plansDir, { recursive: true, force: true });
  return before;
}

/** Deletes prompt history (all projects) and compacts the database; returns the bytes freed. */
export function clearHistory(dirs: StorageDirs): number {
  const historyPath = join(dirs.globalDir, "history.db");
  if (!existsSync(historyPath)) return 0;
  const before = sizes(dirs.globalDir, "history.db", "history.db-wal");
  const db = new Database(historyPath);
  try {
    const hasTable = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'history'")
      .get();
    if (hasTable) db.run("DELETE FROM history");
    db.run("VACUUM");
  } finally {
    db.close();
  }
  return Math.max(0, before - sizes(dirs.globalDir, "history.db", "history.db-wal"));
}

/** Deletes every saved session of the project; returns how many were removed. */
export function clearSavedSessions(workspace: string): number {
  return new SessionManager(workspace).clearAllSessions();
}

/** Runs VACUUM on the repository map, memory and history databases; returns the bytes reclaimed. */
export function vacuumDatabases(dirs: StorageDirs): number {
  let freed = 0;
  const dbs = [
    join(dirs.projectDir, "repomap.db"),
    join(dirs.projectDir, "memory.db"),
    join(dirs.globalDir, "history.db"),
    join(dirs.globalDir, "memory.db"),
  ];
  for (const dbPath of dbs) {
    if (!existsSync(dbPath)) continue;
    try {
      const before = fileSize(dbPath);
      const db = new Database(dbPath);
      try {
        db.run("VACUUM");
      } finally {
        db.close();
      }
      freed += Math.max(0, before - fileSize(dbPath));
    } catch {
      // A database another process holds locked is skipped.
    }
  }
  return freed;
}
