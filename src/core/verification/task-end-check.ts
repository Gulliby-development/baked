/**
 * Attribution of a whole-unit check's output (tsc, cargo check or clippy, mypy, pyright, go vet)
 * to one task (#673). In a task's worktree these checks also fail on files that sibling tasks
 * have not written yet, so only errors located in the task's own files, not explained by a
 * pending sibling and not present before the run, go back to the implementer.
 */

import { type LanguageRecord, none } from "../intelligence/language-records.js";
import { plainOutput } from "./plain-output.js";

/** One located diagnostic: the file it points at and its text without the location. */
export interface Diagnostic {
  path: string;
  text: string;
}

/**
 * A diagnostic header followed by a location line: rustc, clippy (`error[E0308]: ...` / `--> a.rs:3:5`),
 * ruff's default `full` format (`F401 [*] \`os\` imported but unused` / `--> tools/a.py:1:8`, #1326),
 * solc (`DeclarationError: Undeclared identifier.` / `--> src/A.sol:3:5:`) and Elixir 1.15+
 * (`error: undefined variable "x"` / `└─ lib/a.ex:3:5: A.f/0`, #2616).
 */
const HEADER =
  /^(?:(?:error|warning)(?:\[[A-Za-z0-9]+\])?:|[A-Z]{1,4}\d{2,4}\b(?:\s+\[\*\])?\s|(?:[A-Z][A-Za-z]*Error|Warning):)\s*\S/;
const ARROW = /^\s*(?:-->|└─)\s*(.+?):\d+(?::\d+)?:?(?:\s+\S.*)?\s*$/;
/**
 * The prefixes a tool puts before a located line: sbt's `[error]`, Elixir's `** (CompileError)`
 * and `dart analyze`'s `error - ` (#2616).
 */
const PREFIX = String.raw`(?:\[(?:error|warn|warning)\]\s+|\*\* \(\w+\)\s+|(?:error|warning|info) - )?`;
/** `path(3,5): msg` (tsc, C#), `path:3:5: msg` or `path:3:5 - msg` (tsc pretty, pyright, go vet, clang, swiftc, zig), `path:3: msg` (mypy, javac). */
const LOCATED = new RegExp(
  String.raw`^\s*${PREFIX}(.+?\.[A-Za-z0-9]+)(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*(?::|-)\s*(.+)$`,
);
/** kotlinc: `e: file:///p/A.kt:3:5 msg` (Kotlin 2) and `e: /p/A.kt: (3, 5): msg` (Kotlin 1). */
const KOTLIN = /^\s*[ew]: (?:file:\/\/)?(.+?\.kts?)(?::\d+:\d+ |: \(\d+, \d+\): )(.+)$/;
/**
 * A location line with the message on a later line: ReScript's `src/A.res:168:9-14` (a column or
 * line range), svelte-check's `src/App.svelte:3:5`, and OCaml's `File "src/a.ml", line 3,
 * characters 5-9:`, after which the compiler prints a code frame and then the message (#2616).
 */
const BARE_LOCATION = /^\s*(.+?\.[A-Za-z0-9]+):\d+:\d+(?:-\d+(?::\d+)?)?\s*$/;
const OCAML_LOCATION = /^\s*File "(.+?)", lines? \d+(?:-\d+)?(?:, characters \d+-\d+)?:\s*$/;
/** A code frame line between a location and its message: `166 │ code`, `  |`, `    ^^^^`. */
const CODE_FRAME = /^\s*(?:\d+\s*)?[│|┆┃]|^\s*[\^~]+\s*$|^\s*\.\.\.\s*$/;
/** Errors about a module, file or symbol that may not exist yet: a pending sibling may explain them. */
const UNRESOLVED =
  /cannot find|can't find|not found|unresolved|undefined|undeclared|no exported member|could not import|has no attribute|no module named|unbound|E0583|E0432|E0433|E0412|E0425|TS2305|TS2307|TS2304/i;

/** A Biome diagnostic header: `src/a.ts:3:7 lint/style/useConst FIXABLE ━━━` or `biome.json format ━━━`. */
const BIOME =
  /^\s*(\S+?\.[A-Za-z0-9]+)(?::\d+:\d+)?\s+((?:lint|format|assist|parse|organizeImports)\S*)[^━]*━/;

