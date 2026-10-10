import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { builtinForbidden } from "../security/forbidden.js";
import { hashBytes } from "../specs/hash.js";
import { displayPath, isInside, realPath } from "./paths.js";
import type { ResolvedProject } from "./resolve.js";

const INSTRUCTION_MAX_BYTES = 32 * 1024;

export interface ProjectInstructions {
  /** Prompt text, empty when the project has none. */
  text: string;
  /** Real path to content hash of every file the text holds. */
  files: Record<string, string>;
  /** Files named by the manifest that were not used, with the reason. */
  skipped: string[];
}

/** The manifest's `defaults.instructions`, read from inside the trusted roots only. */
export function projectInstructions(project: ResolvedProject): ProjectInstructions {
  const parts: string[] = [];
  const files: Record<string, string> = {};
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
      const content = readFileSync(path);
      files[path] = hashBytes(content);
      parts.push(`[project:${displayPath(project.root, path)}]\n${content.toString("utf8")}`);
    } catch {
      skipped.push(`${entry} (unreadable)`);
    }
  }
  return {
    text: parts.length
      ? `Instructions of project ${project.name} (baked/project.json):\n${parts.join("\n\n")}`
      : "",
    files,
    skipped,
  };
}
