/**
 * The lines an `oldString` given with `lineStart` covers, for `edit_file` and `multi_edit`
 * (#2981). An `oldString` that ends in a newline covers its lines and the line break after the
 * last one: counting the empty piece after that newline as a line made the range one line too
 * long, its text never equalled `oldString`, and R106 tokenpare filters T005 repeated the same
 * failing edit 27 times (492k tokens).
 */
export interface OldStringRange {
  /** The first line, from 0. */
  start: number;
  /** One past the last line, from 0. */
  end: number;
  /** The range takes the line break after its last line (`oldString` ends in a newline). */
  trailing: boolean;
}

/** The range `oldStr` covers from 1-based `lineStart` in `lines`, or null when it does not fit. */
export function oldStringRange(
  lines: readonly string[],
  oldStr: string,
  lineStart: number,
): OldStringRange | null {
  const trailing = oldStr.endsWith("\n");
  const start = lineStart - 1;
  const end = start + oldStr.split("\n").length - (trailing ? 1 : 0);
  if (start < 0 || start >= lines.length || start >= end) return null;
  // A trailing range needs the line break after its last line, so a line after it.
  if (trailing ? end >= lines.length : end > lines.length) return null;
  return { start, end, trailing };
}

/** The text of `range` in `lines`, with its line break when it takes one. */
export function rangeText(lines: readonly string[], range: OldStringRange): string {
  return lines.slice(range.start, range.end).join("\n") + (range.trailing ? "\n" : "");
}

/** The file `lines` with `range` replaced by `replacement`. */
export function replaceRange(
  lines: readonly string[],
  range: OldStringRange,
  replacement: string,
): string {
  const prefix = range.start ? `${lines.slice(0, range.start).join("\n")}\n` : "";
  const rest = lines.slice(range.end);
  const suffix = range.trailing ? rest.join("\n") : rest.length ? `\n${rest.join("\n")}` : "";
  return prefix + replacement + suffix;
}
