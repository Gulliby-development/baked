import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestContent, isTestFile } from "./language-traits.js";

// Kept apart from language-traits.ts, which the desktop renderer reaches through
// code-graph-model.ts and so must import no node builtin (#2683).

/** `isTestContent` of the file as it is under `root`, by the name alone when it does not exist. */
export function isTestFileAt(root: string, path: string): boolean {
  if (!isTestFile(path)) return false;
  let content: string | null = null;
  try {
    content = readFileSync(join(root, path), "utf8");
  } catch {
    /* absent or unreadable: the name rule */
  }
  return isTestContent(path, content);
}
