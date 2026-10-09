import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** The raw write used by writeViaTemp; tests replace it to simulate a full disk. */
export const fileWriter = { writeFileSync };

/**
 * Writes through a uniquely named temp file and renames it into place. A failed write, such as
 * ENOSPC part-way through, removes the partial temp file instead of leaving it next to sources.
 */
export function writeViaTemp(
  path: string,
  content: string | Uint8Array,
  options: { flag: string; flush: boolean; mode?: number },
): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    fileWriter.writeFileSync(temp, content, options);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
