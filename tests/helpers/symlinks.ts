import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function canCreateFileSymlinks(): boolean {
  if (process.platform !== "win32") return true;
  const root = mkdtempSync(join(tmpdir(), "baked-symlink-capability-"));
  try {
    const target = join(root, "target");
    writeFileSync(target, "probe");
    symlinkSync(target, join(root, "link"), "file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.env.BAKED_REQUIRE_SYMLINKS === "1") throw error;
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege for file links.
// Directory junction tests remain enabled without this privilege.
export const fileSymlinksAvailable = canCreateFileSymlinks();
