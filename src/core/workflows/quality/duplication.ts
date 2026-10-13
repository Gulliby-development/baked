/**
 * Duplication and dead-code ratchet (#638). The host measures the run's code twice: when the
 * plan is approved (the baseline, before any task edits) and in each checks stage. It counts
 * duplicated token runs (copies of at least `CLONE_TOKENS` tokens over `CLONE_LINES` lines),
 * top-level declarations nothing else names (unused code) and branch points (complexity). Under
 * `ratchet` a run that adds a copy or an unused declaration gets a blocking finding that names
 * the original; under `warn` the same findings are kept as notes in the run report.
 *
 * The analysis is built in and language-agnostic, so it needs no tool on the machine. Test files
 * are read (a function only a test calls is used) but not counted: tests repeat their setup.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { workspacePath } from "../../specs/validate.js";
import { isCodePath } from "../check-policy.js";

export type DuplicationMode = "off" | "warn" | "ratchet";
export const DUPLICATION_MODES: readonly DuplicationMode[] = ["off", "warn", "ratchet"];
/** The mode a policy without the field gets: report, never block. */
export const DEFAULT_DUPLICATION: DuplicationMode = "warn";
export const duplicationOf = (policy: { duplication?: DuplicationMode | undefined }) =>
  policy.duplication ?? DEFAULT_DUPLICATION;

/** Artifacts of the ratchet: the baseline measured at approval and the latest comparison. */
export const QUALITY_BASELINE = "quality/baseline.json";
export const QUALITY_DUPLICATION = "quality/duplication.json";
/** Whether a finding's claim is one the ratchet made, so a passing comparison closes it. */
export const qualityClaim = (claim: unknown): boolean =>
  typeof claim === "string" && /^(Duplicated code|Unused code): /.test(claim);

/** A copy is at least this many tokens long... */
export const CLONE_TOKENS = 50;
/** ...and spans at least this many lines, so long one-line literals are not copies. */
export const CLONE_LINES = 5;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Above this many copied windows the baseline keeps only the counts, not each window. */
const MAX_BASELINE_WINDOWS = 200_000;

export interface CodeMetrics {
  /** Code files measured (tests excluded). */
  files: number;
  /** Lines of non-test code covered by a copy that also appears elsewhere. */
  duplicatedLines: number;
  /** Top-level declarations whose name appears nowhere else in the code, tests included. */
  unusedDeclarations: number;
  /** Branch points (if, loops, case, catch, &&, ||, ?) in non-test code. */
  complexity: number;
}

export interface QualityBaseline {
  schemaVersion: 1;
  metrics: CodeMetrics;
  /** Window key -> occurrences, for windows that already occurred more than once. */
  duplicated: Record<string, number>;
  /** `path#name` of the declarations already unused at baseline. */
  unused: string[];
  /** Why the baseline could not be measured, when it could not. */
  skipped?: string;
}

export interface Span {
  file: string;
  startLine: number;
  endLine: number;
}
export interface CloneFinding extends Span {
  original: Span;
}
export interface UnusedFinding {
  file: string;
  line: number;
  name: string;
}

export interface DuplicationResult {
  schemaVersion: 1;
  mode: DuplicationMode;
  baseline: CodeMetrics;
  after: CodeMetrics;
  /** Copies the run added, each with the code it copies. */
  clones: CloneFinding[];
  /** Declarations the run added or changed that nothing uses. */
  unused: UnusedFinding[];
  /** Whether the result blocks the run (`ratchet` and a count grew). */
  blocking: boolean;
  skipped?: string;
}

// --- Reading -------------------------------------------------------------------------------

/** Test code: test directories and the test file names of the supported languages. */
export function isTestCodePath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|testdata|src\/test)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path) ||
    /_test\.go$/.test(path) ||
    /(Test|Tests)\.(java|kt|cs)$/.test(path)
  );
}

/** The code files of a source manifest, read; oversized files and repositories are left out. */
export async function readCodeFiles(
  root: string,
  paths: string[],
  include: (path: string) => boolean = isCodePath,
): Promise<{ files: Map<string, string>; skipped?: string }> {
  const files = new Map<string, string>();
  let total = 0;
  for (const path of paths.filter(include).sort()) {
    const absolute = workspacePath(root, path);
    try {
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) continue;
      total += info.size;
      if (total > MAX_TOTAL_BYTES)
        return { files: new Map(), skipped: "the code is larger than the analysis reads (32 MB)" };
      files.set(path, await readFile(absolute, "utf8"));
    } catch {
      // A file removed between the manifest and the read is not part of the code.
    }
  }
  return { files };
}

