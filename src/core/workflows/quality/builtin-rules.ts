/**
 * The built-in rules of the anti-slop pack (#639), kept free of Node imports so the desktop can
 * list them. `rules.ts` runs them.
 */
export type RuleSeverity = "error" | "warning";

export interface QualityRule {
  id: string;
  title: string;
  severity: RuleSeverity;
  /** File extensions the rule reads; empty means every code file. */
  extensions: readonly string[];
  /** Whether the rule applies to test files too. */
  inTests: boolean;
  message: string;
  fix: string;
  /** The lines (0-based, from `index`) of a match starting at `index`, or null. */
  match(lines: readonly string[], index: number): number[] | null;
}

const C_LIKE = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];
const BRACE_CATCH = [...C_LIKE, ".java", ".kt", ".cs", ".php", ".swift", ".dart", ".scala"];
const PY = [".py", ".pyi"];

/** The index of the next line after `index` that is not blank, or -1. */
function nextCode(lines: readonly string[], index: number): number {
  for (let i = index + 1; i < lines.length; i++) if ((lines[i] ?? "").trim()) return i;
  return -1;
}
const lineRule =
  (pattern: RegExp) =>
  (lines: readonly string[], index: number): number[] | null =>
    pattern.test(lines[index] ?? "") ? [index] : null;

