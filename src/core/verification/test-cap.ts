import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { declaredTests } from "../intelligence/test-declarations.js";

/**
 * A brief's cap on the tests of one file or one class (#2368): "No file has more than 12
 * `test(...)` blocks", "at most 12 test methods per class". R75 latcell's commands feature wrote
 * 15 and 13 `test(...)` blocks in two Dart files; the reviewer found it after the task, and three
 * correctives (1.86M tokens) fought the test-integrity guard over the count. The host reads the
 * cap from the request, spec and plan, counts each written test file's declarations with
 * `TEST_DECLARATIONS` and names a file over it at task end; the integrity guard's `test-count`
 * rule lets a correction drop the tests above it.
 */
export type TestCapScope = "file" | "class";

export interface TestCap {
  cap: number;
  /** The sentence that states it, quoted in the task-end message. */
  phrase: string;
}

export type TestCaps = Partial<Record<TestCapScope, TestCap>>;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUM = String.raw`(?<n>\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})`;
/** What is counted: tests, test blocks or methods, or a code span naming them (`test(...)` blocks). */
const TESTS = String.raw`(?:(?:\x60[^\x60\n]{1,40}\x60|\[\w+\])\s+(?:test\s+)?(?:blocks?|methods?|functions?|cases?|calls?|tests?)|(?:unit\s+)?tests?(?:\s+(?:blocks?|methods?|functions?|cases?|declarations?))?)`;
const SCOPE = String.raw`(?:test\s+)?(?<scope>file|class)\b`;
const LIMIT = String.raw`(?:at\s+most|no\s+more\s+than|not\s+more\s+than|up\s+to|a\s+maximum\s+of|maximum\s+of|max(?:imum)?\.?|≤|<=)`;
const MODAL = String.raw`(?:(?:may|should|can|must|will|shall)\s+)?`;
const HAS = "(?:has|have|holds?|contains?|declares?|exceeds?)";
const IN = String.raw`(?:per|in\s+(?:a|any|each|one|every|a\s+single)|for\s+(?:each|any))`;