// --- Tokens --------------------------------------------------------------------------------

const TOKEN =
  /[A-Za-z_$][\w$]*|0[xXbBoO][\da-fA-F_]+|\d[\d_.]*(?:[eE][+-]?\d+)?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s\w]/g;
const HASH_COMMENTS = new Set([".py", ".pyi", ".rb", ".sh"]);
const BRANCH = new Set(["if", "for", "while", "case", "catch", "except", "elif", "&&", "||", "?"]);

/** Comments blanked to spaces, newlines kept, so tokens keep their line numbers. */
function stripComments(path: string, text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  if (HASH_COMMENTS.has(extname(path).toLowerCase()))
    return text.replace(/(^|[ \t])#[^\n]*/g, (m) => blank(m));
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[ \t;{}(),])\/\/[^\n]*/g, (m) => {
    const lead = m.startsWith("//") ? "" : (m[0] ?? "");
    return lead + blank(m.slice(lead.length));
  });
}

interface Tokens {
  ids: Int32Array;
  lines: Int32Array;
}

class Vocabulary {
  private readonly ids = new Map<string, number>();
  id(token: string): number {
    let id = this.ids.get(token);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(token, id);
    }
    return id;
  }
}

function tokenize(path: string, text: string, vocabulary: Vocabulary): Tokens {
  const ids: number[] = [];
  const lines: number[] = [];
  const source = stripComments(path, text);
  let line = 1;
  let scanned = 0;
  for (const match of source.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    for (let i = scanned; i < at; i++) if (source.charCodeAt(i) === 10) line++;
    scanned = at;
    ids.push(vocabulary.id(match[0]));
    lines.push(line);
  }
  return { ids: Int32Array.from(ids), lines: Int32Array.from(lines) };
}

/** Two 32-bit polynomial hashes of every window of `CLONE_TOKENS` tokens, as one key. */
function windowKeys(ids: Int32Array): string[] {
  const n = ids.length - CLONE_TOKENS + 1;
  if (n <= 0) return [];
  const A = 1_000_003;
  const B = 998_244_353;
  let powA = 1;
  let powB = 1;
  for (let i = 0; i < CLONE_TOKENS - 1; i++) {
    powA = Math.imul(powA, A);
    powB = Math.imul(powB, B);
  }
  let ha = 0;
  let hb = 0;
  for (let i = 0; i < CLONE_TOKENS; i++) {
    ha = (Math.imul(ha, A) + (ids[i] ?? 0)) | 0;
    hb = (Math.imul(hb, B) + Math.imul(ids[i] ?? 0, 40503)) | 0;
  }
  const keys = [`${ha >>> 0}.${hb >>> 0}`];
  for (let i = 1; i < n; i++) {
    const out = ids[i - 1] ?? 0;
    const inn = ids[i + CLONE_TOKENS - 1] ?? 0;
    ha = (Math.imul(ha - Math.imul(out, powA), A) + inn) | 0;
    hb = (Math.imul(hb - Math.imul(Math.imul(out, 40503), powB), B) + Math.imul(inn, 40503)) | 0;
    keys.push(`${ha >>> 0}.${hb >>> 0}`);
  }
  return keys;
}

// --- Declarations --------------------------------------------------------------------------