const normalizePath = (path: string): string =>
  path.trim().replaceAll("\\", "/").replace(/^\.\//, "");

/**
 * The whole-unit check output of each supported language's compiler or type checker, with the
 * located diagnostic `diagnostics` reads from it (#2616): every row is one of the forms above, or
 * `none(reason)` where the language has no whole-unit check here. Registered in
 * `tests/language-parity.test.ts`, which reads each example plain and coloured; a gate detector
 * that adds a compiler adds its form here and to the parsers above.
 */
export const DIAGNOSTIC_FORMATS: LanguageRecord<{ tool: string; example: string }> = {
  typescript: {
    tool: "tsc",
    example: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
  },
  javascript: {
    tool: "tsc --checkJs",
    example:
      "src/a.js:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.\n\n3 const n = 'a';\n      ~\n",
  },
  python: {
    tool: "mypy",
    example:
      'src/a.py:3: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]\nFound 1 error in 1 file (checked 2 source files)\n',
  },
  go: { tool: "go vet", example: "# example.com/calc\n./calc.go:3:5: undefined: sub\n" },
  rust: {
    tool: "cargo check",
    example:
      'error[E0308]: mismatched types\n --> src/lib.rs:3:5\n  |\n3 |     "a"\n  |     ^^^ expected `i32`, found `&str`\n',
  },
  java: {
    tool: "javac",
    example:
      'src/main/java/calc/Calc.java:3: error: incompatible types: String cannot be converted to int\n        return "a";\n               ^\n1 error\n',
  },
  kotlin: {
    tool: "kotlinc",
    example:
      "e: file:///p/src/main/kotlin/Calc.kt:3:5 Unresolved reference 'sub'.\ne: /p/src/main/kotlin/Old.kt: (4, 9): Type mismatch: inferred type is String but Int was expected\n",
  },
  scala: {
    tool: "sbt compile",
    example:
      '[error] /p/src/main/scala/Calc.scala:3:5: type mismatch;\n[error]  found   : String("a")\n[error]  required: Int\n',
  },
  csharp: {
    tool: "dotnet build",
    example:
      "src/Calc.cs(3,5): error CS0029: Cannot implicitly convert type 'string' to 'int' [/p/Calc.csproj]\n",
  },
  c: {
    tool: "clang",
    example: "src/calc.c:3:5: error: incompatible pointer to integer conversion\n",
  },
  cpp: {
    tool: "clang++",
    example: "src/calc.cpp:3:5: error: no matching function for call to 'sub'\n",
  },
  ruby: { tool: "ruby -wc", example: "lib/calc.rb:3: syntax error, unexpected end-of-input\n" },
  php: none("phpstan prints a table, read by its summary count, not per file"),
  swift: {
    tool: "swift build",
    example:
      "/p/Sources/Calc/Calc.swift:3:5: error: cannot convert value of type 'String' to specified type 'Int'\n",
  },
  lua: { tool: "luacheck", example: "    src/calc.lua:3:5: (W211) unused variable 'x'\n" },
  elixir: {
    tool: "mix compile",
    example:
      '** (CompileError) lib/calc.ex:3: undefined function sub/2\nerror: undefined variable "x"\n    │\n  4 │     x + 1\n    │     ^\n    │\n    └─ lib/calc/old.ex:4:5: Calc.Old.f/0\n',
  },
  dart: {
    tool: "dart analyze",
    example:
      "Analyzing calc...\n\n  error - lib/calc.dart:3:5 - A value of type 'String' can't be assigned to a variable of type 'int'. - invalid_assignment\n",
  },
  zig: {
    tool: "zig build",
    example: "src/main.zig:3:5: error: expected type 'u32', found '[]const u8'\n",
  },
  bash: none("shellcheck is a file-local linter, run per task"),
  ocaml: {
    tool: "dune build",
    example:
      'File "bin/main.ml", line 3, characters 15-18:\n3 | let x : int = "a"\n                   ^^^\nError: This expression has type string but an expression was expected of type int\n',
  },
  objc: { tool: "clang", example: "src/Calc.m:3:5: error: use of undeclared identifier 'sub'\n" },
  vue: {
    tool: "vue-tsc",
    example: "src/App.vue:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.\n",
  },
  svelte: {
    tool: "svelte-check",
    example:
      "/p/src/App.svelte:3:5\nError: Type 'string' is not assignable to type 'number'. (ts)\n",
  },
  rescript: {
    tool: "rescript build",
    example:
      "\n  We've found a bug for you!\n  /p/.baked/worktrees/e7760f1b/main/src/Evaluate.res:168:9-14\n\n  166 ┆ let x = 1\n  167 ┆ switch v {\n  168 ┆ | Some(value) => value\n\n  This has type: value\n  But it's expected to have type: option<value>\n",
  },
  solidity: {
    tool: "solc",
    example:
      "DeclarationError: Undeclared identifier.\n --> src/Calc.sol:3:5:\n  |\n3 |     sub(1, 2);\n  |     ^^^\n",
  },
  sql: none("SQL files have no whole-unit type check here"),
  powershell: none("PSScriptAnalyzer is a file-local linter, run per task"),
  r: none("R has no whole-unit type check here"),
};

/** The located diagnostics of a check's output, with notes and summary lines left out. */
export function diagnostics(output: string): Diagnostic[] {
  return headedDiagnostics(output).map(({ path, text }) => ({ path, text }));
}

/**
 * The located diagnostics of a check's output with the output line that holds each one's header,
 * which carries a tool's own markers (`[Correctable]`, `[*]`, `FIXABLE`). Read without escape
 * codes (`plainOutput`): tsc `--pretty` and ReScript colour their locations even without a
 * terminal (#2616).
 */
export function headedDiagnostics(output: string): (Diagnostic & { line: string })[] {
  const found: (Diagnostic & { line: string })[] = [];
  let header: string | null = null;
  // A location whose message is on a later line, after the code frame.
  let located: { path: string; line: string } | null = null;
  for (const line of plainOutput(output).replace(/\r\n?/g, "\n").split("\n")) {
    if (located) {
      if (!line.trim() || CODE_FRAME.test(line)) continue;
      if (!BARE_LOCATION.test(line) && !OCAML_LOCATION.test(line)) {
        found.push({ path: located.path, text: line.trim(), line: located.line });
        located = null;
        continue;
      }
      located = null;
    }
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
    const kotlin = KOTLIN.exec(line);
    if (kotlin?.[1] && kotlin[2]) {
      found.push({ path: normalizePath(kotlin[1]), text: kotlin[2].trim(), line });
      continue;
    }
    const bare = BARE_LOCATION.exec(line) ?? OCAML_LOCATION.exec(line);
    if (bare?.[1]) {
      located = { path: normalizePath(bare[1]), line: line.trim() };
      continue;
    }
    const match = LOCATED.exec(line);
    if (match?.[1] && match[2] && !/^\s*note\b/i.test(match[2]))
      found.push({ path: normalizePath(match[1]), text: match[2].trim(), line });
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
