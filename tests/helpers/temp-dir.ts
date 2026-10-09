import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows refuses to delete a directory while any process still holds a handle inside it.
const HANDLE_HELD = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Removes a test directory once its handles are released. A fixture process can report exit
 * while its worker's SQLite files and descendant processes are still being torn down, so
 * Windows reports EBUSY for a short time after the exit.
 */
export async function removeTempDir(path: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !HANDLE_HELD.has(code) || Date.now() + delay > deadline) throw error;
      await Bun.sleep(delay);
    }
  }
}

/** Runs an action in a fresh temporary directory. A failure of the action takes precedence over a failed cleanup. */
export async function withTempDir<T>(prefix: string, action: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  let result: T;
  try {
    result = await action(root);
  } catch (error) {
    await removeTempDir(root).catch(() => {});
    throw error;
  }
  await removeTempDir(root);
  return result;
}
