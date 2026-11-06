import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How old a directory from before #2967 (no process id in its name) must be before a sweep removes it. */
export const LEGACY_TEMP_AGE_MS = 60 * 60 * 1000;

const swept = new Set<string>();

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when a process with this id is running (a process owned by another user counts as running). */
export function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the directories under `root` that `processTempDir(prefix)` made for a process that is no
 * longer running, and the ones from before #2967 (`<prefix>XXXXXX`, no process id) older than
 * `LEGACY_TEMP_AGE_MS`. An `exit` hook never runs when a process is killed (SIGKILL, a default
 * SIGTERM or SIGINT, a test timeout, a cancelled CI job), so this sweep is what frees them.
 */
export function sweepProcessTempDirs(
  prefix: string,
  root = tmpdir(),
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): string[] {
  const owned = new RegExp(`^${escapeRegex(prefix)}(\\d+)-[A-Za-z0-9]{6}$`);
  const legacy = new RegExp(`^${escapeRegex(prefix)}[A-Za-z0-9]{6}$`);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const pid = owned.exec(name)?.[1];
    let stale = false;
    if (pid !== undefined) stale = !alive(Number(pid));
    else if (legacy.test(name)) {
      try {
        stale = now - statSync(join(root, name)).mtimeMs > LEGACY_TEMP_AGE_MS;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Another sweep or the owner removed it, or Windows still holds a file: the next sweep retries.
    }
  }
  return removed;
}

/**
 * Makes a temporary directory named `<prefix><pid>-XXXXXX` under the OS temp directory. The first
 * call for a prefix in a process sweeps the directories that killed processes left behind with
 * `sweepProcessTempDirs`, so a directory that outlives its process is freed by the next one (#2967).
 */
export function processTempDir(prefix: string): string {
  if (!swept.has(prefix)) {
    swept.add(prefix);
    sweepProcessTempDirs(prefix);
  }
  return mkdtempSync(join(tmpdir(), `${prefix}${process.pid}-`));
}
