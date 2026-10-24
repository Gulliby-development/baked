/**
 * The one splitter for the rows of a Markdown table in a spec (#2044). A `|` separates two cells
 * only outside a backtick code span, outside a double-quoted string and when it is not escaped
 * as `\|`. R66 nodepluck AC-007 held the JSONPath query `"$[?@[0,0]==2 || @.b[?-1<0]]"` in a
 * code span; `.split("|")` cut it at `||`, and the task-end walk demanded the half query (with
 * its opening backtick) three times. Every table reader in src/core takes its cells from here; a
 * test greps for another `.split("|")`.
 */

/** The cells of a row split only at its separator pipes, with `\|` read as a literal `|`. */
function separatedCells(line: string): string[] {
  const text = line.trim();
  // Backticks pair as `quotedSpans` pairs them: an odd count on the line pairs none.
  const backticks = (text.match(/`/g) ?? []).length;
  const codeSpans = backticks % 2 === 0;
  const cells: string[] = [];
  let cell = "";
  let quote = "";
  let code = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? "";
    if (char === "\\" && text[at + 1] === "|") {
      cell += "|";
      at++;
      continue;
    }
    if (code) {
      cell += char;
      if (char === "`") code = false;
      continue;
    }
    if (quote) {
      cell += char;
      if (char === "\\" && quote === '"' && at + 1 < text.length) {
        cell += text[++at] ?? "";
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "`" && codeSpans) code = true;
    // A quote opens a string only when it closes later on the line: `5"` stays a character.
    else if (char === '"' && closes(text, at + 1, '"')) quote = '"';
    else if (char === "“" && text.indexOf("”", at + 1) >= 0) quote = "”";
    else if (char === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  // A row's outer pipes frame it; they are not empty cells.
  if (cells.length > 1 && text.startsWith("|")) cells.shift();
  if (cells.length > 1 && text.endsWith("|") && !text.endsWith("\\|") && cells.at(-1) === "")
    cells.pop();
  return cells.map((part) => part.trim());
}

/** Whether a double-quoted string opened before `from` closes on the line. */
function closes(text: string, from: number, quote: string): boolean {
  for (let at = from; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (text[at] === quote) return true;
  }
  return false;
}

/**
 * The trimmed cells of a table row. With the table's `width` (its header's cell count), a split of
 * that width wins: the guarded split first, then the plain one, for a row whose quote pairs
 * across two cells. A row that neither splits to the width keeps its guarded cells, so the
 * reader sees the mismatch and skips the row (it is never demanded).
 */
export function tableCells(line: string, width?: number): string[] {
  const cells = separatedCells(line);
  if (width === undefined || cells.length === width) return cells;
  const plain = line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
  return plain.length === width ? plain : cells;
}

/** A separator row's cell: `---`, `:--`, `--:`. */
export const SEPARATOR_CELL = /^:?-{2,}:?$/;