const DECLARATION: RegExp[] = [
  // JS/TS: functions, classes and top-level constants, exported or not.
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/,
  // Python
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  // Go (functions, not methods)
  /^func\s+([A-Za-z_]\w*)\s*[[(]/,
  // Rust
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
];
/** Names a runtime or framework calls by convention, never by name in the code. */
const CONVENTIONAL =
  /^(?:main|init|setup|teardown|default|constructor|handler|render|run|start|_+\w*|Test\w*|Benchmark\w*|Example\w*|Fuzz\w*|test\w*)$/;
const ENTRY_FILE =
  /(^|\/)(index|main|mod|lib|cli|app|server|__main__|__init__|setup|conftest)\.\w+$/;
/** A decorator, attribute or annotation on the previous line: registered by a framework. */
const MARKED = /^\s*(?:@|#\[|\[)/;

interface Declaration {
  file: string;
  line: number;
  name: string;
}

function declarations(path: string, text: string): Declaration[] {
  if (ENTRY_FILE.test(path) || /\.d\.ts$/.test(path)) return [];
  const out: Declaration[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s/.test(line)) continue; // Top level only.
    if (/^export\s+default\b/.test(line)) continue;
    if (i > 0 && MARKED.test(lines[i - 1] ?? "")) continue;
    for (const pattern of DECLARATION) {
      const name = pattern.exec(line)?.[1];
      if (name && !CONVENTIONAL.test(name)) {
        out.push({ file: path, line: i + 1, name });
        break;
      }
    }
  }
  return out;
}

// --- Analysis ------------------------------------------------------------------------------

interface Location {
  file: string;
  start: number;
}

interface Analysis {
  metrics: CodeMetrics;
  tokens: Map<string, Tokens>;
  keys: Map<string, string[]>;
  occurrences: Map<string, Location[]>;
  unused: Declaration[];
}

function analyze(files: Map<string, string>): Analysis {
  const vocabulary = new Vocabulary();
  const tokens = new Map<string, Tokens>();
  const keys = new Map<string, string[]>();
  const occurrences = new Map<string, Location[]>();
  const names = new Map<string, number>();
  let complexity = 0;
  let measured = 0;
  const branchIds = new Set([...BRANCH].map((t) => vocabulary.id(t)));
  for (const [path, text] of files) {
    const tokenized = tokenize(path, text, vocabulary);
    tokens.set(path, tokenized);
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g))
      names.set(match[0], (names.get(match[0]) ?? 0) + 1);
    if (isTestCodePath(path)) continue;
    measured++;
    for (const id of tokenized.ids) if (branchIds.has(id)) complexity++;
    const fileKeys = windowKeys(tokenized.ids);
    keys.set(path, fileKeys);
    fileKeys.forEach((key, start) => {
      const list = occurrences.get(key);
      if (list) list.push({ file: path, start });
      else occurrences.set(key, [{ file: path, start }]);
    });
  }
  // A window repeated inside its own overlap (a run of identical lines) is not a copy.
  for (const [key, list] of occurrences) {
    if (list.length < 2) continue;
    const kept: Location[] = [];
    for (const location of list)
      if (
        !kept.some(
          (k) => k.file === location.file && Math.abs(k.start - location.start) < CLONE_TOKENS,
        )
      )
        kept.push(location);
    occurrences.set(key, kept);
  }
  let duplicatedLines = 0;
  for (const [path, fileKeys] of keys) {
    const lines = tokens.get(path)?.lines;
    if (!lines) continue;
    const covered = new Set<number>();
    fileKeys.forEach((key, start) => {
      if ((occurrences.get(key)?.length ?? 0) < 2) return;
      const first = lines[start] ?? 0;
      const last = lines[start + CLONE_TOKENS - 1] ?? 0;
      if (last - first + 1 < CLONE_LINES) return;
      for (let line = first; line <= last; line++) covered.add(line);
    });
    duplicatedLines += covered.size;
  }
  const unused: Declaration[] = [];
  for (const [path, text] of files)
    if (!isTestCodePath(path))
      for (const declaration of declarations(path, text))
        if ((names.get(declaration.name) ?? 0) <= 1) unused.push(declaration);
  return {
    metrics: { files: measured, duplicatedLines, unusedDeclarations: unused.length, complexity },
    tokens,
    keys,
    occurrences,
    unused,
  };
}

/** The baseline the approval records: counts, the windows already copied and the unused names. */
export function measureBaseline(files: Map<string, string>, skipped?: string): QualityBaseline {
  if (skipped)
    return {
      schemaVersion: 1,
      metrics: { files: 0, duplicatedLines: 0, unusedDeclarations: 0, complexity: 0 },
      duplicated: {},
      unused: [],
      skipped,
    };
  const analysis = analyze(files);
  const duplicated: Record<string, number> = {};
  let kept = 0;
  for (const [key, list] of analysis.occurrences)
    if (list.length > 1 && kept++ < MAX_BASELINE_WINDOWS) duplicated[key] = list.length;
  return {
    schemaVersion: 1,
    metrics: analysis.metrics,
    duplicated,
    unused: analysis.unused.map((d) => `${d.file}#${d.name}`).sort(),
  };
}

