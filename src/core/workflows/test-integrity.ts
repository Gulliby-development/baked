import { blankStringLiterals } from "../intelligence/comments.js";
import { isTestFile } from "../intelligence/language-traits.js";
import type { RunPolicy } from "./schemas.js";
import type { Task } from "./types.js";

/**
 * Test-integrity guard (#631). Agents game tests: they delete or skip them, weaken assertions,
 * special-case test inputs and add suppressions (ImpossibleBench, METR 2025). Prompts barely help,
 * so the runtime checks each task's diff and, under `testIntegrity: "block"` (the default), turns
 * what it finds into findings that a repair must undo.
 */

export type TestIntegrityMode = "block" | "warn";
/** The guard's mode under a policy; a policy without the field blocks. */
export const testIntegrityOf = (policy: Pick<RunPolicy, "testIntegrity">): TestIntegrityMode =>
  policy.testIntegrity ?? "block";

export type IntegrityRule =
  | "test-deleted"
  | "test-count"
  | "test-removed"
  | "assertions"
  | "skip"
  | "suppression"
  | "test-hook"
  | "literal-branch"
  | "verification-bypass";

export interface IntegrityFinding {
  rule: IntegrityRule;
  path: string;
  detail: string;
  /** Every test title of the file that corrections of other findings added, for the repair. */
  keep?: string[];
}

export interface FileChange {
  path: string;
  /**
   * The content before the task, null when the file did not exist, or undefined when it existed
   * but its content was not kept: then only a deletion is reported, since counts cannot be compared.
   */
  before: string | null | undefined;
  /** The content after the task, or null when the task deleted it. */
  after: string | null;
}

/** Whether a path is a test file by the conventions of its language (the language table, #1488). */
export const isTestPath = (path: string): boolean => isTestFile(path);

/**
 * A test file that existed before the run: a test path no task of the approved graph creates.
 * Implementer tasks may change one only when the plan lists the write with a reason.
 */
export function preexistingTest(path: string, tasks: readonly Task[]): boolean {
  return (
    isTestPath(path) &&
    !tasks.some((task) => task.writes.some((w) => w.path === path && w.action === "create"))
  );
}

/** Whether a line is a comment: commented-out tests and assertions do not count. */
function commentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("<!--") ||
    // `#[test]` and `#![allow]` are Rust attributes, not comments.
    (trimmed.startsWith("#") && !/^#!?\[/.test(trimmed))
  );
}

/** Lines that are code, not comments. */
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => !commentLine(line));
}

/**
 * The code lines of a file and, line for line, the same lines with string content blanked except
 * test titles (#1549): tests are found on the second, so a test quoted as data in a string (a test
 * runner's fixture) is no test, while names and bodies are read from the first.
 */
function codeView(path: string, text: string): { lines: string[]; marks: string[] } {
  const raw = text.split(/\r?\n/);
  const marked = blankStringLiterals(path, text, { titles: true }).split(/\r?\n/);
  const kept = marked.map((line) => !commentLine(line));
  return {
    lines: raw.filter((_, i) => kept[i]),
    marks: marked.filter((_, i) => kept[i]),
  };
}

function count(lines: readonly string[], pattern: RegExp): number {
  let total = 0;
  for (const line of lines) total += line.match(pattern)?.length ?? 0;
  return total;
}

