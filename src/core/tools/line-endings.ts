import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export type LineEnding = "lf" | "crlf";

export interface LineEndingCounts {
  crlf: number;
  lf: number;
}

/** Count CRLF and bare LF line terminators. A lone CR is not a line terminator here. */
export function countLineEndings(text: string): LineEndingCounts {
  let crlf = 0;
  let lf = 0;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    if (idx > 0 && text.charCodeAt(idx - 1) === 13) crlf++;
    else lf++;
    idx = text.indexOf("\n", idx + 1);
  }
  return { crlf, lf };
}

/** The ending most lines use. Ties and files without line breaks count as LF. */
export function dominantLineEnding(text: string): LineEnding {
  const { crlf, lf } = countLineEndings(text);
  return crlf > lf ? "crlf" : "lf";
}

/** Short label for read headers, or null for plain LF files (the default, not worth a line). */
export function describeLineEndings(text: string): string | null {
  const { crlf, lf } = countLineEndings(text);
  if (crlf === 0) return null;
  if (lf === 0) return "CRLF";
  return crlf > lf
    ? `CRLF (mixed: ${String(crlf)} CRLF, ${String(lf)} LF lines; edits normalize to CRLF)`
    : `LF (mixed: ${String(lf)} LF, ${String(crlf)} CRLF lines; edits normalize to LF)`;
}

/** Convert every CRLF to LF. */
export function toLf(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

/** Re-encode text with the given ending, whatever endings it had before. */
export function withLineEnding(text: string, eol: LineEnding): string {
  const lf = toLf(text);
  return eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}

/** Number of lines whose ending differs from the target; 0 when the file is already uniform. */
export function minorityLineCount(text: string): number {
  const { crlf, lf } = countLineEndings(text);
  return Math.min(crlf, lf);
}

const SIBLING_SAMPLE = 6;
const SIBLING_MAX_BYTES = 256 * 1024;

function editorconfigEnding(dir: string): LineEnding | null {
  let current = dir;
  for (let depth = 0; depth < 12; depth++) {
    try {
      const text = readFileSync(join(current, ".editorconfig"), "utf-8");
      const m = text.match(/^\s*end_of_line\s*=\s*(lf|crlf)\s*$/im);
      if (m) return (m[1] as string).toLowerCase() as LineEnding;
      if (/^\s*root\s*=\s*true\s*$/im.test(text)) return null;
    } catch {
      // no .editorconfig at this level
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return null;
}

/**
 * Ending for a file that does not exist yet: `.editorconfig` `end_of_line`, else the
 * dominant ending of a few sibling text files, else null (caller keeps the text as given).
 */
export function detectNewFileLineEnding(dir: string): LineEnding | null {
  const configured = editorconfigEnding(dir);
  if (configured) return configured;
  let crlfFiles = 0;
  let lfFiles = 0;
  try {
    let sampled = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (sampled >= SIBLING_SAMPLE) break;
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (statSync(full).size > SIBLING_MAX_BYTES) continue;
      const text = readFileSync(full, "utf-8");
      if (text.includes("\0")) continue;
      const { crlf, lf } = countLineEndings(text);
      if (crlf + lf === 0) continue;
      sampled++;
      if (crlf > lf) crlfFiles++;
      else lfFiles++;
    }
  } catch {
    return null;
  }
  if (crlfFiles === 0 && lfFiles === 0) return null;
  return crlfFiles > lfFiles ? "crlf" : "lf";
}
