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
 * files that hold one of its cases and records what it finds; the `generated_case` stop reason
 * records the would-stop in shadow until a bench round shows its records true.
 */

import { type LanguageRecord, rowOf } from "../intelligence/language-records.js";
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
  const found: GeneratedValue[] = [];
  for (let i = 0; i < masked.length; i++) {
    const kindsHere = new Set<GeneratedKind>();
    for (const shape of wanted)
      if ((shape.read === "code" ? masked[i] : stripped[i])?.match(shape.pattern))
        kindsHere.add(shape.kind);
    for (const kind of kindsHere) found.push({ path, line: i + 1, kind });
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
