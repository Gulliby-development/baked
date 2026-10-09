import { join } from "node:path";
import { IS_WIN, tmpDir } from "./index.js";

export function makeIpcSocketPath(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_");
  if (IS_WIN) {
    return `\\\\.\\pipe\\${safe}`;
  }
  return join(tmpDir(), `${safe}.sock`);
}

/**
 * On POSIX, the UDS file must be unlinked when the listener shuts down.
 * On Windows, named pipes are kernel objects with no filesystem residue —
 * cleanup is a no-op.
 */
export function shouldCleanupSocketFile(): boolean {
  return !IS_WIN;
}
