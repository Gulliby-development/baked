/**
 * Test inputs built from generated values where the request or a criterion asks for literal
 * examples (#2344). R74 callmend's request said "every test is a literal example: no loops, no
 * interpolation, no generated inputs", and its specs built inputs with `"\\" * 3`, `pack`,
 * interpolation and `each`: rspec and rubocop passed, the task-end case walk found the expected
 * outputs and passed, and only a reviewer's family finding named the construct, one file per
 * round, 4.25M tokens (14.6 percent of the run) and the run's one intervention.
 *
 * `GENERATED_VALUE_SHAPES` holds, per supported language, the spellings of a value built by
 * repetition, formatting, interpolation, packing or a loop. The case walk reads them on the test
 * files that hold one of its cases; the `generated_case` stop reason refuses the task for what
 * it finds (enforced since #2469). A value built only from a path made at run time
 * (`RUNTIME_PATH_SOURCES`) is not generated: no literal can stand there.
 */

import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { maskNonCode, stripComments } from "../workflows/quality/code-mask.js";
import { bansPropertyTests } from "../workflows/quality/properties.js";

/** How a generated value is built. */
export type GeneratedKind = "repeat" | "format" | "interpolate" | "pack" | "loop";

/**
 * One spelling of a generated value. `code` reads the line with strings and comments blanked
 * (`maskNonCode`, delimiters kept), `strings` with only comments blanked, for an interpolation
 * that lives inside a string literal.
 */
export interface GeneratedShape {
  kind: GeneratedKind;
  pattern: RegExp;
  read: "code" | "strings";
}

const code = (kind: GeneratedKind, pattern: RegExp): GeneratedShape => ({
  kind,
  pattern,
  read: "code",
});
const inString = (pattern: RegExp): GeneratedShape => ({
  kind: "interpolate",
  pattern,
  read: "strings",
});

