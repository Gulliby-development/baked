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

/** Lines that are code, not comments: commented-out tests and assertions do not count. */
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return !(
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("<!--") ||
      // `#[test]` and `#![allow]` are Rust attributes, not comments.
      (trimmed.startsWith("#") && !/^#!?\[/.test(trimmed))
    );
  });
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
    const before = codeLines(beforeRaw);
    const after = codeLines(afterRaw);
    const grew = (pattern: RegExp, lines: [string[], string[]] = [before, after]) =>
      count(lines[1], pattern) - count(lines[0], pattern);
    if (isTestPath(path)) {
      const testsBefore = count(before, TEST_CASES);
      if (change.after === null) {
        if (change.before !== null && !reasoned)
          findings.push({
            rule: "test-deleted",
            path,
            detail: `deleted the test file${testsBefore ? ` with ${String(testsBefore)} test(s)` : ""}`,
          });
        continue;
      }
      const testsAfter = count(after, TEST_CASES);
      if (!reasoned && testsAfter < testsBefore)
        findings.push({
          rule: "test-count",
          path,
          detail: `test count dropped from ${String(testsBefore)} to ${String(testsAfter)}`,
        });
      const assertsBefore = count(before, ASSERTIONS);
      const assertsAfter = count(after, ASSERTIONS);
      const kept = testsAfter >= testsBefore && assertsAfter > 0;
      const rewritten =
        kept &&
        (options.rewrites?.has(path) === true ||
          (options.strengthens?.has(path) === true && literalText(after) > literalText(before)));
      if (!reasoned && !rewritten && assertsAfter < assertsBefore)
        findings.push({
          rule: "assertions",
          path,
          detail: `assertions dropped from ${String(assertsBefore)} to ${String(assertsAfter)} (removed or commented out)`,
        });
      const skips = unguardedSkips(after) - unguardedSkips(before);
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
    // Suppressions live in comments, so they are counted on every line.
    const rawBefore = beforeRaw.split(/\r?\n/);
    const rawAfter = afterRaw.split(/\r?\n/);
    const suppressions =
      grew(SUPPRESSIONS, [rawBefore, rawAfter]) +
      (TS_FILE.test(path) ? grew(ANY_TYPE, [before, after]) : 0);
    if (suppressions > 0)
      findings.push({
        rule: "suppression",
        path,
        detail: `added ${String(suppressions)} type or lint suppression(s) (ts-ignore, eslint-disable, any, type: ignore, allow and similar)`,
      });
    const bypass = grew(BYPASS, [rawBefore, rawAfter]);
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
    case "test-deleted":
    case "test-count":
    case "assertions":
      return `Restore the removed tests and assertions in ${finding.path} and make the code pass them. If the spec and the tests cannot both hold, report outcome spec_conflict instead of changing the tests.`;
    case "skip":
      return `Remove the new skip, only or ignore markers from ${finding.path} and make the code pass the tests.`;
    case "suppression":
      return `Remove the new suppressions from ${finding.path} and fix the underlying type or lint errors.`;
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
