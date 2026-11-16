import { formatRowList } from "../feature-rows.js";
import { measureFileRows, rowNotation } from "../row-block-drift.js";
import { rowBlockFiles, suppliedRows } from "../sizing.js";

/** A prescribed row file whose rows no accepted feature's copy of the file holds (#3071). */
export interface UndeliveredRows {
  path: string;
  /** The rows of the request's block. */
  total: number;
  /** The rows (from 1) no copy holds. */
  missing: number[];
  /** How many copies of the file were read: accepted feature commits and the working copy. */
  copies: number;
}

/**
 * The prescribed rows of each row file the request names (`rowBlockFiles`, `suppliedRows`) that no
 * accepted copy of the file holds (#3071). `copies(path)` gives the file's text in each accepted
 * feature commit and the working copy; a row counts as delivered when one copy holds it
 * (`measureFileRows`, the drift's matcher; a changed row does not count). A file no copy holds is
 * reported whole. A path whose copies cannot be read (`null`) and a block whose rows are all in
 * the request's own notation (`rowNotation`, which the run translates) are skipped. R111 skillgate:
 * a narrowed split (#3067) left 26 of 215 rows unwritten, and every check, review and the
 * initiative passed, because each run's drift reads only its own rows.
 */
export function undeliveredRows(
  request: string,
  copies: (path: string) => readonly string[] | null,
): UndeliveredRows[] {
  const out: UndeliveredRows[] = [];
  for (const [path, block] of suppliedRows(request, rowBlockFiles(request))) {
    const rows = block.lines;
    if (!rows.length || rows.every(rowNotation)) continue;
    const texts = copies(path);
    if (texts === null) continue;
    const held = new Set<number>();
    for (const text of texts)
      for (const fileRow of measureFileRows(rows, text))
        for (const n of fileRow.matches) held.add(n);
    const missing = rows.map((_, i) => i + 1).filter((n) => !held.has(n));
    if (missing.length) out.push({ path, total: rows.length, missing, copies: texts.length });
  }
  return out;
}

/** The would-stop sentence for an undelivered row file. */
export function undeliveredSummary(found: UndeliveredRows): string {
  const rows = `row${found.missing.length === 1 ? "" : "s"} ${formatRowList(found.missing)} of ${found.total}`;
  return found.copies
    ? `${found.path}: ${rows} ${found.missing.length === 1 ? "is" : "are"} in no accepted feature's copy of the file: the request prescribes them, and no feature delivered them.`
    : `${found.path}: no accepted feature wrote the file, so none of its ${found.total} prescribed rows is delivered.`;
}
