import type { RuntimeState } from "./types.js";
import { HOST_SPEC_OUTCOME } from "./v2/runtime.js";

/** The longest subject line a run's commit and pull request title carry. */
export const SUBJECT_MAX_CHARS = 72;

/**
 * The first line of `text` cut at a word boundary to at most `max` characters, with no ellipsis.
 * A single word longer than `max` is the only case cut inside a word.
 */
export function wordCut(text: string, max = SUBJECT_MAX_CHARS): string {
  const line = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const head = line.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : line.slice(0, max);
  return cut.replace(/[\s,;:([{-]+$/, "");
}

/**
 * The subject of a run's commit and pull request: the spec author's title, or, for a host-made
 * spec (a run without a spec stage, whose title is only the request's first characters), the
 * first planned task's title (#2001). Cut at a word boundary to the subject length.
 */
export function runSubject(state: Pick<RuntimeState, "spec" | "graph">, fallback: string): string {
  const spec = state.spec;
  const planned = state.graph?.tasks[0]?.title;
  const title =
    spec && (spec.outcome !== HOST_SPEC_OUTCOME || !planned?.trim())
      ? spec.title
      : (planned ?? fallback);
  return wordCut(title) || wordCut(fallback);
}
