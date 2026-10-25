/**
 * The built-in rules of the anti-slop pack (#639), kept free of Node imports so the desktop can
 * list them. `rules.ts` runs them.
 */
import { type LanguageRecord, none, rowOf } from "../../intelligence/language-records.js";

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
  /**
   * The lines (0-based, from `index`) of a match starting at `index`, or null. `language` is the
   * file's language, for a rule that reads a per-language record.
   */
  match(lines: readonly string[], index: number, language: string): number[] | null;
  /**
   * A whitespace rule: it reads only files that existed at baseline, on lines whose exact text
   * (spaces included) is new there, since the other rules compare lines without their
   * indentation and a new file has no diff to keep small (#1398).
   */
  whitespace?: true;
  /**
   * The rule reads code and comments only: it matches on lines whose string content is blanked,
   * so test data such as `"custom_value: any text"` or `"# noqa"` is no finding (#1549).
   */
  code?: true;
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

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? "").length;
const PY_RAISE_NOT_IMPLEMENTED = /^\s*raise\s+NotImplementedError\b(?:\s*\(.*\))?\s*$/;
const PY_BLOCK_OPENER = /:\s*(?:#.*)?$/;
const PY_ABSTRACT_DECORATOR =
  /^\s*@\s*(?:abc\s*\.\s*)?abstract(?:method|property|classmethod|staticmethod)\b/;
const PY_ABSTRACT_CLASS = /\b(?:ABC|ABCMeta|Protocol)\b/;

/**
 * A Python `raise NotImplementedError` that is the whole body of a `def` (after an optional
 * docstring, `pass` or `...`), unless the function is abstract: decorated with `@abstractmethod`,
 * or a method of a class based on `ABC`, `Protocol` or `metaclass=ABCMeta`, where the raise is
 * the interface contract (#937).
 */
function pythonPlaceholder(lines: readonly string[], index: number): number[] | null {
  const raise = lines[index] ?? "";
  if (!PY_RAISE_NOT_IMPLEMENTED.test(raise)) return null;
  const indent = indentOf(raise);
  const after = nextCode(lines, index);
  if (after >= 0 && indentOf(lines[after] ?? "") >= indent) return null;
  // Walk back over comments, stub statements and a docstring to the line that opens the body.
  let header = index - 1;
  for (; header >= 0; header--) {
    const text = (lines[header] ?? "").trim();
    if (!text || text.startsWith("#") || text === "pass" || text === "...") continue;
    const quote = /("""|''')$/.exec(text)?.[1];
    if (!quote) break;
    if (text.length >= 6 && new RegExp(`^[rRuUbBfF]*${quote}`).test(text)) continue;
    let open = header - 1;
    while (open >= 0 && !(lines[open] ?? "").includes(quote)) open--;
    if (open < 0) return null;
    header = open;
  }
  if (header < 0 || !PY_BLOCK_OPENER.test(lines[header] ?? "")) return null;
  // The `def` header may span lines; no other block may open between it and the body.
  let def = header;
  while (def >= 0 && !/^\s*(?:async\s+)?def\s/.test(lines[def] ?? "")) {
    if (def < header && PY_BLOCK_OPENER.test(lines[def] ?? "")) return null;
    def--;
  }
  const defIndent = indentOf(lines[def] ?? "");
  if (def < 0 || defIndent >= indent) return null;
  for (let i = def - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    if (indentOf(line) !== defIndent || !/^\s*@/.test(line)) break;
    if (PY_ABSTRACT_DECORATOR.test(line)) return null;
  }
  for (let i = def - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#") || indentOf(line) >= defIndent) continue;
    if (!/^\s*class\s/.test(line)) break;
    let bases = line;
    for (let j = i + 1; j < def && !PY_BLOCK_OPENER.test(bases); j++) bases += lines[j] ?? "";
    if (PY_ABSTRACT_CLASS.test(bases)) return null;
    break;
  }
  return [index];
}

/**
 * A message that says the code is missing. "todo" counts only as the whole message or before
 * ":", "!", "." or "-": "Todo with id 3 does not exist" is an ordinary error of a todo app (#845).
 */
const NOT_IMPLEMENTED = String.raw`(?:(?:not\s+(?:yet\s+)?implemented|unimplemented)\b|todo\s*(?:["'\x60]|[:!.-]))`;

/** A line whose statement matches: the line, or null. */
const statement =
  (pattern: RegExp): Placeholder =>
  (lines, index) =>
    pattern.test(lines[index] ?? "") ? [index] : null;

/** The first matcher that finds a placeholder at the line. */
const anyOf =
  (...matchers: Placeholder[]): Placeholder =>
  (lines, index) => {
    for (const matcher of matchers) {
      const found = matcher(lines, index);
      if (found) return found;
    }
    return null;
  };

/** An exception thrown with `new` whose message says the code is missing (JS, Java, C#, PHP). */
const THROW_NEW = new RegExp(
  String.raw`throw\s+new\s+\\?[\w.\\]*(?:Error|Exception)\(\s*["'\x60]${NOT_IMPLEMENTED}`,
  "i",
);
/** A call of a failing function with that message: Go's `panic`, Lua's `error`, Zig's `@panic`. */
const failing = (names: string) =>
  new RegExp(String.raw`(?<![\w.:])(?:${names})\(\s*["'\x60]${NOT_IMPLEMENTED}`, "i");

/** Kotlin's built-in `TODO()`, by case: a `todo(...)` call is ordinary code of a todo app. */
const KOTLIN_TODO = /(?<![\w.$])TODO\(/;

/** Java's bare `UnsupportedOperationException()`, a stub unless it is a mutator's contract. */
const JAVA_UNSUPPORTED = /throw\s+new\s+(?:java\.lang\.)?UnsupportedOperationException\(\s*\)/;
const JAVA_UNSUPPORTED_STATEMENT = new RegExp(String.raw`${JAVA_UNSUPPORTED.source}\s*;?`);

/**
 * The header of a collection or iterator mutator, which a read-only type overrides to throw
 * `UnsupportedOperationException` as `Iterator.remove` and the `Collection` methods document: a
 * return type, the method name and its parameters, not a call statement.
 */
const JAVA_MUTATOR =
  /[\w>\]?]\s+(?:remove|removeAll|removeIf|retainAll|add|addAll|addFirst|addLast|set|put|putAll|putIfAbsent|clear|replaceAll|sort|push|pop|offer|poll|compute|computeIfAbsent|computeIfPresent|merge)\s*\([^;]*$/;

function javaUnsupported(lines: readonly string[], index: number): number[] | null {
  if (!JAVA_UNSUPPORTED.test(lines[index] ?? "")) return null;
  // The method header within the three code lines above (or on this line) names a mutator.
  let seen = 0;
  for (let i = index; i >= 0 && seen <= 3; i--) {
    const text = lines[i] ?? "";
    if (!text.trim()) continue;
    if (JAVA_MUTATOR.test(text.replace(JAVA_UNSUPPORTED_STATEMENT, ""))) return null;
    seen++;
  }
  return [index];
}

type Placeholder = (lines: readonly string[], index: number) => number[] | null;

const JS_PLACEHOLDER = statement(THROW_NEW);

/**
 * The placeholder statement of each supported language (#1679, #1717): the language's own way to
 * say the code is missing, with the exemptions where the same statement is a contract.
 */
export const PLACEHOLDERS: LanguageRecord<Placeholder> = {
  typescript: JS_PLACEHOLDER,
  javascript: JS_PLACEHOLDER,
  vue: JS_PLACEHOLDER,
  svelte: JS_PLACEHOLDER,
  python: pythonPlaceholder,
  go: statement(failing("panic")),
  rust: statement(/\btodo!\(|\bunimplemented!\(/),
  java: anyOf(statement(THROW_NEW), javaUnsupported),
  kotlin: anyOf(
    statement(KOTLIN_TODO),
    statement(
      new RegExp(String.raw`throw\s+[\w.]*(?:Error|Exception)\(\s*["'\x60]${NOT_IMPLEMENTED}`, "i"),
    ),
  ),
  // `???` as a whole body or right-hand side, and `NotImplementedError` with a message.
  scala: anyOf(statement(/(?:^|=)\s*\?\?\?\s*$/), statement(THROW_NEW)),
  csharp: anyOf(
    statement(THROW_NEW),
    statement(/throw\s+new\s+(?:System\.)?NotImplementedException\(/),
  ),
  php: statement(THROW_NEW),
  lua: statement(failing("error")),
  zig: statement(failing("@panic|panic")),
  swift: statement(failing("fatalError|preconditionFailure")),
  dart: anyOf(
    statement(/throw\s+(?:new\s+)?UnimplementedError\(/),
    statement(failing("throw\\s+(?:new\\s+)?UnsupportedError")),
  ),
  elixir: statement(
    new RegExp(String.raw`\braise\s+(?:[\w.]+\s*,\s*)?["']${NOT_IMPLEMENTED}`, "i"),
  ),
  ocaml: statement(
    new RegExp(
      String.raw`\bfailwith\s*\(?\s*"${NOT_IMPLEMENTED}|\bFailure\s*\(?\s*"${NOT_IMPLEMENTED}`,
      "i",
    ),
  ),
  rescript: statement(failing("failwith|Js\\.Exn\\.raiseError")),
  solidity: statement(failing("revert")),
  // PL/pgSQL `RAISE EXCEPTION 'not implemented'`, T-SQL `THROW 50000, 'not implemented', 1` and
  // `RAISERROR('not implemented', 16, 1)`, MySQL `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '…'`.
  sql: statement(
    new RegExp(
      String.raw`\b(?:raise\s+(?:exception\s*)?|throw\s+\d+\s*,\s*|raiserror\s*\(\s*|message_text\s*=\s*)N?'${NOT_IMPLEMENTED}`,
      "i",
    ),
  ),
  // `throw 'not implemented'`, `throw [System.NotImplementedException]::new()`, the same through
  // `New-Object`, and `Write-Error 'not implemented'`, as C#'s NotImplementedException (#1498).
  powershell: anyOf(
    statement(
      new RegExp(String.raw`\b(?:throw|Write-Error(?:\s+-Message)?)\s+["']${NOT_IMPLEMENTED}`, "i"),
    ),
    statement(
      /\bthrow\s+(?:\[(?:System\.)?NotImplementedException\]|\(?\s*New-Object\s+(?:System\.)?NotImplementedException\b)/i,
    ),
  ),
  // `stop("not implemented")`, rlang's `abort(...)`, and base R's `.NotYetImplemented()` (#1500).
  r: anyOf(
    statement(
      new RegExp(
        String.raw`\b(?:stop|(?:rlang::)?abort|cli::cli_abort)\s*\(\s*["']${NOT_IMPLEMENTED}`,
        "i",
      ),
    ),
    statement(/\.NotYetImplemented\s*\(/),
  ),
  cpp: anyOf(
    statement(THROW_NEW),
    statement(new RegExp(String.raw`throw\s+std::\w+\(\s*"${NOT_IMPLEMENTED}`, "i")),
    statement(new RegExp(String.raw`assert\(\s*(?:0|false)\s*&&\s*"${NOT_IMPLEMENTED}`, "i")),
  ),
  c: statement(new RegExp(String.raw`assert\(\s*(?:0|false)\s*&&\s*"${NOT_IMPLEMENTED}`, "i")),
  ruby: none(
    "`raise NotImplementedError` is also Ruby's abstract-method idiom, with no marker that tells the two apart",
  ),
  objc: none("Objective-C has no placeholder statement of its own: stubs raise any NSException"),
  bash: none("a shell function has no placeholder statement; `exit 1` is ordinary error handling"),
};

function placeholderLine(
  lines: readonly string[],
  index: number,
  language: string,
): number[] | null {
  return rowOf(PLACEHOLDERS, language)?.(lines, index) ?? null;
}

const DEFAULT_VALUE = /^return(?:\s+(?:null|undefined|\[\]|\{\}|""|''|``|false|0|-1|None))?\s*;?$/;

/**
 * The line that opens the function enclosing `index`, found by walking back over balanced
 * braces, or -1. Blocks that are not functions (`try`, `if`, a class body) are passed through.
 */
function enclosingFunction(lines: readonly string[], index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === "}") depth++;
      else if (line[c] === "{" && --depth < 0) {
        if (
          /\bfunction\b|=>|\bfun\s|\)\s*(?::[^{]*)?\{\s*$/.test(line) &&
          !/^\s*(?:\}\s*)?(?:if|for|while|switch|catch|try|else|do)\b/.test(line)
        )
          return i;
        depth = 0;
      }
    }
  }
  return -1;
}

/**
 * Whether the enclosing function declares that it returns the value a catch returns: a parse
 * helper typed `: URL | null` (or Kotlin `URL?`) that returns null for bad input, or a check
 * typed `: boolean` that returns false, gives a result the caller already tells apart from
 * success (#1192).
 */
function declaredFallback(lines: readonly string[], index: number, statement: string): boolean {
  const value = /^return\s+(null|undefined|false)\b/.exec(statement)?.[1];
  if (!value) return false;
  const header = enclosingFunction(lines, index);
  if (header < 0) return false;
  const text = lines[header] ?? "";
  // Java, C# and Dart name the type before the method: `boolean isValid(String s) {`.
  if (value === "false" && /\b(?:boolean|bool)\s+\w+\s*\(/.test(text)) return true;
  const type = /\)\s*:\s*([^{]+?)\s*(?:=>\s*)?\{\s*$/.exec(text)?.[1];
  if (!type) return false;
  if (value === "false") return /\b(?:boolean|Boolean|false)\b/.test(type);
  if (value === "undefined") return /\bundefined\b/.test(type);
  return /\bnull\b/.test(type) || /\?\s*>?$/.test(type);
}

/** `catchBlock(DEFAULT_VALUE)`, except where the function's return type declares the value. */
function catchReturnDefault(lines: readonly string[], index: number): number[] | null {
  const match = catchBlock(DEFAULT_VALUE)(lines, index);
  if (!match) return null;
  const line = lines[index] ?? "";
  const inline = /\bcatch\b[^{]*\{(.*)\}/.exec(line)?.[1];
  const statement = (inline ?? lines[match[1] ?? index] ?? "").trim();
  return declaredFallback(lines, index, statement) ? null : match;
}

/** Code files a whitespace rule reads: not Markdown, where two trailing spaces break a line. */
const CODE = [
  ...BRACE_CATCH,
  ...PY,
  ".go",
  ".rs",
  ".rb",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".kts",
  ".gradle",
  ".sh",
];
/** A line's leading spaces, or null when it is blank or indented with a tab. */
const spaces = (line: string): number | null =>
  !line.trim() || /^ *\t/.test(line) ? null : line.length - line.trimStart().length;

/**
 * The file's indentation step: the most common change of indentation between neighbouring lines.
 * Cached per file, since the rule asks for it on every line.
 */
const stepCache = new WeakMap<readonly string[], number>();
function indentStep(lines: readonly string[]): number {
  const cached = stepCache.get(lines);
  if (cached !== undefined) return cached;
  const counts = new Map<number, number>();
  let previous: number | null = null;
  for (const line of lines) {
    const indent = spaces(line);
    if (indent === null) continue;
    const change = previous === null ? 0 : Math.abs(indent - previous);
    if (change > 0) counts.set(change, (counts.get(change) ?? 0) + 1);
    previous = indent;
  }
  const step = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  stepCache.set(lines, step);
  return step;
}

/**
 * A statement indented off the file's step: an `else if` at 14 spaces among siblings at 12 in a
 * file indented by 4 (bench round 39, linehunk-update `Cli.java`). Only after a line that ends a
 * statement or opens or closes a block, so aligned continuation lines and comment bodies are left
 * alone.
 */
function unevenIndent(lines: readonly string[], index: number): number[] | null {
  const indent = spaces(lines[index] ?? "");
  if (indent === null || /^\s*(?:\*|\/\/|\.|\+|-|&&|\|\||\?|:)/.test(lines[index] ?? ""))
    return null;
  let previous = index - 1;
  while (previous >= 0 && !(lines[previous] ?? "").trim()) previous--;
  if (previous < 0) return null;
  if (!/[;{}]\s*$/.test(lines[previous] ?? "")) return null;
  const step = indentStep(lines);
  return step >= 2 && indent % step !== 0 ? [index] : null;
}

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
    match: catchReturnDefault,
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
    code: true,
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
    code: true,
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
    code: true,
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
    code: true,
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
    match: placeholderLine,
  },
  {
    id: "whitespace-only-line",
    title: "Line of only whitespace",
    severity: "error",
    extensions: CODE,
    inTests: true,
    whitespace: true,
    message: "A line holds only spaces or tabs, an unrelated change in the diff",
    fix: "Leave the line empty, as the blank lines around it are.",
    match: lineRule(/^[ \t]+\r?$/),
  },
  {
    id: "trailing-whitespace",
    title: "Trailing whitespace",
    severity: "error",
    extensions: CODE,
    inTests: true,
    whitespace: true,
    message: "A changed line ends in spaces or tabs",
    fix: "Remove the whitespace at the end of the line.",
    match: lineRule(/\S[ \t]+\r?$/),
  },
  {
    id: "uneven-indent",
    title: "Indentation off the file's step",
    severity: "warning",
    extensions: [
      ...BRACE_CATCH,
      ".go",
      ".rs",
      ".c",
      ".h",
      ".cc",
      ".cpp",
      ".hpp",
      ".kts",
      ".gradle",
    ],
    inTests: true,
    whitespace: true,
    message: "A changed line is indented off the file's indentation step",
    fix: "Indent the line like its siblings in the same block.",
    match: unevenIndent,
  },
  {
    id: "todo-comment",
    code: true,
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