/** A string literal (delimiters left by the mask) or a call result repeated by `*` (`"\\" * 3`). */
const STAR_REPEAT = code("repeat", /["')\]]\s*\*\s*\d/);
const FOR_PAREN = code("loop", /\bfor\s*\(/);
const FOR_IN = code("loop", /\bfor\s+\(?\s*\w[\w\s,]*\s+in\b/);
const PRINTF = code("format", /\bs(?:n)?printf\s*\(/);

const JAVASCRIPT: readonly GeneratedShape[] = [
  code("repeat", /\.repeat\s*\(|\bArray\.from\s*\(/),
  inString(/\$\{/),
  code("loop", /\bfor\s*\(|\.(?:map|forEach|flatMap)\s*\(/),
];
const C_FAMILY: readonly GeneratedShape[] = [
  code("repeat", /\bmemset\s*\(|\bstd::string\s*\(\s*\d+\s*,/),
  PRINTF,
  code("format", /\bstringWithFormat\s*:/),
  FOR_PAREN,
];

/**
 * The spellings of a generated value in every supported language (#2344). A language added to
 * `SUPPORTED_LANGUAGES` adds its row, golden in its fixture's `generatedValues`
 * (`tests/language-parity.test.ts`).
 */
export const GENERATED_VALUE_SHAPES: LanguageRecord<readonly GeneratedShape[]> = {
  typescript: JAVASCRIPT,
  javascript: JAVASCRIPT,
  // A component's tests are TypeScript or JavaScript; the component's own script reads the same.
  vue: JAVASCRIPT,
  svelte: JAVASCRIPT,
  python: [
    STAR_REPEAT,
    code("repeat", /\bbytes\s*\(\s*range\s*\(/),
    code("format", /(?:^|[^\w])[fF][rR]?["']|\.format\s*\(/),
    FOR_IN,
  ],
  go: [
    code("repeat", /\b(?:strings|bytes)\.Repeat\s*\(/),
    code("format", /\bfmt\.Sprintf\s*\(/),
    code("loop", /\bfor\b/),
  ],
  rust: [
    code("repeat", /\.repeat\s*\(|\bvec!\s*\[[^\]]*;/),
    code("format", /\bformat!\s*\(/),
    code("loop", /\bfor\s+\w+\s+in\b|\.map\s*\(/),
  ],
  java: [
    code("repeat", /\.repeat\s*\(|\bCollections\.nCopies\s*\(/),
    code("format", /\bString\.format\s*\(|\.formatted\s*\(/),
    code("loop", /\bfor\s*\(|\.stream\s*\(|\bIntStream\b/),
  ],
  kotlin: [
    code("repeat", /\.repeat\s*\(/),
    code("format", /\.format\s*\(/),
    inString(/\$\{|\$[A-Za-z_]/),
    code("loop", /\bfor\s*\(|\.(?:map|forEach)\s*\{|(?<![.\w])repeat\s*\(/),
  ],
  scala: [
    STAR_REPEAT,
    code("interpolate", /\b[sf]"/),
    code("loop", /\bfor\s*[({]|\.(?:map|foreach)\s*[({]/),
  ],
  swift: [
    code("repeat", /\bString\s*\(\s*repeating\s*:/),
    inString(/\\\(/),
    code("loop", /\bfor\s+\w+\s+in\b|\.map\s*\{/),
  ],
  csharp: [
    code("repeat", /\bnew\s+string\s*\(\s*'[^']*'\s*,|\bEnumerable\.(?:Repeat|Range)\s*\(/),
    code("interpolate", /\$@?"/),
    code("format", /\bstring\.Format\s*\(/),
    code("loop", /\bfor(?:each)?\s*\(|\.Select\s*\(/),
  ],
  c: C_FAMILY,
  cpp: C_FAMILY,
  objc: C_FAMILY,
  ruby: [
    STAR_REPEAT,
    code("pack", /\.pack\s*\(/),
    inString(/#\{/),
    code("loop", /\.(?:each|each_with_index|map|flat_map|times|upto)\b|\bfor\s+\w+\s+in\b/),
  ],
  php: [
    code("repeat", /\bstr_repeat\s*\(/),
    code("format", /\b(?:s|vs)printf\s*\(/),
    inString(/"[^"]*(?:\{\$|\$[A-Za-z_])/),
    code("loop", /\bfor(?:each)?\s*\(|\barray_map\s*\(/),
  ],
  lua: [
    code("repeat", /\bstring\.rep\s*\(|:rep\s*\(/),
    code("format", /\bstring\.format\s*\(|:format\s*\(/),
    code("loop", /\bfor\b/),
  ],
  elixir: [
    code("repeat", /\bString\.duplicate\s*\(/),
    inString(/#\{/),
    code("loop", /\bfor\s+\w+\s*<-|\bEnum\.(?:map|each)\b/),
  ],
  dart: [
    STAR_REPEAT,
    inString(/\$\{|\$[A-Za-z_]/),
    code("loop", /\bfor\s*\(|\.map\s*\(|\bList\.generate\s*\(/),
  ],
  zig: [
    code("repeat", /["\]]\s*\*\*\s*\d/),
    code("format", /\bstd\.fmt\.(?:allocPrint|bufPrint|comptimePrint)\s*\(/),
    code("loop", /\b(?:for|while)\s*\(/),
  ],
  bash: [
    code("format", /\bprintf\b/),
    inString(/\$\(/),
    code("loop", /\bfor\s+\w+\s+in\b|\bfor\s*\(\(|\bseq\b/),
  ],
  ocaml: [
    code("repeat", /\bString\.make\b|\bList\.init\b/),
    code("format", /\b(?:Printf|Format)\.sprintf\b/),
    code("loop", /\bfor\s+\w+\s*=|\bList\.(?:map|iter)\b/),
  ],
  rescript: [
    code("repeat", /\bString\.repeat\b|\bJs\.String2?\.repeat\b/),
    inString(/`[^`]*\$\{/),
    code("loop", /\bfor\s+\w+\s+in\b|\bArray\.map\b/),
  ],
  solidity: [code("format", /\babi\.encodePacked\s*\(|\bstring\.concat\s*\(/), FOR_PAREN],
  sql: [
    code("repeat", /\b(?:repeat|replicate|lpad|rpad)\s*\(/i),
    code("format", /\bformat\s*\(/i),
    code("loop", /\bgenerate_series\s*\(|\bwith\s+recursive\b/i),
  ],
  powershell: [
    STAR_REPEAT,
    inString(/"[^"]*\$[\w({]/),
    code("format", /\s-f\s/),
    code("loop", /\bfor(?:each)?\s*\(|\bForEach-Object\b|\b\d+\.\.\d+/),
  ],
  r: [
    code("repeat", /\bstrrep\s*\(|\brep\s*\(/),
    code("format", /\b(?:paste0?|sprintf)\s*\(/),
    code("loop", /\bfor\s*\(|\b[lsv]apply\s*\(|\bseq_len\s*\(/),
  ],
};

/** One generated value in a test file: where, and how it is built. */
export interface GeneratedValue {
  path: string;
  line: number;
  kind: GeneratedKind;
}

/**
 * Where a language's tests get a path made at run time (a temporary folder or file), and how they
 * build another path from one (#2469). R78 deltaglue's T008 test wrote files into a `mkdtemp`
 * folder and built the expected stderr by interpolating their paths: no literal can stand there,
 * and the criterion's literal rows were held elsewhere in the file, so the `generated_case` record
 * was false. An interpolation or format built only from such paths is not a generated value.
 */
export interface RuntimePathShape {
  /** A call or name whose value is a path made at run time. */
  source: RegExp;
  /** A path built from another one (`join`, `resolve`, `/`). */
  join: RegExp;
  /** A named placeholder inside a string, where `{name}` is not one (Zig's `{s}` is a format). */
  named?: RegExp;
}

const JS_PATHS: RuntimePathShape = {
  source: /\b(?:mkdtemp(?:Sync)?|tmpdir|mkdtempDisposableSync)\s*\(/,
  join: /\b(?:join|resolve)\s*\(/,
};
const JVM_PATHS: RuntimePathShape = {
  source:
    /\b(?:Files\.)?createTemp(?:Directory|File)\s*\(|\bFile\.createTempFile\s*\(|@TempDir\b|java\.io\.tmpdir/,
  join: /\.resolve\s*\(|\bPaths?\.(?:get|of)\s*\(|\bFile\s*\(/,
};
const C_PATHS: RuntimePathShape = {
  source: /\b(?:mkdtemp|mkstemp|tmpnam|temp_directory_path|NSTemporaryDirectory)\s*\(/,
  join: /\bstrcat\s*\(|\s\/\s|\bstringByAppendingPathComponent\s*:/,
};

/** Per supported language, the runtime paths of its tests (#2469), golden in each fixture's `runtimePaths`. */
export const RUNTIME_PATH_SOURCES: LanguageRecord<RuntimePathShape> = {
  typescript: JS_PATHS,
  javascript: JS_PATHS,
  vue: JS_PATHS,
  svelte: JS_PATHS,
  python: {
    source:
      /\b(?:mkdtemp|mkstemp|gettempdir|TemporaryDirectory|NamedTemporaryFile|tmp_path|tmp_path_factory|tmpdir)\b/,
    join: /\bos\.path\.join\s*\(|\.joinpath\s*\(|\/\s*["'\w]/,
  },
  go: {
    source: /\b\w+\.TempDir\s*\(|\bos\.(?:MkdirTemp|CreateTemp)\s*\(/,
    join: /\b(?:filepath|path)\.Join\s*\(/,
  },
  rust: {
    source: /\b(?:tempdir|tempfile|temp_dir)\s*\(|\b(?:TempDir|NamedTempFile)::new\b/,
    join: /\.join\s*\(/,
  },
  java: JVM_PATHS,
  kotlin: JVM_PATHS,
  scala: {
    source: /\bFiles\.createTemp(?:Directory|File)\s*\(|\bos\.temp(?:\.dir)?\s*\(/,
    join: /\.resolve\s*\(|\s\/\s/,
  },
  swift: {
    source: /\btemporaryDirectory\b|\bNSTemporaryDirectory\s*\(/,
    join: /\.appending(?:PathComponent)?\s*\(/,
  },
  csharp: {
    source: /\bPath\.(?:GetTempPath|GetTempFileName)\s*\(|\bDirectory\.CreateTempSubdirectory\s*\(/,
    join: /\bPath\.(?:Combine|Join)\s*\(/,
  },
  c: C_PATHS,
  cpp: C_PATHS,
  objc: C_PATHS,
  ruby: {
    source: /\bDir\.(?:mktmpdir|tmpdir)\b|\bTempfile\b/,
    join: /\bFile\.join\s*\(/,
  },
  php: {
    source: /\b(?:sys_get_temp_dir|tempnam|tmpfile)\s*\(/,
    join: /\.\s*["'/]|\bDIRECTORY_SEPARATOR\b/,
  },
  lua: { source: /\bos\.tmpname\s*\(/, join: /\.\.\s*["']/ },
  elixir: { source: /\bSystem\.tmp_dir!?\s*\(|\btmp_dir\b/, join: /\bPath\.join\s*\(/ },
  dart: { source: /\bDirectory\.systemTemp\b|\bcreateTemp(?:Sync)?\s*\(/, join: /\bjoin\s*\(/ },
  // A Zig string has no named placeholder: `{s}` and `{d}` are formats.
  zig: { source: /\btmpDir\s*\(/, join: /\bfs\.path\.join\s*\(/, named: /(?!)/g },
  bash: { source: /\bmktemp\b|\bBATS_(?:TEST_)?TMPDIR\b/, join: /\$\{?\w+\}?\// },
  ocaml: {
    source: /\bFilename\.(?:temp_dir|temp_file|get_temp_dir_name)\b/,
    join: /\bFilename\.concat\b/,
  },
  rescript: { source: /\b(?:tmpdir|mkdtempSync)\b/, join: /\bjoin\b/ },
  solidity: none("A Solidity contract test has no file system"),
  sql: none("A SQL test has no file system"),
  powershell: {
    source: /\bGetTempPath\s*\(|\$env:TEMP\b|\bNew-TemporaryFile\b|\bTestDrive:/,
    join: /\bJoin-Path\b/,
  },
  r: { source: /\b(?:tempdir|tempfile|local_tempdir)\s*\(/, join: /\bfile\.path\s*\(/ },
};

/** A name and the expression it is bound to, in any supported language's spelling. */
const ASSIGNMENT =
  /(?:^|[^\w.$@])[$@]?([A-Za-z_]\w*)\s*(?::=|<-|(?<![=!<>:+\-*/%|&^])=(?![=>~]))\s*(.+)$/;
/** The name a line without an assignment binds (`as d:`, `|dir|`, `@TempDir Path dir;`). */
const LAST_NAME = /([A-Za-z_]\w*)\W*$/;
const words = (text: string) => [...text.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]);

/** The names a test file binds to a path made at run time, by its language's row (#2469). */
export function runtimePathNames(path: string, text: string): Set<string> {
  const row = rowOf(RUNTIME_PATH_SOURCES, detectLanguageFromPath(path));
  const names = new Set<string>();
  if (!row) return names;
  const lines = stripComments(path, text).split("\n");
  for (let grew = true; grew; ) {
    grew = false;
    for (const line of lines) {
      const bound = line.match(ASSIGNMENT);
      const name = bound
        ? bound[1]
        : row.source.test(line)
          ? line.match(LAST_NAME)?.[1]
          : undefined;
      const value = bound?.[2] ?? line;
      if (!name || names.has(name)) continue;
      if (
        row.source.test(value) ||
        (row.join.test(value) && words(value).some((w) => names.has(w)))
      ) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** Words that neither name a value nor build one. */
const NEUTRAL = new Set([
  "if",
  "else",
  "elif",
  "unless",
  "then",
  "do",
  "assert",
  "await",
  "try",
  "return",
  "const",
  "let",
  "var",
  "val",
  "final",
  "local",
  "my",
  "auto",
  "new",
  "in",
  "of",
  "not",
  "and",
  "or",
  "is",
  "true",
  "false",
  "True",
  "False",
  "None",
  "nil",
  "null",
  "printf",
  "echo",
  "sizeof",
  "string",
  "String",
  "str",
]);

/**
 * Whether an interpolation or format on a line is built only from runtime paths (#2469): every
 * name in its placeholders, and for a format every value name of the line's right-hand side,
 * is one of `names` or the row's own source, and at least one is. A callee, a member, an owner
 * (`dir.path`, `std.fmt`), a format's destination (`snprintf(buf, sizeof buf, ...)`) and a
 * keyword build nothing; an owner that is a runtime path still counts as one.
 */
function fromRuntimePaths(
  maskedLine: string,
  codeLine: string,
  kind: GeneratedKind,
  names: ReadonlySet<string>,
  row: RuntimePathShape,
): boolean {
  const runtime = (name: string) => names.has(name) || row.source.test(name);
  // String text alone: the characters the mask blanked.
  const inStrings = [...codeLine].map((ch, i) => (maskedLine[i] === ch ? " " : ch)).join("");
  const values = [
    ...[
      ...codeLine.matchAll(
        /\$\{\s*([A-Za-z_]\w*)|#\{\s*([A-Za-z_]\w*)|\\\(\s*([A-Za-z_]\w*)|\$\(\s*([A-Za-z_]\w*)/g,
      ),
    ],
    ...[...inStrings.matchAll(row.named ?? /\{\s*([A-Za-z_]\w*)|\$([A-Za-z_]\w*)/g)],
  ].map((m) => m.slice(1).find(Boolean) ?? "");
  if (kind === "format") {
    const rhs = maskedLine.match(ASSIGNMENT)?.[2] ?? maskedLine;
    for (const m of rhs.matchAll(/[A-Za-z_]\w*/g)) {
      const at = m.index ?? 0;
      const before = rhs.slice(0, at);
      const after = rhs.slice(at + m[0].length);
      const builds =
        !NEUTRAL.has(m[0]) &&
        !/[.:]$/.test(before) &&
        !/^\s*[(!"'`:.]/.test(after) &&
        !/\bs(?:n)?printf\s*\(\s*&?$|\bsizeof\s+$/.test(before) &&
        // An Objective-C message's receiver (`[NSString stringWithFormat:...]`).
        !(/\[\s*$/.test(before) && /^\s+\w/.test(after));
      if (builds || runtime(m[0])) values.push(m[0]);
    }
  }
  return values.length > 0 && values.every(runtime);
}

/** The generated values of `kinds` in a file, one per line and kind, by its language's row. */
export function generatedValues(
  path: string,
  text: string,
  kinds: ReadonlySet<GeneratedKind>,
): GeneratedValue[] {
  const shapes = rowOf(GENERATED_VALUE_SHAPES, detectLanguageFromPath(path)) ?? [];
  const wanted = shapes.filter((s) => kinds.has(s.kind));
  if (!wanted.length) return [];
  const masked = maskNonCode(path, text).split("\n");
  const stripped = stripComments(path, text).split("\n");
  const paths = rowOf(RUNTIME_PATH_SOURCES, detectLanguageFromPath(path));
  const names = paths ? runtimePathNames(path, text) : new Set<string>();
  const found: GeneratedValue[] = [];
  for (let i = 0; i < masked.length; i++) {
    const kindsHere = new Set<GeneratedKind>();
    for (const shape of wanted)
      if ((shape.read === "code" ? masked[i] : stripped[i])?.match(shape.pattern))
        kindsHere.add(shape.kind);
    for (const kind of kindsHere) {
      // A path made at run time cannot be written as a literal (#2469).
      if (
        paths &&
        (kind === "interpolate" || kind === "format") &&
        fromRuntimePaths(masked[i] ?? "", stripped[i] ?? "", kind, names, paths)
      )
        continue;
      found.push({ path, line: i + 1, kind });
    }
  }
  return found;
}

/** Words that ask for literal test examples. */
const LITERAL = /\bliteral\s+(?:test\s+)?(?:examples?|inputs?|values?|cases?)\b/i;
/** A ban on generated test inputs or values ("no generated inputs"). */
const NO_GENERATED =
  /\b(?:no|not|never|without|avoid|don't|do not|forbid\w*|ban\w*)\b[^.\n]{0,40}\b(?:generated|computed|constructed)\s+(?:test\s+)?(?:inputs?|values?|cases?|data)\b/i;
const NO_LOOPS = /\b(?:no|without|avoid|never use)\s+(?:\w+\s+){0,2}loops?\b/i;
const NO_INTERPOLATION = /\b(?:no|without|avoid)\s+(?:string\s+)?interpolation\b/i;

/**
 * The kinds of generated value the request or the criteria rule out for test inputs, empty when
 * they ask for no literal examples: a ban on generated inputs (`bansPropertyTests` or "no
 * generated inputs") or a literal-example wording rules out repetition, formatting, packing and
 * interpolation; "no loops" and "no interpolation" add their own kind.
 */
export function bannedGeneratedKinds(request: string, criteria: string): Set<GeneratedKind> {
  const kinds = new Set<GeneratedKind>();
  const text = `${request}\n${criteria}`;
  if (bansPropertyTests(request) || NO_GENERATED.test(text) || LITERAL.test(text))
    for (const kind of ["repeat", "format", "pack", "interpolate"] as const) kinds.add(kind);
  if (NO_INTERPOLATION.test(text)) kinds.add("interpolate");
  if (NO_LOOPS.test(text)) kinds.add("loop");
  return kinds;
}

/** The most generated values a case walk records. */
export const MAX_GENERATED_VALUES = 20;

/** Whether a walk would stop the task for generated values: it found any (`generated_case`). */
export function generatedCaseDecision(walk: { generated?: readonly GeneratedValue[] }): boolean {
  return (walk.generated?.length ?? 0) > 0;
}
