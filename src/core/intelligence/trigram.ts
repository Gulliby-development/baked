/**
 * Trigram substring index helpers — shared by the indexer (RepoMap.indexFile)
 * and the query path (bake_grep candidate narrowing).
 *
 * A trigram is 3 consecutive bytes packed into a u24 integer. The index maps
 * each trigram → the set of file_ids that contain it. To find files that *might*
 * contain a literal substring, we extract its trigrams and intersect their
 * posting lists. The result is a SUPERSET of true matches — ripgrep still does
 * the real match, so there is zero regex/case/multiline correctness loss.
 *
 * Trigrams are case-normalized to lowercase so a case-insensitive ripgrep pass
 * still hits the right candidates. The actual matcher decides case sensitivity.
 */

/** Max distinct files a single trigram may point at. Common trigrams (e.g. "the",
 *  "ion") appear nearly everywhere and make terrible filters — cap their posting
 *  lists so the index stays small and intersections stay cheap. */
export const MAX_POSTINGS_PER_TRIGRAM = 512;

/** Minimum literal run length needed to extract trigrams. */
export const MIN_TRIGRAM_LEN = 3;

/** Pack 3 lowercased bytes into a u24. */
function pack(a: number, b: number, c: number): number {
  return (a << 16) | (b << 8) | c;
}

/** Lowercase a byte (ASCII only — non-ASCII passes through unchanged). */
function lower(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

/**
 * Extract the set of distinct trigrams from arbitrary text (file content).
 * Skips trigrams that are entirely whitespace — they are noise and explode
 * posting lists. Returns packed u24 integers.
 */
export function extractContentTrigrams(content: string): Set<number> {
  const out = new Set<number>();
  const len = content.length;
  if (len < MIN_TRIGRAM_LEN) return out;
  for (let i = 0; i + 2 < len; i++) {
    const a = lower(content.charCodeAt(i));
    const b = lower(content.charCodeAt(i + 1));
    const c = lower(content.charCodeAt(i + 2));
    // Skip all-whitespace trigrams (space, tab, newline, CR).
    if (isWs(a) && isWs(b) && isWs(c)) continue;
    // Skip trigrams containing chars outside the byte range we pack (astral / >255).
    if (a > 255 || b > 255 || c > 255) continue;
    out.add(pack(a, b, c));
  }
  return out;
}

function isWs(byte: number): boolean {
  return byte === 32 || byte === 9 || byte === 10 || byte === 13;
}

/**
 * Extract trigrams from a search pattern's longest literal run.
 * Returns null when the pattern is unsuitable for trigram filtering:
 *  - shorter than MIN_TRIGRAM_LEN after stripping regex metacharacters, or
 *  - the literal portion is too short to be selective.
 *
 * We take the LONGEST contiguous literal substring (no regex metachars) and
 * derive trigrams from it. If the whole pattern is literal, that's the pattern.
 */
export function extractPatternTrigrams(pattern: string): number[] | null {
  const literal = longestLiteralRun(pattern);
  if (literal.length < MIN_TRIGRAM_LEN) return null;
  const set = extractContentTrigrams(literal);
  if (set.size === 0) return null;
  return [...set];
}

/** Regex metacharacters that break a literal run. */
const META = new Set([".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "^", "$", "\\"]);

/** Longest contiguous run of non-metacharacter, non-whitespace chars. */
function longestLiteralRun(pattern: string): string {
  let best = "";
  let cur = "";
  for (const ch of pattern) {
    if (META.has(ch) || ch === " " || ch === "\t" || ch === "\n") {
      if (cur.length > best.length) best = cur;
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}
