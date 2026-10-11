import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import { WorkflowStore } from "../workflows/store.js";
import { MANIFEST_PATH } from "./manifest.js";
import { realPath } from "./paths.js";
import { resolveProject } from "./resolve.js";
import { ProjectService } from "./service.js";

export interface ScaffoldResult {
  root: string;
  /** Workspace-relative paths this call created; empty when the folder was already set up. */
  created: string[];
  /** Why nothing was written, when the folder is not one BAKED sets up on its own. */
  skipped?: string;
}

/**
 * Sets up a folder BAKED opens as a project: `baked/project.json` registered for this user (unless
 * a registered project already covers the folder), the gitignored `.baked/` directory and the
 * workflow store. Existing files are never changed, and the home folder and a drive root are left
 * alone. Settings stay at the built-in defaults until someone changes them, so later releases'
 * defaults keep applying.
 */
export function scaffoldProject(
  folder: string,
  opts: { configDir?: string; id?: string; name?: string; roots?: string[] } = {},
): ScaffoldResult {
  const root = realPath(folder);
  if (!existsSync(root) || !statSync(root).isDirectory())
    return { root, created: [], skipped: "not a folder" };
  if (dirname(root) === root) return { root, created: [], skipped: "a drive root" };
  if (root === realPath(homedir())) return { root, created: [], skipped: "the home folder" };

  const created: string[] = [];
  const configDir = opts.configDir ? { configDir: opts.configDir } : {};
  // A folder inside a registered project already belongs to it and gets no manifest of its own.
  if (!resolveProject(root, configDir)) {
    new ProjectService(root, configDir).init({
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.roots ? { roots: opts.roots } : {}),
    });
    created.push(MANIFEST_PATH.replaceAll("\\", "/"));
  }
  if (!existsSync(join(root, ".baked"))) created.push(".baked/");
  ensurebakedDir(root);
  if (!existsSync(join(root, ".baked", "workflows.sqlite"))) {
    new WorkflowStore(root).close();
    created.push(".baked/workflows.sqlite");
  }
  return { root, created };
}

/** scaffoldProject for start-up paths: a folder that cannot be set up never blocks opening it. */
export function scaffoldProjectQuietly(
  folder: string,
  opts: { configDir?: string } = {},
): ScaffoldResult | null {
  try {
    return scaffoldProject(folder, opts);
  } catch {
    return null;
  }
}