const TEST_CASES = new RegExp(
  [
    // JavaScript and TypeScript: it(...), test(...), test.each(...)(...)
    String.raw`(?:^|[^.\w$])(?:it|test)(?:\.(?:each|concurrent|only|skip|todo|failing)\b[^(]*)?\s*\(`,
    // Python
    String.raw`^\s*(?:async\s+)?def\s+test\w*\s*\(`,
    // Go
    String.raw`^func\s+Test\w*\s*\(`,
    // Rust
    String.raw`#\[(?:tokio::)?test\]`,
    // Java, Kotlin, C#
    String.raw`@(?:Test|ParameterizedTest)\b`,
    String.raw`\[(?:Fact|Theory|Test|TestMethod|TestCase)\b`,
  ].join("|"),
  "g",
);
/** Tests named on their own line: Python and Go functions, JavaScript and TypeScript titles. */
const NAMED_TESTS = [
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
  /^func\s+(Test\w*)\s*\(/,
  /(?:^|[^.\w$])(?:it|test)(?:\.(?:concurrent|only|skip|todo|failing))?\s*\(\s*(["'`])((?:(?!\1)[^\\\n])+)\1/,
];
/** Rust, Java, Kotlin and C# mark a test with an attribute above the function that names it. */
const TEST_ATTRIBUTE =
  /#\[(?:tokio::)?test\]|@(?:Test|ParameterizedTest)\b|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b/;
const ATTRIBUTED_TEST = /\b(?:fn|fun|void|Task)\s+(`[^`]+`|\w+)\s*[(<]/;
/** Lines below an attribute that may hold more attributes before the function. */
const ATTRIBUTE_LINES = 8;

interface TestSpan {
  name: string;
  /** The test's lines without its title: the rest of the line that names it and the lines below. */
  body: string[];
}

/** Each test of a file with its lines, up to the next test or the end of the file. */
function testSpans(lines: readonly string[], marks: readonly string[] = lines): TestSpan[] {
  const starts: { name: string; from: number; index: number; rest: string }[] = [];
  for (const [index, line] of lines.entries()) {
    // Tests are found on the marks, where string content other than titles is blank; the text
    // at the same columns of the line is the same outside strings.
    const mark = marks[index] ?? line;
    const named = NAMED_TESTS.map((pattern) => mark.match(pattern)).find(Boolean);
    const name = named?.[2] ?? named?.[1];
    if (named && name) {
      starts.push({
        name,
        from: index,
        index,
        rest: line.slice((named.index ?? 0) + named[0].length),
      });
      continue;
    }
    const attribute = mark.match(TEST_ATTRIBUTE);
    if (!attribute) continue;
    const from = (attribute.index ?? 0) + attribute[0].length;
    const following = (all: readonly string[]) => all.slice(index + 1, index + 1 + ATTRIBUTE_LINES);
    const nextMarks = [mark.slice(from), ...following(marks)];
    for (const [offset, next] of [line.slice(from), ...following(lines)].entries()) {
      const attributed = (nextMarks[offset] ?? next).match(ATTRIBUTED_TEST);
      if (attributed?.[1]) {
        const at = index + offset;
        starts.push({
          name: attributed[1],
          from: index,
          index: at,
          rest: next.slice((attributed.index ?? 0) + attributed[0].length),
        });
        break;
      }
      if (offset > 0 && TEST_ATTRIBUTE.test(nextMarks[offset] ?? next)) break;
    }
  }
  return starts.map((start, i) => ({
    name: start.name,
    body: [start.rest, ...lines.slice(start.index + 1, starts[i + 1]?.from ?? lines.length)]
      .map((line) => line.trim().replace(/\s+/g, " "))
      .filter((line) => !TRIVIAL_LINE.test(line)),
  }));
}
/** Lines that only close or open a block: they say nothing about what a test checks. */
const TRIVIAL_LINE = /^(?:[{}()[\];,:]|=>|async|function|\s)*$/;

/** The names of a file's tests, with how often each occurs (classes and suites may repeat one). */
function testNames(lines: readonly string[], marks?: readonly string[]): Map<string, number> {
  const names = new Map<string, number>();
  for (const { name } of testSpans(lines, marks)) names.set(name, (names.get(name) ?? 0) + 1);
  return names;
}

/** Names in `before` that `after` holds fewer times. */
function missingNames(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...before].filter(([name, n]) => (after.get(name) ?? 0) < n).map(([name]) => name);
}

/** Share of a removed test's lines that a new test must keep to be the same test retitled. */
const SAME_BODY = 0.6;

interface TestMatch {
  /** Removed names and the new name each test now has: a retitle, or several tests merged. */
  renames: Map<string, string>;
  /** Tests and assertions fewer because matched tests were merged into fewer ones. */
  tests: number;
  assertions: number;
}

/**
 * Pairs each test that is gone by name with a new test that keeps it (#1532): one that holds at
 * least 60 percent of its lines, or every expected literal it compared against, as when two cases
 * become rows of one table test. url-shortener ae4b9d3d (bench round 44) retitled a test with the
 * same assertions, the guard reported it removed, and the corrective renamed it back, which
 * removed the new title: two repair rounds and 2.4M tokens.
 */
function matchTests(
  before: { lines: string[]; marks: string[] },
  after: { lines: string[]; marks: string[] },
): TestMatch {
  const was = testSpans(before.lines, before.marks);
  const now = testSpans(after.lines, after.marks);
  const namesBefore = testNames(before.lines, before.marks);
  const namesAfter = testNames(after.lines, after.marks);
  const added = new Set(missingNames(namesAfter, namesBefore));
  const targets = now.filter((span) => added.has(span.name));
  const renames = new Map<string, string>();
  let tests = 0;
  let assertions = 0;
  const used = new Set<TestSpan>();
  for (const name of missingNames(namesBefore, namesAfter)) {
    const old = was.find((span) => span.name === name);
    if (!old) continue;
    const literals = literalsOf(old.body);
    const target = targets.find((span) => {
      const lines = [...span.body];
      let kept = 0;
      for (const line of old.body) {
        const at = lines.indexOf(line);
        if (at < 0) continue;
        kept++;
        lines.splice(at, 1);
      }
      if (old.body.length && kept / old.body.length >= SAME_BODY) return true;
      const theirs = literalsOf(span.body);
      return literals.size > 0 && [...literals].every((value) => theirs.has(value));
    });
    if (!target) continue;
    renames.set(name, target.name);
    tests++;
    assertions += count(old.body, ASSERTIONS);
    used.add(target);
  }
  for (const target of used) {
    tests--;
    assertions -= count(target.body, ASSERTIONS);
  }
  return { renames, tests: Math.max(0, tests), assertions: Math.max(0, assertions) };
}

/**
 * What a change does to a test file's tests by name (#1519, #1532): the tests it adds, and the
 * tests it retitles or merges with their new names. Null when the file is not a test file or its
 * earlier content was not kept.
 */
export function testChanges(
  change: FileChange,
): { added: string[]; renamed: Record<string, string> } | null {
  if (!isTestPath(change.path) || change.before === undefined || change.after === null) return null;
  const before = codeView(change.path, change.before ?? "");
  const after = codeView(change.path, change.after);
  const { renames } = matchTests(before, after);
  const targets = new Set(renames.values());
  return {
    added: missingNames(
      testNames(after.lines, after.marks),
      testNames(before.lines, before.marks),
    ).filter((name) => !targets.has(name)),
    renamed: Object.fromEntries(renames),
  };
}

const quoted = (names: readonly string[]) =>
  names
    .slice(0, 5)
    .map((name) => JSON.stringify(name))
    .join(", ") + (names.length > 5 ? ` and ${String(names.length - 5)} more` : "");

const ASSERTIONS =
  /\bexpect\s*\(|\bassert\w*\b|\bAssert\.\w+|\bt\.(?:Error|Errorf|Fatal|Fatalf)\b|\brequire\.\w+\s*\(/g;
const SKIPS = new RegExp(
  [
    String.raw`\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\b`,
    String.raw`(?:^|[^.\w$])[xf](?:it|test|describe)\s*\(`,
    String.raw`@pytest\.mark\.(?:skip|skipif|xfail)\b`,
    String.raw`@unittest\.(?:skip|expectedFailure)\w*`,
    String.raw`\bpytest\.skip\s*\(`,
    String.raw`#\[ignore\b`,
    String.raw`\bt\.Skip(?:f|Now)?\s*\(`,
    String.raw`@(?:Disabled|Ignore)\b`,
    String.raw`\[Ignore\b`,
    String.raw`\bSkip\s*=\s*"`,
  ].join("|"),
  "g",
);
/**
 * What a capability guard checks before it skips: the platform, or a call that needs a privilege,
 * a tool or a module the machine may lack (symbolic links on unprivileged Windows, a missing
 * binary, an optional import).
 */
const CAPABILITY = new RegExp(
  [
    String.raw`\bruntime\.GOOS\b`,
    String.raw`\bsys\.platform\b`,
    String.raw`\bos\.name\b`,
    String.raw`\bplatform\.system\s*\(`,
    String.raw`\bprocess\.platform\b`,
    String.raw`\b(?:RuntimeInformation\.IsOSPlatform|OperatingSystem\.Is\w+)\s*\(`,
    String.raw`\b(?:os\.)?[Ss]ymlink(?:Sync)?\s*\(`,
    String.raw`\bos\.[Ll]ink\s*\(`,
    String.raw`\b(?:exec\.LookPath|shutil\.which)\s*\(`,
    String.raw`\b(?:ImportError|ModuleNotFoundError|PermissionError)\b`,
    String.raw`\b(?:ErrPermission|EPERM|EACCES)\b`,
    String.raw`\b(?:os\.)?[Gg]ete?uid\s*\(`,
  ].join("|"),
);
/** Lines above a skip that its guard condition may span. */
const GUARD_LINES = 3;

/**
 * New skips that are not capability guards (#1284): a skip taken only when the platform or the
 * machine cannot do what the test needs keeps the test running where it can, so it is not a
 * skipped failing test. A guard names the capability on the skip's line or in the lines above.
 */
function unguardedSkips(lines: readonly string[]): number {
  let total = 0;
  lines.forEach((line, index) => {
    const skips = line.match(SKIPS)?.length ?? 0;
    if (!skips) return;
    const guard = lines.slice(Math.max(0, index - GUARD_LINES), index + 1).join("\n");
    if (!CAPABILITY.test(guard)) total += skips;
  });
  return total;
}

const SUPPRESSIONS = new RegExp(
  [
    String.raw`@ts-(?:ignore|nocheck|expect-error)\b`,
    String.raw`\beslint-disable`,
    String.raw`\bbiome-ignore\b`,
    String.raw`#\s*type:\s*ignore\b`,
    String.raw`#\s*noqa\b`,
    String.raw`#\s*pragma:\s*no cover\b`,
    String.raw`#!?\[allow\(`,
    String.raw`@SuppressWarnings\b`,
    String.raw`//\s*nolint\b`,
    String.raw`#pragma\s+warning\s+disable\b`,
  ].join("|"),
  "g",
);
const ANY_TYPE = /\bas\s+any\b|:\s*any\b|<any>/g;
const TEST_HOOKS = new RegExp(
  [
    String.raw`NODE_ENV\s*[!=]==?\s*["'\`]test["'\`]`,
    String.raw`["'\`]test["'\`]\s*[!=]==?\s*process\.env\.NODE_ENV`,
    String.raw`process\.env\.(?:VITEST|JEST_WORKER_ID|BUN_TEST)\b`,
    String.raw`["']pytest["']\s+in\s+sys\.modules`,
    String.raw`\bPYTEST_CURRENT_TEST\b`,
    String.raw`\btesting\.Testing\(\)`,
  ].join("|"),
  "g",
);
const BYPASS = /--no-verify\b|--pass-?with-?no-?tests\b/gi;
// Any length, so that consecutive strings pair their quotes correctly; short ones are dropped.
const LITERAL = /(["'`])((?:(?!\1)[^\\\n]){0,200})\1/g;
const COMPARED = [
  /(?:===?|!==?)\s*(["'`])((?:(?!\1)[^\\\n]){6,200})\1/g,
  /(["'`])((?:(?!\1)[^\\\n]){6,200})\1\s*(?:===?|!==?)/g,
  /\bcase\s+(["'`])((?:(?!\1)[^\\\n]){6,200})\1/g,
];
const TS_FILE = /\.[cm]?tsx?$/i;
const DOC_FILE = /\.(md|mdx|rst|txt|adoc)$/i;

/** String literals, including multi-line raw and triple-quoted ones (Go, Python, JS templates). */
const STRING_TEXT =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

/** The string literals of some lines: the expected values a test compares against. */
function literalsOf(lines: readonly string[]): Set<string> {
  return new Set([...lines.join("\n").matchAll(STRING_TEXT)].map((match) => match[0]));
}

/** How much literal text a file holds: the expected values its assertions compare against. */
function literalText(lines: readonly string[]): number {
  let total = 0;
  for (const match of lines.join("\n").matchAll(STRING_TEXT)) total += match[0].length;
  return total;
}

function literals(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(LITERAL))
    if (match[2] && match[2].length >= 6) found.add(match[2]);
  return found;
}

function compared(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines)
    for (const pattern of COMPARED)
      for (const match of line.matchAll(pattern)) {
        const value = match[2];
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
  return counts;
}

/** A literal that looks like test data rather than a keyword, a command or an identifier. */
const inputLike = (value: string): boolean => !/^[\w.:/-]+$/.test(value);

export interface ScanOptions {
  /** Paths whose writes the approved plan gave a reason: fewer tests or assertions are planned. */
  reasoned?: ReadonlySet<string>;
  /**
   * Test files a correction's own finding asks to rewrite (#1069): fewer assertions are accepted
   * while every test case stays and the file still asserts; fewer test cases are not.
   */
  rewrites?: ReadonlySet<string>;
  /**
   * Test files a correction's own finding says check too little (#1481): fewer assertions are
   * accepted while every test case stays, the file still asserts and it holds more expected
   * literal text, as when three `toContain` checks become one comparison with the full output.
   */
  strengthens?: ReadonlySet<string>;
  /**
   * Tests that a correction of another finding added, by path and name, with who added them
   * (#1519): a change that leaves one out is reported whatever its own finding asks, since two
   * findings that need opposite tests are a conflict to report, not one to settle by editing.
   */
  protects?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Contents of test files the task can see, for literals that special-case test inputs. */
  testSources?: readonly string[];
  /** Request, spec and plan text: a literal they name is a requirement, not a test input. */
  specText?: string;
}

/**
 * What a task's changes do to the tests: deleted test files, fewer tests or assertions, new
 * skips and focuses, new suppressions, branches on test inputs or on running under a test runner,
 * and verification bypasses. Each rule compares counts before and after, so code that was already
 * there is never reported.
 */
export function scanTestIntegrity(
  changes: readonly FileChange[],
  options: ScanOptions = {},
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const testLiterals = new Set<string>();
  for (const source of [
    ...(options.testSources ?? []),
    ...changes.flatMap((c) => (isTestPath(c.path) && c.after !== null ? [c.after] : [])),
    ...changes.flatMap((c) =>
      isTestPath(c.path) && typeof c.before === "string" ? [c.before] : [],
    ),
  ])
    for (const value of literals(source)) testLiterals.add(value);
  const spec = options.specText ?? "";
  for (const change of changes) {
    const { path } = change;
    const reasoned = options.reasoned?.has(path) === true;
    if (change.before === undefined) {
      if (isTestPath(path) && change.after === null && !reasoned)
        findings.push({ rule: "test-deleted", path, detail: "deleted the test file" });
      continue;
    }
    const beforeRaw = change.before ?? "";
    const afterRaw = change.after ?? "";
    const viewBefore = codeView(path, beforeRaw);
    const viewAfter = codeView(path, afterRaw);
    const before = viewBefore.lines;
    const after = viewAfter.lines;
    // The counters read the files with string content blanked: test data such as
    // "custom_value: any text" or "# noqa" is not code or a comment (#1549). Test titles, literal
    // comparisons and verification bypasses (a command in a string runs) read the strings.
    const blankBefore = blankStringLiterals(path, beforeRaw);
    const blankAfter = blankStringLiterals(path, afterRaw);
    const codeBefore = codeLines(blankBefore);
    const codeAfter = codeLines(blankAfter);
    const grew = (pattern: RegExp, lines: [string[], string[]] = [codeBefore, codeAfter]) =>
      count(lines[1], pattern) - count(lines[0], pattern);
    if (isTestPath(path)) {
      const testsBefore = count(codeBefore, TEST_CASES);
      if (change.after === null) {
        if (change.before !== null && !reasoned)
          findings.push({
            rule: "test-deleted",
            path,
            detail: `deleted the test file${testsBefore ? ` with ${String(testsBefore)} test(s)` : ""}`,
          });
        continue;
      }
      const testsAfter = count(codeAfter, TEST_CASES);
      const namesAfter = testNames(after, viewAfter.marks);
      // A test retitled or merged with its body kept is not removed (#1532).
      const matched = matchTests(viewBefore, viewAfter);
      const removed = missingNames(testNames(before, viewBefore.marks), namesAfter).filter(
        (name) => !matched.renames.has(name),
      );
      const guarded = options.protects?.get(path);
      const lost = [...(guarded ?? [])].filter(([name]) => {
        const renamed = matched.renames.get(name);
        return !namesAfter.has(name) && !(renamed && namesAfter.has(renamed));
      });
      const keep = guarded
        ? [...guarded.keys()].map((name) => matched.renames.get(name) ?? name)
        : [];
      for (const [name, origin] of lost)
        findings.push({
          rule: "test-removed",
          path,
          detail: `${removed.includes(name) ? "removed" : "left out"} test ${JSON.stringify(name)}, which ${origin} added`,
          keep: [...new Set(keep)],
        });
      const unclaimed = removed.filter((name) => !lost.some(([lostName]) => lostName === name));
      if (!reasoned && testsBefore - testsAfter > matched.tests)
        findings.push({
          rule: "test-count",
          path,
          detail: `test count dropped from ${String(testsBefore)} to ${String(testsAfter)}${unclaimed.length ? ` (removed ${quoted(unclaimed)})` : ""}`,
        });
      else if (
        !reasoned &&
        options.rewrites?.has(path) !== true &&
        options.strengthens?.has(path) !== true &&
        unclaimed.length
      )
        // Equal totals hide a swap: a strong test replaced by a weaker one under another name.
        findings.push({
          rule: "test-removed",
          path,
          detail: `removed test(s) ${quoted(unclaimed)} while the test count stayed ${String(testsAfter)}`,
        });
      const assertsBefore = count(codeBefore, ASSERTIONS);
      const assertsAfter = count(codeAfter, ASSERTIONS);
      const kept = testsAfter + matched.tests >= testsBefore && assertsAfter > 0;
      const rewritten =
        kept &&
        (options.rewrites?.has(path) === true ||
          (options.strengthens?.has(path) === true && literalText(after) > literalText(before)));
      if (!reasoned && !rewritten && assertsBefore - assertsAfter > matched.assertions)
        findings.push({
          rule: "assertions",
          path,
          detail: `assertions dropped from ${String(assertsBefore)} to ${String(assertsAfter)} (removed or commented out)`,
        });
      const skips = unguardedSkips(codeAfter) - unguardedSkips(codeBefore);
      if (skips > 0)
        findings.push({
          rule: "skip",
          path,
          detail: `added ${String(skips)} skip, only, todo or ignore marker(s)`,
        });
    } else if (change.after !== null) {
      const hooks = grew(TEST_HOOKS);
      if (hooks > 0)
        findings.push({
          rule: "test-hook",
          path,
          detail: `added ${String(hooks)} branch(es) on running under a test runner`,
        });
      const beforeCompared = compared(before);
      const special = [...compared(after)].filter(
        ([value, n]) =>
          n > (beforeCompared.get(value) ?? 0) &&
          testLiterals.has(value) &&
          inputLike(value) &&
          !spec.includes(value),
      );
      if (special.length)
        findings.push({
          rule: "literal-branch",
          path,
          detail: `compares with test input literal(s) ${special
            .slice(0, 3)
            .map(([value]) => JSON.stringify(value))
            .join(", ")} that the request, spec and plan do not name`,
        });
    }
    if (change.after === null || DOC_FILE.test(path)) continue;
    // Suppressions live in comments (or attributes), so they are counted on every line that is
    // not string content.
    const suppressions =
      grew(SUPPRESSIONS, [blankBefore.split(/\r?\n/), blankAfter.split(/\r?\n/)]) +
      (TS_FILE.test(path) ? grew(ANY_TYPE) : 0);
    if (suppressions > 0)
      findings.push({
        rule: "suppression",
        path,
        detail: `added ${String(suppressions)} type or lint suppression(s) (ts-ignore, eslint-disable, any, type: ignore, allow and similar)`,
      });
    const bypass = grew(BYPASS, [beforeRaw.split(/\r?\n/), afterRaw.split(/\r?\n/)]);
    if (bypass > 0)
      findings.push({
        rule: "verification-bypass",
        path,
        detail: "added --no-verify or --passWithNoTests",
      });
  }
  return findings;
}

/** The instruction a repair gets for an integrity finding. */
export function integrityFix(finding: IntegrityFinding): string {
  switch (finding.rule) {
    case "test-removed":
      return `Restore the removed tests in ${finding.path} with their assertions, under their names or with the same body under a new title, and make the code pass them.${finding.keep?.length ? ` Keep every one of these tests, which corrections of other findings added: ${finding.keep.map((name) => JSON.stringify(name)).join(", ")}.` : ""} If the finding you correct and the one a restored test was added for cannot both hold, report outcome spec_conflict naming both findings instead of removing the test.`;
    case "test-deleted":
    case "test-count":
    case "assertions":
      return `Restore the removed tests and assertions in ${finding.path} and make the code pass them. If the spec and the tests cannot both hold, report outcome spec_conflict instead of changing the tests.`;
    case "skip":
      return `Remove the new skip, only or ignore markers from ${finding.path} and make the code pass the tests.`;
    case "suppression":
      return `Remove the new suppressions from ${finding.path} and fix the underlying type or lint errors. Only code and comments count: text inside a string literal, such as test data, is not a suppression.`;
    case "test-hook":
    case "literal-branch":
      return `Remove the special case for tests from ${finding.path}; implement the general behavior the spec requires.`;
    case "verification-bypass":
      return `Remove --no-verify and --passWithNoTests from ${finding.path}.`;
  }
}

/**
 * Submission errors for a plan that changes or deletes pre-existing tests without saying why. The
 * implementer cannot change such a file, so the planner either gives the reason (the approval then
 * shows it to a person) or leaves the test alone.
 */
export function testWriteProblems(
  graph: { tasks: readonly Task[] },
  policy: Pick<RunPolicy, "testIntegrity">,
): string[] {
  if (testIntegrityOf(policy) !== "block") return [];
  return graph.tasks.flatMap((task) =>
    task.writes
      .filter((w) => w.action !== "create" && !w.reason && preexistingTest(w.path, graph.tasks))
      .map(
        (w) =>
          `Task ${task.id} would ${w.action} the existing test ${w.path} without a reason. Existing tests are read-only for implementers: remove the write, or add "reason" to it saying why the test must change (for example a behavior the request removes).`,
      ),
  );
}

/** A finding raised by a linter or a lint rule: "ruff BLE001", "eslint no-empty". */
const LINT_FINDING =
  /\b(?:lint(?:er|ing)?|ruff|eslint|biome|clippy|golangci(?:-lint)?|pylint|flake8|rubocop|ktlint|checkstyle)\b|\b(?:BLE|PLW|PLR|SIM|ARG|E|W|F|B)\d{3,4}\b/;

/**
 * A claim that a test checks less than its criterion states: it omits the expected output, only
 * counts or checks a prefix, or is too weak (fpbits front F1, #1481).
 */
const WEAK_TEST =
  /\b(?:omit(?:s|ted|ting)?|only (?:checks?|counts?|asserts?|compares?|verif(?:y|ies)|tests?)|(?:does not|doesn't|do not|don't|never) (?:check|assert|compare|verify)|too (?:weak|loose|lenient)|(?:weak|loose|lenient)(?:er)? (?:assertions?|checks?|tests?)|(?:complete|full|exact) (?:literal|expected)|prefix|substring)\b/i;

/**
 * The test files a correction may strengthen with fewer, stronger assertions (#1481): a test file
 * its finding names when the finding says the test checks too little (kind `partial` or
 * `missing`, or a claim in those words). fpbits front T012 replaced a separator count, a final-row
 * check and a prefix check with full expected outputs (24 assertions to 23); the guard flagged it
 * and corrective T013 spent 391k tokens adding an assertion back. The guard's own findings never
 * qualify.
 */
export function strengthenTargets(
  findings: readonly { kind: string; file: string | null; claim: string; suggestedFix: string }[],
): Set<string> {
  return new Set(
    findings
      .filter(
        (f) =>
          f.file !== null &&
          isTestPath(f.file) &&
          !f.claim.startsWith("Test integrity") &&
          (f.kind === "partial" ||
            f.kind === "missing" ||
            WEAK_TEST.test(`${f.claim}\n${f.suggestedFix}`)),
      )
      .map((f) => f.file as string),
  );
}

/**
 * The test files a correction may rewrite with fewer assertions (#1069): a test file its finding
 * names when the finding says the test contradicts a criterion (`contradicts`) or a lint rule
 * flags it. url-shortener ded6fba8 replaced a socket-opening server test the finding said broke
 * AC-005's port-free rule (35 assertions to 33), cfgtrace 424e275b rewrote three tests to drop
 * broad `except` handlers (ruff BLE001, 66 to 60); the guard blocked both and opened another
 * corrective (167k and 426k tokens). The guard's own findings never qualify.
 */
export function rewriteTargets(
  findings: readonly { kind: string; file: string | null; claim: string; suggestedFix: string }[],
): Set<string> {
  return new Set(
    findings
      .filter(
        (f) =>
          f.file !== null &&
          isTestPath(f.file) &&
          !f.claim.startsWith("Test integrity") &&
          (f.kind === "contradicts" || LINT_FINDING.test(`${f.claim}\n${f.suggestedFix}`)),
      )
      .map((f) => f.file as string),
  );
}