/** `catch (e) {` whose block holds only `body` (nothing, or one statement matching it). */
function catchBlock(body: RegExp | null) {
  return (lines: readonly string[], index: number): number[] | null => {
    const line = lines[index] ?? "";
    if (!/\bcatch\b/.test(line)) return null;
    const inline = /\bcatch\b[^{]*\{(.*)\}\s*(?:finally\b.*)?$/.exec(line);
    if (inline) {
      const inside = (inline[1] ?? "").trim();
      return body ? (body.test(inside) ? [index] : null) : inside === "" ? [index] : null;
    }
    if (!/\bcatch\b[^{]*\{\s*$/.test(line)) return null;
    const first = nextCode(lines, index);
    if (first < 0) return null;
    if (!body) return /^\s*\}/.test(lines[first] ?? "") ? [index, first] : null;
    const close = nextCode(lines, first);
    return body.test((lines[first] ?? "").trim()) && /^\s*\}/.test(lines[close] ?? "")
      ? [index, first, close]
      : null;
  };
}

const DEFAULT_VALUE = /^return(?:\s+(?:null|undefined|\[\]|\{\}|""|''|``|false|0|-1|None))?\s*;?$/;

export const BUILTIN_RULES: readonly QualityRule[] = [
  {
    id: "empty-catch",
    title: "Empty catch block",
    severity: "error",
    extensions: BRACE_CATCH,
    inTests: false,
    message: "An empty catch block hides the error",
    fix: "Handle the error, rethrow it with context, or let it propagate.",
    match: catchBlock(null),
  },
  {
    id: "catch-return-default",
    title: "Catch that returns a default",
    severity: "error",
    extensions: BRACE_CATCH,
    inTests: false,
    message: "A catch block that only returns a default value turns a failure into a silent result",
    fix: "Let the error propagate, or return a result the caller can tell apart from success.",
    match: catchBlock(DEFAULT_VALUE),
  },
  {
    id: "promise-catch-ignore",
    title: "Promise rejection ignored",
    severity: "error",
    extensions: C_LIKE,
    inTests: false,
    message: "`.catch` with an empty handler drops the rejection",
    fix: "Handle or log the rejection, or let it reach the caller.",
    match: lineRule(
      /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/,
    ),
  },
  {
    id: "python-swallowed-exception",
    title: "Swallowed Python exception",
    severity: "error",
    extensions: PY,
    inTests: false,
    message: "An except clause that only passes or returns None hides the error",
    fix: "Handle the exception, re-raise it with context, or catch only what you expect.",
    match: (lines, index) => {
      const line = lines[index] ?? "";
      if (!/^\s*except\b[^:]*:/.test(line)) return null;
      const swallow = /^(?:pass|\.\.\.|return(?:\s+None)?|continue)$/;
      const rest = line.slice(line.indexOf(":") + 1).trim();
      if (rest) return swallow.test(rest) ? [index] : null;
      const body = nextCode(lines, index);
      if (body < 0 || !swallow.test((lines[body] ?? "").trim())) return null;
      const after = nextCode(lines, body);
      const indent = (s: string) => s.length - s.trimStart().length;
      // The body is the only statement of the clause.
      return after < 0 || indent(lines[after] ?? "") <= indent(line) ? [index, body] : null;
    },
  },
  {
    id: "go-empty-error-check",
    title: "Empty Go error check",
    severity: "error",
    extensions: [".go"],
    inTests: false,
    message: "`if err != nil {}` with an empty block ignores the error",
    fix: "Return or handle the error.",
    match: (lines, index) => {
      const line = lines[index] ?? "";
      if (/\bif\s+err\s*!=\s*nil\s*\{\s*\}/.test(line)) return [index];
      if (!/\bif\s+err\s*!=\s*nil\s*\{\s*$/.test(line)) return null;
      const next = nextCode(lines, index);
      return next >= 0 && /^\s*\}/.test(lines[next] ?? "") ? [index, next] : null;
    },
  },
  {
    id: "go-ignored-error",
    title: "Go result discarded",
    severity: "warning",
    extensions: [".go"],
    inTests: false,
    message: "Assigning a call's results to `_` may drop an error",
    fix: "Check the error the call returns, or say in a comment why it cannot fail.",
    match: lineRule(/^\s*_\s*(?:,\s*_\s*)?=\s*[\w.]+\(/),
  },
  {
    id: "rust-unwrap",
    title: "unwrap or expect in Rust code",
    severity: "warning",
    extensions: [".rs"],
    inTests: false,
    message: "`unwrap`/`expect` panics on an error the caller could handle",
    fix: "Return the error with `?` or handle it.",
    match: (lines, index) => {
      if (!/\.(?:unwrap|expect)\(/.test(lines[index] ?? "")) return null;
      // Unit tests live in the same file under #[cfg(test)].
      for (let i = index; i >= 0; i--) if (/^\s*#\[cfg\(test\)\]/.test(lines[i] ?? "")) return null;
      return [index];
    },
  },
  {
    id: "ts-ignore",
    title: "TypeScript check turned off",
    severity: "error",
    extensions: C_LIKE,
    inTests: true,
    message: "`@ts-ignore`/`@ts-nocheck` hides type errors",
    fix: "Fix the type error; use a typed assertion only where the types cannot express it.",
    match: lineRule(/@ts-(?:ignore|nocheck)\b/),
  },
  {
    id: "explicit-any",
    title: "Explicit any",
    severity: "warning",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    inTests: false,
    message: "`any` turns off type checking for the value",
    fix: "Give the value a type, or use `unknown` and narrow it.",
    match: lineRule(/(?::\s*any\b(?!\w)|\bas\s+any\b|<any>)/),
  },
  {
    id: "lint-suppression",
    title: "Lint suppression",
    severity: "warning",
    extensions: [],
    inTests: true,
    message: "A new lint suppression hides a finding instead of fixing it",
    fix: "Fix what the linter reports, or explain on the same line why the rule does not apply.",
    match: lineRule(
      /(?:eslint-disable|biome-ignore|oxlint-disable|#\s*noqa\b|#\s*type:\s*ignore|#\s*pylint:\s*disable|\/\/\s*nolint\b|#!?\[allow\(|@SuppressWarnings\(|#pragma\s+warning\s+disable|NOSONAR)/,
    ),
  },
  {
    id: "placeholder-body",
    title: "Placeholder implementation",
    severity: "error",
    extensions: [],
    inTests: false,
    message: "The body is a placeholder, not an implementation",
    fix: "Implement the behavior, or leave the function out until a task implements it.",
    match: lineRule(
      /(?:throw\s+new\s+\w*Error\(\s*["'`](?:not\s+(?:yet\s+)?implemented|todo|unimplemented)\b|\btodo!\(|\bunimplemented!\(|panic\(\s*"(?:not\s+implemented|todo)|throw\s+new\s+(?:NotImplementedException|UnsupportedOperationException)\(\s*\))/i,
    ),
  },
  {
    id: "todo-comment",
    title: "TODO left in code",
    severity: "warning",
    extensions: [],
    inTests: false,
    message: "A TODO or FIXME marks work the run did not finish",
    fix: "Finish the work, or record it as an issue instead of a comment.",
    match: lineRule(/(?:\/\/|#|\/\*|\*|--)\s*(?:TODO|FIXME|XXX|HACK)\b/),
  },
];

export const BUILTIN_RULE_IDS = BUILTIN_RULES.map((rule) => rule.id);

/** The rules as the settings pages list them: ID, then what it finds and its severity. */
export const qualityRuleCatalog = (): Array<{ name: string; description: string }> =>
  BUILTIN_RULES.map((rule) => ({
    name: rule.id,
    description: `${rule.title} (${rule.severity}): ${rule.message}.`,
  }));
