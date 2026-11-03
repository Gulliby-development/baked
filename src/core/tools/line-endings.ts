import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";

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

const GIT_TIMEOUT_MS = 5_000;

function git(dir: string, args: string[]): string | null {
  try {
    const proc = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return proc.status === 0 ? proc.stdout : null;
  } catch {
    return null;
  }
}

/** The `eol` attribute `.gitattributes` gives `name` in `dir` (`* text=auto eol=lf`), or null. */
function attributeEnding(dir: string, name: string): LineEnding | null {
  const out = git(dir, ["check-attr", "eol", "--", name]);
  const m = out?.match(/: eol: (lf|crlf)\s*$/m);
  return m ? (m[1] as LineEnding) : null;
}

/**
 * The ending the index holds for most tracked text files in `dir` (`git ls-files --eol`), when
 * git checks them out as they are: with `core.autocrlf` true the working tree is CRLF on purpose
 * and the siblings already show it.
 */
function indexEnding(dir: string): LineEnding | null {
  const autocrlf = git(dir, ["config", "--get", "core.autocrlf"])?.trim().toLowerCase();
  if (autocrlf === "true") return null;
  const out = git(dir, ["ls-files", "--eol", "--", "."]);
  if (!out) return null;
  let crlf = 0;
  let lf = 0;
  for (const line of out.split("\n")) {
    // `i/lf    w/crlf  attr/text=auto eol=lf\tpath`: the attribute may hold a space, the tab not.
    const tab = line.indexOf("\t");
    const path = tab < 0 ? "" : line.slice(tab + 1);
    const index = line.split(" ", 1)[0];
    if (!path || path.includes("/")) continue;
    if (index === "i/crlf") crlf++;
    else if (index === "i/lf") lf++;
  }
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? "crlf" : "lf";
}

/**
 * Ending for a file that does not exist yet: the git policy first (the path's `eol` attribute,
 * then the index ending of the tracked siblings), then `.editorconfig` `end_of_line`, else the
 * dominant ending of a few sibling text files in the working tree, else null (caller keeps the
 * text as given). The working tree alone misleads: a fixer that wrote one sibling CRLF on
 * Windows made every new file of the directory CRLF in a `eol=lf` repository (#2214).
 */
export function detectNewFileLineEnding(dir: string, name?: string): LineEnding | null {
  const attribute = name ? attributeEnding(dir, basename(name)) : null;
  if (attribute) return attribute;
  const indexed = indexEnding(dir);
  if (indexed) return indexed;
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

/**
 * Each file's shape before a fixer runs: its ending when all its lines end alike (null when mixed
 * or without a line break), and whether it starts with a UTF-8 byte-order mark (#2592).
 */
export interface FileShape {
  eol: LineEnding | null;
  bom: boolean;
}
export type Endings = Map<string, FileShape>;

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const hasBom = (bytes: Buffer) => bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM);

/** The shape of each existing text file in `paths`; binary files and missing ones are left out. */
export function captureEndings(paths: readonly string[]): Endings {
  const endings: Endings = new Map();
  for (const path of paths) {
    try {
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue;
      const { crlf, lf } = countLineEndings(bytes.toString("utf-8"));
      const eol = crlf + lf > 0 && (crlf === 0 || lf === 0) ? (crlf ? "crlf" : "lf") : null;
      endings.set(path, { eol, bom: hasBom(bytes) });
    } catch {
      // not there yet
    }
  }
  return endings;
}

/**
 * Puts back the LF ending of each file a fixer or formatter rewrote with CRLF: Ruby on Windows
 * writes text mode, so `rubocop -a` turns a LF file it corrects into CRLF, and cops that match a
 * line's end are blind on the CRLF tree the checks see while the committed LF tree fails
 * (namesound R70, #2214). Only that direction: a fixer that writes LF (`gofmt -w`) moves a file
 * toward what git commits, and its check flags CRLF itself. It also strips a UTF-8 byte-order
 * mark the file did not have: `Invoke-ScriptAnalyzer -Fix` saves every file it changes with one
 * (R84 wrapsmith, #2592); a file that had a mark keeps it. Returns the paths it rewrote.
 */
export function restoreEndings(before: Endings): string[] {
  const restored: string[] = [];
  for (const [path, shape] of before) {
    try {
      const bytes = readFileSync(path);
      const addedBom = !shape.bom && hasBom(bytes);
      const body = addedBom ? bytes.subarray(3) : bytes;
      const text = body.toString("utf-8");
      const crlf = shape.eol === "lf" && text.includes("\r\n");
      if (!addedBom && !crlf) continue;
      writeFileSync(path, crlf ? toLf(text) : body);
      restored.push(path);
    } catch {
      // removed by the fixer
    }
  }
  return restored;
}
