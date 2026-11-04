import { FEATURE_REQUEST_HEADING, requestSections } from "./person-request.js";

/**
 * Which prescribed rows of a shared row file each feature of an initiative delivers (#2898).
 *
 * A split can give one test file to several features, a row range each ("Own CliRows rows 1-10",
 * or the feature's typed `rows`). The feature prompt (`featurePrompt`) states the rows of each such
 * file the feature's run delivers under `FEATURE_ROWS_HEADING`, and `suppliedRows`, the one reader
 * of row blocks, keeps only those rows of the block in that run. So the host write, the row-file
 * tasks and their price, the row restore, the drift check, `place_rows` and the case walk all read
 * the feature's rows, never the whole block. Bench round 96 varprompt: the host wrote all 13 and
 * 22 rows of `CliRows.cs` and `OptionsRows.cs` into the first feature, which owned 10 and 19; its
 * required test check failed on the rows of three later features and the run waited for a person.
 */

/** The framing line of a feature prompt above the rows a feature's run delivers, one file a line. */
export const FEATURE_ROWS_HEADING =
  "Prescribed rows this feature's run delivers: each file holds only these rows of its block (in the block's order), and the other rows belong to other features of the initiative:";

/** One file's line under the heading: `- path: rows 1-10, 12 of 13 (...)`, or `no rows of 13`. */
const ROW_LINE = /^- (\S.*?): (?:rows ([\d,\s-]+?)|no rows) of (\d+)\b/;

/** Row numbers (from 1) in the shortest list of runs: `1-10, 12, 14-15`. */
export function formatRowList(rows: Iterable<number>): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/**
 * The row numbers a list names (`1-17, 20 and 22`, `18 to 19`, `5–7`), from 1 to `total`; a
 * number past `total` is no row of the block and is dropped.
 */
export function parseRowList(text: string, total: number): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?/g)) {
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (let n = Math.min(from, to); n <= Math.max(from, to) && n <= total; n++)
      if (n >= 1) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** What a feature's run holds of one shared row file: its own rows and those upstream delivered. */
export interface FeatureRowFile {
  path: string;
  /** The rows of the file's block (`suppliedRows(...).rows` of the whole request). */
  total: number;
  /** Every row the file holds once this feature is done, its own and its upstream's, from 1. */
  rows: number[];
  /** The rows of `rows` that upstream features delivered. */
  upstream: number[];
}

/** The framing lines `featurePrompt` writes for a feature's shared row files; none when it has none. */
export function featureRowsLines(files: readonly FeatureRowFile[]): string[] {
  if (!files.length) return [];
  return [
    FEATURE_ROWS_HEADING,
    ...files.map((file) => {
      const own = file.rows.filter((row) => !file.upstream.includes(row));
      const head = file.rows.length
        ? `- ${file.path}: rows ${formatRowList(file.rows)} of ${file.total}`
        : `- ${file.path}: no rows of ${file.total}`;
      const notes = [
        ...(file.upstream.length
          ? [`rows ${formatRowList(file.upstream)} are upstream features' and stay as delivered`]
          : []),
        own.length ? `this feature adds rows ${formatRowList(own)}` : "this feature adds none",
      ];
      return `${head} (${notes.join("; ")})`;
    }),
  ];
}

/**
 * The rows (from 1) of each shared row file a feature's request says its run delivers, read from
 * the host's framing only (`requestSections`); null outside a feature prompt or when it states none.
 */
export function framedFeatureRows(request: string): Map<string, Set<number>> | null {
  if (!request.includes(FEATURE_ROWS_HEADING) || !request.includes(FEATURE_REQUEST_HEADING))
    return null;
  const lines = requestSections(request, true).framing.split("\n");
  const at = lines.indexOf(FEATURE_ROWS_HEADING);
  if (at < 0) return null;
  const out = new Map<string, Set<number>>();
  for (const line of lines.slice(at + 1)) {
    const m = ROW_LINE.exec(line);
    if (!m) break;
    const total = Number(m[3]);
    out.set((m[1] ?? "").trim(), new Set(m[2] ? parseRowList(m[2], total) : []));
  }
  return out.size ? out : null;
}

/**
 * The rows of a row file a feature's scope gives it in words (#2898): its block's name or file
 * stem followed by `rows 1-10`, `row 12`, `rows 1-17, 20 and 22`, or `all 28 rows`, `all 24` or `all rows` (every row).
 * Null when the scope names no rows of the file.
 */
export function scopeRowRanges(
  scope: string,
  names: readonly string[],
  total: number,
): number[] | null {
  const text = scope.replace(/`/g, "");
  const list = String.raw`\d+(?:\s*(?:-|–|—|to)\s*\d+)?(?:\s*(?:,\s*and|,|and)\s*\d+(?:\s*(?:-|–|—|to)\s*\d+)?)*`;
  const found = new Set<number>();
  let named = false;
  for (const name of new Set(names.filter(Boolean))) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      String.raw`(?<![\w.])${escaped}(?![\w])(?:\s*\([^)]*\))?\s*[:,]?\s*(?:(all\s+\d+(?:\s+rows?)?(?![\w-])|all\s+rows?)|rows?\s+(${list}))`,
      "gi",
    );
    for (const m of text.matchAll(re)) {
      named = true;
      const rows = m[1]
        ? Array.from({ length: total }, (_, i) => i + 1)
        : parseRowList(m[2] ?? "", total);
      for (const row of rows) found.add(row);
    }
  }
  return named ? [...found].sort((a, b) => a - b) : null;
}