/**
 * Compares the run's code with its baseline. A copy is a run of windows in a file the run
 * changed whose occurrences grew since the baseline; it names the occurrence it copies,
 * preferring one in a file the run did not change. An unused declaration is reported when it
 * is in a changed file and was not already unused at baseline.
 */
export function compareWithBaseline(
  mode: DuplicationMode,
  baseline: QualityBaseline,
  files: Map<string, string>,
  changed: Set<string>,
  skipped?: string,
): DuplicationResult {
  const empty = { files: 0, duplicatedLines: 0, unusedDeclarations: 0, complexity: 0 };
  if (skipped || baseline.skipped)
    return {
      schemaVersion: 1,
      mode,
      baseline: baseline.metrics,
      after: empty,
      clones: [],
      unused: [],
      blocking: false,
      skipped: skipped ?? baseline.skipped,
    };
  const analysis = analyze(files);
  const clones: CloneFinding[] = [];
  for (const path of [...changed].sort()) {
    const fileKeys = analysis.keys.get(path);
    const lines = analysis.tokens.get(path)?.lines;
    if (!fileKeys || !lines) continue;
    let block: { start: number; end: number; partner: Location; partnerEnd: number } | null = null;
    const flush = () => {
      if (!block) return;
      const startLine = lines[block.start] ?? 0;
      const endLine = lines[block.end + CLONE_TOKENS - 1] ?? 0;
      const partner = analysis.tokens.get(block.partner.file)?.lines;
      if (partner && endLine - startLine + 1 >= CLONE_LINES)
        clones.push({
          file: path,
          startLine,
          endLine,
          original: {
            file: block.partner.file,
            startLine: partner[block.partner.start] ?? 0,
            endLine: partner[block.partnerEnd + CLONE_TOKENS - 1] ?? 0,
          },
        });
      block = null;
    };
    fileKeys.forEach((key, start) => {
      const list = analysis.occurrences.get(key) ?? [];
      const grew = list.length >= 2 && list.length > (baseline.duplicated[key] ?? 1);
      const others = list.filter((l) => !(l.file === path && l.start === start));
      if (!grew || !others.length) {
        flush();
        return;
      }
      if (block && start === block.end + 1) {
        const next = others.find(
          (l) => block && l.file === block.partner.file && l.start === block.partnerEnd + 1,
        );
        if (next) {
          block.end = start;
          block.partnerEnd = next.start;
          return;
        }
      }
      flush();
      const partner = others.find((l) => !changed.has(l.file)) ?? others[0];
      if (partner) block = { start, end: start, partner, partnerEnd: partner.start };
    });
    flush();
  }
  // Two copies of the same code (A copies B and B copies A) are one finding.
  const seen = new Set<string>();
  const distinct = clones.filter((clone) => {
    const a = `${clone.file}:${clone.startLine}`;
    const b = `${clone.original.file}:${clone.original.startLine}`;
    if (seen.has(`${b}|${a}`)) return false;
    seen.add(`${a}|${b}`);
    return true;
  });
  const known = new Set(baseline.unused);
  const unused = analysis.unused
    .filter((d) => changed.has(d.file) && !known.has(`${d.file}#${d.name}`))
    .map((d) => ({ file: d.file, line: d.line, name: d.name }));
  const grew =
    (distinct.length > 0 && analysis.metrics.duplicatedLines > baseline.metrics.duplicatedLines) ||
    (unused.length > 0 &&
      analysis.metrics.unusedDeclarations > baseline.metrics.unusedDeclarations);
  return {
    schemaVersion: 1,
    mode,
    baseline: baseline.metrics,
    after: analysis.metrics,
    clones: distinct,
    unused,
    blocking: mode === "ratchet" && grew,
  };
}

/** One line per delta, e.g. `duplicated lines 120 -> 134 (+14)`. */
export function metricDeltas(result: Pick<DuplicationResult, "baseline" | "after">): string[] {
  const row = (label: string, before: number, after: number) => {
    const delta = after - before;
    return `${label} ${before} -> ${after} (${delta > 0 ? "+" : ""}${delta})`;
  };
  return [
    row("duplicated lines", result.baseline.duplicatedLines, result.after.duplicatedLines),
    row("unused declarations", result.baseline.unusedDeclarations, result.after.unusedDeclarations),
    row("complexity", result.baseline.complexity, result.after.complexity),
  ];
}
