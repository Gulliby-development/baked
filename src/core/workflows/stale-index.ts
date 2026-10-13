import { intentRoot } from "./effects.js";
import type { EffectRow } from "./store.js";

/** Tools that answer from the project's index and language servers, not from the run's files. */
export const indexTools = new Set(["navigate", "bake_find", "bake_impact"]);

/** Files the run has written in its worktree `rootPath` (relative paths, `/` separators). */
export function writtenInRoot(effects: EffectRow[], rootPath: string): string[] {
  const out = new Set<string>();
  for (const effect of effects) {
    if (effect.kind !== "file_patch" || effect.status !== "applied") continue;
    if (intentRoot(effect.intent_json) !== rootPath) continue;
    const path = (JSON.parse(effect.intent_json) as { path?: string }).path;
    if (path) out.add(path.split("\\").join("/"));
  }
  return [...out];
}

/**
 * A worktree run's index answers come from the project's working copy, so for a file the run
 * changed they can name a moved symbol or a shifted line. Such an answer gets a note to read
 * the file before relying on its lines.
 */
export function markStaleIndexResult<T>(result: T, written: string[]): T {
  if (!result || typeof result !== "object" || written.length === 0) return result;
  const output = (result as { output?: unknown }).output;
  if (typeof output !== "string") return result;
  const text = output.split("\\").join("/");
  const cited = written.filter((path) => text.includes(path));
  if (cited.length === 0) return result;
  const note = `Changed in this run after the index was built, so lines and symbols above may be out of date: ${cited.join(", ")}. Read these files before relying on them.`;
  return { ...result, output: `${output}\n\n${note}` };
}
