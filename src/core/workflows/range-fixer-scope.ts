import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileHash } from "./effects.js";
import type { PutBack } from "./fixer-scope.js";
import type { LineRange } from "./format-written.js";

/**
 * A range fixer's change kept to its range (#2970). The format-written checks run the project's
 * formatter on the lines a run changed in a file it edits (#1582), and a range formatter grows the
 * range to whole statements, sometimes to the statement next to it: R104 logslice-update added an
 * `add_argument(` call and `ruff format --range` also rewrote the existing `--summary` call below
 * it, in a file that is not `ruff format` clean. The review reported the reformat twice and both
 * corrections had empty patches, since the fixer put it back before every check (401k tokens).
 *
 * The fixer's change is read as hunks of a line diff against the file before it ran. A hunk with
 * no line in a range (and, for an insertion, not at a range's edge) is put back whole. A hunk that
 * runs past a range keeps the formatter's lines for the range's statements and puts back the rest
 * where the two can be told apart: the formatter's first lines hold the same code (whitespace,
 * quote style and commas aside) as the hunk's lines up to the range's end, so what follows is the
 * neighbouring statement. A hunk that cannot be split so is kept as the formatter wrote it.
 */

/** A changed span: lines [from, to) of the file before, replaced by lines [at, until) after. */
interface Hunk {
  from: number;
  to: number;
  at: number;
  until: number;
}

/** Line diffs larger than this many cells are not split: the fixer's result stands. */
const MAX_CELLS = 4_000_000;

/** The hunks of `after` against `before`, by the longest common subsequence of their lines. */
function hunks(before: readonly string[], after: readonly string[]): Hunk[] | null {
  if (before.length * after.length > MAX_CELLS) return null;
  const width = after.length + 1;
  const lcs = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        before[i] === after[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
  const out: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { from: i, to: i, at: j, until: j };
      out.push(open);
    }
    if (
      j >= after.length ||
      (i < before.length && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    )
      open.to = ++i;
    else open.until = ++j;
  }
  return out;
}

/** The code of some lines with whitespace, quote style and commas left out. */
const code = (lines: readonly string[]) => lines.join("").replace(/[\s,]/g, "").replace(/'/g, '"');

/**
 * `after` with the fixer's changes outside `ranges` (1-based lines of `before`) put back, and how
 * many lines of `before` it put back; `after` itself when there is nothing to put back.
 */
export function keepFixerRange(
  before: string,
  after: string,
  ranges: readonly LineRange[],
): { text: string; putBack: number } {
  if (before === after || !ranges.length) return { text: after, putBack: 0 };
  const a = before.split("\n");
  const b = after.split("\n");
  const found = hunks(a, b);
  if (!found) return { text: after, putBack: 0 };
  // A 1-based line of `before` is held by a range; an insertion at 0-based `i` sits between
  // lines i and i+1, held when either is.
  const held = (line: number) => ranges.some(([start, end]) => line >= start && line <= end);
  const out: string[] = [];
  let putBack = 0;
  let i = 0;
  for (const hunk of found) {
    out.push(...a.slice(i, hunk.from));
    i = hunk.to;
    const lines = Array.from({ length: hunk.to - hunk.from }, (_, k) => hunk.from + k + 1);
    const touches = lines.length ? lines.some(held) : held(hunk.from) || held(hunk.from + 1);
    if (!touches) {
      out.push(...a.slice(hunk.from, hunk.to));
      putBack += hunk.to - hunk.from || 1;
      continue;
    }
    let mine = b.slice(hunk.at, hunk.until);
    let head: string[] = [];
    let tail: string[] = [];
    // Lines of the hunk past the last held line, and before the first: a neighbour's, when the
    // formatter's lines split at the same code.
    const last = lines.findLastIndex(held);
    const first = lines.findIndex(held);
    if (last >= 0 && last < lines.length - 1) {
      const kept = code(a.slice(hunk.from, hunk.from + last + 1));
      const split = mine.findIndex((_, k) => code(mine.slice(0, k + 1)) === kept);
      if (split >= 0 && split < mine.length - 1) {
        tail = a.slice(hunk.from + last + 1, hunk.to);
        mine = mine.slice(0, split + 1);
      }
    }
    if (first > 0) {
      const kept = code(a.slice(hunk.from, hunk.from + first));
      const split = mine.findIndex((_, k) => code(mine.slice(0, k + 1)) === kept);
      if (split >= 0 && split < mine.length - 1) {
        head = a.slice(hunk.from, hunk.from + first);
        mine = mine.slice(split + 1);
      }
    }
    putBack += head.length + tail.length;
    out.push(...head, ...mine, ...tail);
  }
  out.push(...a.slice(i));
  return putBack ? { text: out.join("\n"), putBack } : { text: after, putBack: 0 };
}

/**
 * After a range fixer ran on `target`, puts back its changes outside `ranges` (`keepFixerRange`)
 * and keeps the put-back only when the check still passes on the result (`passes`), so a formatter
 * whose check grows the range as its fixer did never fails for lines the host put back. Returns
 * the put-back for `recordPutBack`, or null when nothing was put back.
 */
export async function putBackOutsideRange(
  target: string,
  path: string,
  before: string | null,
  ranges: readonly LineRange[] | undefined,
  passes: () => Promise<boolean>,
): Promise<PutBack | null> {
  if (before === null || !ranges?.length || !existsSync(target)) return null;
  const after = readFileSync(target, "utf8");
  const { text, putBack } = keepFixerRange(before, after, ranges);
  if (!putBack) return null;
  const from = fileHash(target);
  writeFileSync(target, text);
  if (await passes().catch(() => false)) return { path, action: "restored", from };
  writeFileSync(target, after);
  return null;
}
