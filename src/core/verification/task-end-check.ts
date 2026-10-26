/**
 * Attribution of a whole-unit check's output (tsc, cargo check or clippy, mypy, pyright, go vet)
 * to one task (#673). In a task's worktree these checks also fail on files that sibling tasks
 * have not written yet, so only errors located in the task's own files, not explained by a
 * pending sibling and not present before the run, go back to the implementer.
 */

/** One located diagnostic: the file it points at and its text without the location. */
export interface Diagnostic {
  path: string;
  text: string;
}

/**
 * A diagnostic header followed by a location line: rustc, clippy (`error[E0308]: ...` / `--> a.rs:3:5`)
 * and ruff's default `full` format (`F401 [*] \`os\` imported but unused` / `--> tools/a.py:1:8`, #1326).
 */
const HEADER =
  /^(?:(?:error|warning)(?:\[[A-Za-z0-9]+\])?:|[A-Z]{1,4}\d{2,4}\b(?:\s+\[\*\])?\s)\s*\S/;
const ARROW = /^\s*-->\s*(.+?):\d+(?::\d+)?\s*$/;
/** `path(3,5): msg` (tsc), `path:3:5: msg` or `path:3:5 - msg` (tsc pretty, pyright, go vet), `path:3: msg` (mypy). */
const LOCATED = /^\s*(.+?\.[A-Za-z0-9]+)(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*(?::|-)\s*(.+)$/;
/** Errors about a module, file or symbol that may not exist yet: a pending sibling may explain them. */
const UNRESOLVED =
  /cannot find|can't find|not found|unresolved|undefined|undeclared|no exported member|could not import|has no attribute|no module named|E0583|E0432|E0433|E0412|E0425|TS2305|TS2307|TS2304/i;

/** A Biome diagnostic header: `src/a.ts:3:7 lint/style/useConst FIXABLE ━━━` or `biome.json format ━━━`. */
const BIOME =
  /^\s*(\S+?\.[A-Za-z0-9]+)(?::\d+:\d+)?\s+((?:lint|format|assist|parse|organizeImports)\S*)[^━]*━/;

const normalizePath = (path: string): string =>
  path.trim().replaceAll("\\", "/").replace(/^\.\//, "");

/** The located diagnostics of a check's output, with notes and summary lines left out. */
export function diagnostics(output: string): Diagnostic[] {
  return headedDiagnostics(output).map(({ path, text }) => ({ path, text }));
}

/**
 * The located diagnostics of a check's output with the output line that holds each one's header,
 * which carries a tool's own markers (`[Correctable]`, `[*]`, `FIXABLE`).
 */
export function headedDiagnostics(output: string): (Diagnostic & { line: string })[] {
  const found: (Diagnostic & { line: string })[] = [];
  let header: string | null = null;
  for (const line of output.replace(/\r\n?/g, "\n").split("\n")) {
    if (HEADER.test(line)) {
      header = line.trim();
      continue;
    }
    const arrow = ARROW.exec(line);
    if (arrow?.[1]) {
      if (header) found.push({ path: normalizePath(arrow[1]), text: header, line: header });
      header = null;
      continue;
    }
    const biome = BIOME.exec(line);
    if (biome?.[1] && biome[2]) {
      found.push({ path: normalizePath(biome[1]), text: biome[2], line });
      continue;
    }
    const located = LOCATED.exec(line);
    if (located?.[1] && located[2] && !/^\s*note\b/i.test(located[2]))
      found.push({ path: normalizePath(located[1]), text: located[2].trim(), line });
  }
  return found;
}

/** A diagnostic's identity across runs: its file and its text with line numbers left out. */
export const diagnosticKey = (d: Diagnostic): string => `${d.path}|${d.text.replace(/\d+/g, "#")}`;

/** Whether a reported path is the workspace-relative `path` (checks may print absolute paths). */
const samePath = (reported: string, path: string): boolean =>
  reported === path || reported.endsWith(`/${path}`);

/** A path into one of BAKED's worktrees, up to the workspace-relative part. */
const WORKTREE_PREFIX = /^.*?\/\.baked\/worktrees\/[^/]+\/[^/]+\//;

/** The located diagnostics of a check run in `root`, with absolute paths made workspace-relative. */
const relativeDiagnostics = (output: string, root: string): Diagnostic[] =>
  relativeHeaded(output, root).map(({ path, text }) => ({ path, text }));

/** `headedDiagnostics` of a check run in `root`, with absolute paths made workspace-relative. */
export const relativeHeaded = (output: string, root: string): (Diagnostic & { line: string })[] => {
  const prefix = `${normalizePath(root).replace(/\/$/, "")}/`;
  // The working copy behind the run's worktrees counts as the workspace too.
  const project = prefix.replace(/\.baked\/worktrees\/.*$/, "");
  return headedDiagnostics(output).map((d) => ({
    path: d.path.startsWith(prefix)
      ? d.path.slice(prefix.length)
      : WORKTREE_PREFIX.test(d.path)
        ? d.path.replace(WORKTREE_PREFIX, "")
        : d.path.startsWith(project)
          ? d.path.slice(project.length)
          : d.path,
    text: d.text,
    line: d.line,
  }));
};

/** Diagnostic keys of a baseline run in `root`, with absolute paths made workspace-relative. */
export function baselineKeys(output: string, root: string): string[] {
  return [...new Set(relativeDiagnostics(output, root).map(diagnosticKey))];
}

/**
 * The diagnostics of a failing static check that are all debt from before the run (#1222): each
 * one was in the baseline run, none is in a file the run may change, and together they account
 * for the tool's whole summary count, so no diagnostic the parser missed can hide behind them.
 * Null when any of that does not hold and the check fails as usual.
 */
export function baselineDebt(
  output: string,
  root: string,
  options: { baseline: readonly string[]; changed: readonly string[]; summary: number | null },
): string[] | null {
  const found = relativeDiagnostics(output, root);
  if (!found.length || options.summary === null || found.length < options.summary) return null;
  const baseline = new Set(options.baseline);
  const debt: string[] = [];
  for (const d of found) {
    const key = diagnosticKey(d);
    if (!baseline.has(key) || options.changed.some((path) => samePath(d.path, path))) return null;
    if (!debt.includes(key)) debt.push(key);
  }
  return debt;
}

/**
 * The errors of a whole-unit check's output that belong to a task: located in a file it writes,
 * absent from the baseline, and not about a file a pending sibling task will write. An
 * unresolved module or name is not attributed while a sibling that writes code is still pending,
 * since that sibling may be what defines it (`mod parse;` before `src/parse.rs` exists).
 */
export function taskErrors(
  output: string,
  options: {
    written: readonly string[];
    /** Code files that sibling tasks not yet done will write. */
    pending: readonly string[];
    baseline: readonly string[];
  },
): string[] {
  const baseline = new Set(options.baseline);
  const errors: string[] = [];
  for (const d of diagnostics(output)) {
    const path = options.written.find((written) => samePath(d.path, written));
    if (!path || baseline.has(diagnosticKey({ path, text: d.text }))) continue;
    if (options.pending.some((pending) => d.text.includes(pending))) continue;
    if (options.pending.length && UNRESOLVED.test(d.text)) continue;
    const line = `${path}: ${d.text}`;
    if (!errors.includes(line)) errors.push(line);
  }
  return errors;
}
