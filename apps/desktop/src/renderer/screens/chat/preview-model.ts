/**
 * The documents a chat session produced that the preview panel shows. Which tool calls produce a
 * document lives in `src/core/files/preview-targets.ts`, shared with the terminal UI and
 * `baked preview list`; this adds what only the panel needs. Pure, so the tests drive it without
 * a DOM.
 */
import {
  type PreviewTarget,
  type PreviewToolCall,
  previewKey,
  previewOf,
} from "../../../../../../src/core/files/preview-targets.js";

export {
  normalizePath,
  type PreviewSource,
  type PreviewTarget,
  previewOf,
  previewTargets,
} from "../../../../../../src/core/files/preview-targets.js";

/** The key of the document the tool call `id` produced, if it produced one. */
export function targetForCall(
  targets: readonly PreviewTarget[],
  call: PreviewToolCall,
): string | null {
  const found = previewOf(call);
  if (!found) return null;
  const key = previewKey(found.source);
  return targets.some((t) => t.key === key) ? key : null;
}

/**
 * The document to bring forward after the transcript changed: of those changed since `before`,
 * the one changed last. Null when nothing changed.
 */
export function freshTarget(
  before: readonly PreviewTarget[],
  after: readonly PreviewTarget[],
): PreviewTarget | null {
  const old = new Map(before.map((t) => [t.key, t.changes]));
  let fresh: PreviewTarget | null = null;
  for (const target of after)
    if ((old.get(target.key) ?? 0) < target.changes && (!fresh || target.lastSeq > fresh.lastSeq))
      fresh = target;
  return fresh;
}
