import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { builtinForbidden } from "../security/forbidden.js";
import { isInside, realPath } from "./paths.js";
import type { ResolvedProject } from "./resolve.js";

const INSTRUCTION_MAX_BYTES = 32 * 1024;

export interface ProjectInstructionFile {
  /** Real absolute path. */
  path: string;
  content: string;
}

/**
 * The manifest's `defaults.instructions`, read from inside the trusted roots only. Files that are
 * missing, forbidden, too large or outside the roots are left out and named in `skipped`.
 */
export function projectInstructionFiles(project: ResolvedProject): {
  files: ProjectInstructionFile[];
  skipped: string[];
} {
  const files: ProjectInstructionFile[] = [];
  const skipped: string[] = [];
  for (const entry of project.manifest.defaults.instructions ?? []) {
    const path = realPath(resolve(project.root, entry));
    if (!project.roots.some((root) => isInside(root, path))) {
      skipped.push(`${entry} (outside the trusted project roots)`);
      continue;
    }
    if (builtinForbidden(path)) {
      skipped.push(`${entry} (forbidden)`);
      continue;
    }
    try {
      if (statSync(path).size > INSTRUCTION_MAX_BYTES) {
        skipped.push(`${entry} (over ${INSTRUCTION_MAX_BYTES / 1024} KB)`);
        continue;
      }
      const content = readFileSync(path, "utf8").trim();
      if (content) files.push({ path, content });
    } catch {
      skipped.push(`${entry} (not found)`);
    }
  }
  return { files, skipped };
}
