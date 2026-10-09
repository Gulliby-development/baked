/**
 * .gitignore / .bakedignore matcher for the repo-map walker.
 *
 * Wraps the `ignore` npm package — the gitignore-spec reference implementation
 * (used by ESLint, Prettier, lint-staged). Pure-JS, zero-dep, cross-platform,
 * and correct on the full spec: negations (`!keep`), `**` double-star, root
 * anchoring (`/dist`), directory-only (`build/`), and segment globs. This is far
 * more robust than a hand-rolled regex matcher and behaves identically to git
 * across every language's project layout.
 *
 * Goal: prune build/generated/vendored trees custom to a given repo (on top of
 * the hardcoded IGNORED_DIRS) so the Baked Map indexes only real source.
 */

import ignoreFactory from "ignore";

/**
 * Extract the active (non-comment, non-blank) pattern lines from raw ignore text.
 * Negations are preserved — the underlying engine honors them correctly.
 */
export function parseIgnore(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s === "" || s.startsWith("#")) continue;
    out.push(s);
  }
  return out;
}

/** A compiled ignore matcher backed by the `ignore` package. */
export class IgnoreMatcher {
  private ig = ignoreFactory();
  readonly size: number;

  constructor(patterns: string[]) {
    if (patterns.length > 0) this.ig.add(patterns);
    this.size = patterns.length;
  }

  /**
   * True when a repo-relative POSIX path should be ignored.
   *
   * The `ignore` package keys directory-only rules (`build/`) off a trailing
   * slash on the tested path, so we append one for directories.
   * @param relPath repo-relative path, e.g. "src/foo.ts" or "build" (no leading slash)
   * @param isDir   whether the path is a directory
   */
  ignores(relPath: string, isDir: boolean): boolean {
    if (this.size === 0) return false;
    let p = relPath.replace(/\\/g, "/");
    if (p.startsWith("/")) p = p.slice(1);
    if (p === "" || p === ".") return false;
    return this.ig.ignores(isDir ? `${p}/` : p);
  }
}

/** Build a matcher from raw ignore-file contents (concatenated). */
export function buildIgnoreMatcher(...texts: Array<string | null | undefined>): IgnoreMatcher {
  const patterns: string[] = [];
  for (const t of texts) {
    if (t) patterns.push(...parseIgnore(t));
  }
  return new IgnoreMatcher(patterns);
}