const CAP_SENTENCES = [
  // "No file has more than 12 `test(...)` blocks."
  String.raw`\bno\s+(?:single\s+)?${SCOPE}\s+${MODAL}${HAS}\s+(?:more\s+than|over)\s+${NUM}\s+${TESTS}`,
  // "at most 12 test methods per class"
  String.raw`${LIMIT}\s+${NUM}\s+${TESTS}\s+${IN}\s+${SCOPE}`,
  // "each test file has at most 12 tests"
  String.raw`\b(?:each|every|any|a)\s+${SCOPE}\s+${MODAL}${HAS}\s+${LIMIT}\s+${NUM}\s+${TESTS}`,
  // "12 or fewer tests per file"
  String.raw`\b${NUM}\s+(?:or\s+fewer|or\s+less)\s+${TESTS}\s+${IN}\s+${SCOPE}`,
  // "never put more than 12 tests in a file"
  String.raw`\b(?:never|not|no|don't|do\s+not)\b[^.\n]{0,40}?\b(?:more\s+than|over)\s+${NUM}\s+${TESTS}\s+${IN}\s+${SCOPE}`,
].map((source) => new RegExp(source, "gi"));
/** A cap given as data: `maxTestsPerFile: 12`. */
const CAP_FIELD = /\bmaxTestsPer(?<scope>File|Class)\b["']?\s*[:=]\s*(?<n>\d{1,4})/g;

const numberOf = (word: string): number => NUMBER_WORDS[word.toLowerCase()] ?? Number(word);

/** The per-file and per-class test caps a text states; the lowest of each scope wins. */
export function testCapsOf(text: string): TestCaps {
  const caps: TestCaps = {};
  const take = (scope: string | undefined, n: string | undefined, phrase: string) => {
    const key = scope?.toLowerCase() === "class" ? "class" : "file";
    const cap = numberOf(n ?? "");
    if (!Number.isInteger(cap) || cap < 1) return;
    const known = caps[key];
    if (!known || cap < known.cap) caps[key] = { cap, phrase: phrase.replace(/\s+/g, " ").trim() };
  };
  for (const pattern of [...CAP_SENTENCES, CAP_FIELD])
    for (const match of text.matchAll(pattern))
      take(match.groups?.scope, match.groups?.n, match[0]);
  return caps;
}

/**
 * One count the cap check compares: a file's tests, or one class's (`unit`, its index in the
 * file). No names or code, so a bench trace holds no test text.
 */
export interface TestCapMeasure {
  path: string;
  scope: TestCapScope;
  unit?: number;
  tests: number;
  cap: number;
}

/** The measures (by index) over their cap. */
export function testCapDecision(measures: readonly TestCapMeasure[]): number[] {
  return measures.flatMap((m, i) => (m.tests > m.cap ? [i] : []));
}

/** Each written test file's counts against the caps; a file of a language without a row has none. */
export function measureTestCaps(
  files: readonly { path: string; text: string }[],
  caps: TestCaps,
): TestCapMeasure[] {
  const measures: TestCapMeasure[] = [];
  for (const { path, text } of files) {
    const declared = declaredTests(path, text);
    if (!declared) continue;
    if (caps.file)
      measures.push({ path, scope: "file", tests: declared.tests, cap: caps.file.cap });
    const perClass = caps.class;
    if (perClass)
      declared.units.forEach((tests, unit) => {
        measures.push({ path, scope: "class", unit, tests, cap: perClass.cap });
      });
  }
  return measures;
}

/**
 * The tests a correction may drop from a file without a `test-count` finding: those above the
 * caps before the change, the larger of the file's excess and its classes' summed excess.
 */
export function capExcess(path: string, before: string, caps: TestCaps): number {
  if (!caps.file && !caps.class) return 0;
  const declared = declaredTests(path, before);
  if (!declared) return 0;
  const file = caps.file ? Math.max(0, declared.tests - caps.file.cap) : 0;
  const perClass = caps.class?.cap;
  const classes =
    perClass === undefined
      ? 0
      : declared.units.reduce((sum, tests) => sum + Math.max(0, tests - perClass), 0);
  return Math.max(file, classes);
}

/** The task-end line for a measure over its cap, quoting the sentence of `caps` that states it. */
export function testCapProblem(measure: TestCapMeasure, caps: TestCaps = {}): string {
  const where =
    measure.scope === "file"
      ? measure.path
      : `class ${String((measure.unit ?? 0) + 1)} of ${measure.path}`;
  const phrase = caps[measure.scope]?.phrase;
  return `${where} declares ${String(measure.tests)} tests; the spec allows at most ${String(measure.cap)} per ${measure.scope}${phrase ? ` ("${phrase}")` : ""}.`;
}

/** Each task-end cap check is recorded as `test-cap/tasks/<task>.json` (kind `test-cap`, kept in bench traces). */
export const TEST_CAP_KIND = "test-cap";
export const TEST_CAP_DIR = "test-cap/tasks/";

export interface TestCapRecord {
  schemaVersion: 1;
  taskId: string;
  /** The `test_cap` stop reason's mode: `enforce` refuses the submission, the others record. */
  mode: "shadow" | "advisory" | "enforce";
  measures: TestCapMeasure[];
  refused: number[];
}

/**
 * The cap check of a task's submission: the test files it writes, as they are under `root`,
 * against the caps. Undefined when the text states no cap or the task writes no test file.
 */
export function testCapCheck(
  caps: TestCaps,
  paths: readonly string[],
): ((root: string) => Promise<{ measures: TestCapMeasure[]; refused: number[] }>) | undefined {
  if ((!caps.file && !caps.class) || !paths.length) return undefined;
  return async (root) => {
    const files = (
      await Promise.all(
        paths.map(async (path) => {
          const text = await readFile(join(root, path), "utf8").catch(() => null);
          return text === null ? [] : [{ path, text }];
        }),
      )
    ).flat();
    const measures = measureTestCaps(files, caps);
    return { measures, refused: testCapDecision(measures) };
  };
}
