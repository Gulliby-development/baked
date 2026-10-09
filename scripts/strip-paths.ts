/**
 * Replace absolute filesystem path prefixes (the build machine's cwd and home
 * directory) in bundled source text.
 *
 * A plain substring replacement is unsafe: with HOME=/root, the relative
 * import `'./root.js'` contains `/root` and was rewritten to `'.~.js'`,
 * which broke module resolution. A prefix only counts as an absolute path
 * when it is not preceded by a path or identifier character and is followed
 * by a path separator or a non-path character (quote, whitespace, end).
 */

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Path prefixes shorter than this (e.g. "/" or "C:") are never scrubbed. */
const MIN_PREFIX_LENGTH = 2;

function prefixPattern(prefix: string): RegExp {
  // Lookbehind: not part of a longer path or identifier (rules out `./root`).
  // Lookahead: the prefix ends at a path boundary (rules out `/rootfs`).
  return new RegExp(`(?<![\\w.$/\\\\-])${escapeRegExp(prefix)}(?![\\w.$-])`, "g");
}

export interface PathReplacement {
  prefix: string;
  replacement: string;
}

/** Normalise a prefix: drop trailing separators, reject trivial values. */
function normalisePrefix(prefix: string): string | null {
  const trimmed = prefix.replace(/[/\\]+$/, "");
  return trimmed.length >= MIN_PREFIX_LENGTH ? trimmed : null;
}

export function stripAbsolutePaths(source: string, replacements: PathReplacement[]): string {
  let out = source;
  // Longest prefix first so cwd (usually inside home) is replaced before home.
  const ordered = replacements
    .map(({ prefix, replacement }) => ({ prefix: normalisePrefix(prefix), replacement }))
    .filter((r): r is PathReplacement => r.prefix !== null)
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, replacement } of ordered) {
    if (!out.includes(prefix)) continue;
    out = out.replace(prefixPattern(prefix), () => replacement);
  }
  return out;
}

/** The build machine's cwd (removed) and home directory (replaced by `~`). */
export function buildMachinePaths(): PathReplacement[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    { prefix: process.cwd(), replacement: "" },
    { prefix: home, replacement: "~" },
  ];
}
