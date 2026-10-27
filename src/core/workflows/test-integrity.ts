import { blankStringLiterals } from "../intelligence/comments.js";
import { isTestFile, isTestFileAt } from "../intelligence/language-traits.js";
import { hasShadowTitles, testConventions } from "../intelligence/test-frameworks.js";
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
 * Implementer tasks may change one only when the plan lists the write with a reason. The file's
 * content under `root` decides a name its language shares with domain code: a `PermTest.cs` stub
 * without a test attribute is source its implementer edits (#1848).
 */
export function preexistingTest(path: string, tasks: readonly Task[], root: string): boolean {
  return (
    isTestFileAt(root, path) &&
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
    // `#[test]` and `#![allow]` are Rust attributes, not comments; `#ifdef _WIN32` is the
    // preprocessor guard of a C or C++ skip (#1490), and Swift's `#if os(Linux)`, `#elseif` and
    // `#expect(...)` are code too (#1492).
    (trimmed.startsWith("#") &&
      !/^#!?\[|^#(?:if|ifdef|ifndef|elif|elseif)\b|^#(?:expect|require)\s*\(/.test(trimmed))
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

/** The function a test attribute marks (Rust, Java, Kotlin, C#), which names the test. */
const ATTRIBUTED_TEST = /\b(?:fn|fun|void|Task)\s+(`[^`]+`|\w+)\s*[(<]/;
/** Lines below an attribute that may hold more attributes before the function. */
const ATTRIBUTE_LINES = 8;

interface TestSpan {
  name: string;
  from: number;
  to: number;
  /** The test's lines without its title: the rest of the line that names it and the lines below. */
  body: string[];
}

/** Each test of a file with its lines, up to the next test or the end of the file. */
function testSpans(
  path: string,
  lines: readonly string[],
  marks: readonly string[] = lines,
  shadow = false,
): TestSpan[] {
  const { named: namedTests, attribute: testAttribute } = testConventions(path, shadow);
  const starts: { name: string; from: number; index: number; rest: string }[] = [];
  // The test function a subtest runs in: Go's `t.Run("empty", ...)` in `TestParse` is `TestParse/empty`.
  let parent = "";
  for (const [index, line] of lines.entries()) {
    // Tests are found on the marks, where string content other than titles is blank; the text
    // at the same columns of the line is the same outside strings, so names are read from it.
    const mark = marks[index] ?? line;
    const found = namedTests
      .map((test) => ({ test, match: test.pattern.exec(mark) }))
      .find(({ match }) => match?.indices?.groups?.name);
    const at = found?.match?.indices?.groups?.name;
    if (found?.match && at) {
      const own = line.slice(at[0], at[1]);
      if (!found.test.sub) parent = own;
      starts.push({
        name: found.test.sub && parent ? `${parent}/${own}` : own,
        from: index,
        index,
        rest: line.slice(found.match.index + found.match[0].length),
      });
      continue;
    }
    const attribute = mark.match(testAttribute);
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
      if (offset > 0 && testAttribute.test(nextMarks[offset] ?? next)) break;
    }
  }
  return starts.map((start, i) => ({
    name: start.name,
    from: start.from,
    to: starts[i + 1]?.from ?? lines.length,
    body: [start.rest, ...lines.slice(start.index + 1, starts[i + 1]?.from ?? lines.length)]
      .map((line) => line.trim().replace(/\s+/g, " "))
      .filter((line) => !TRIVIAL_LINE.test(line)),
  }));
}
/** Lines that only close or open a block: they say nothing about what a test checks. */
const TRIVIAL_LINE = /^(?:[{}()[\];,:]|=>|async|function|\s)*$/;

/** The names of a file's tests, with how often each occurs (classes and suites may repeat one). */
function testNames(
  path: string,
  lines: readonly string[],
  marks?: readonly string[],
  shadow = false,
): Map<string, number> {
  const names = new Map<string, number>();
  for (const { name } of testSpans(path, lines, marks, shadow))
    names.set(name, (names.get(name) ?? 0) + 1);
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
  path: string,
  before: { lines: string[]; marks: string[] },
  after: { lines: string[]; marks: string[] },
  shadow = false,
): TestMatch {
  const was = testSpans(path, before.lines, before.marks, shadow);
  const now = testSpans(path, after.lines, after.marks, shadow);
  const namesBefore = testNames(path, before.lines, before.marks, shadow);
  const namesAfter = testNames(path, after.lines, after.marks, shadow);
  const { assertions: assertionForms } = testConventions(path, shadow);
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
    assertions += count(old.body, assertionForms);
    used.add(target);
  }
  for (const target of used) {
    tests--;
    assertions -= count(target.body, assertionForms);
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
  const { renames } = matchTests(change.path, before, after);
  const targets = new Set(renames.values());
  return {
    added: missingNames(
      testNames(change.path, after.lines, after.marks),
      testNames(change.path, before.lines, before.marks),
    ).filter((name) => !targets.has(name)),
    renamed: Object.fromEntries(renames),
  };
}

const quoted = (names: readonly string[]) =>
  names
    .slice(0, 5)
    .map((name) => JSON.stringify(name))
    .join(", ") + (names.length > 5 ? ` and ${String(names.length - 5)} more` : "");

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
    // PHPUnit and Pest (#1491).
    String.raw`->markTest(?:Skipped|Incomplete)\s*\(`,
    String.raw`->(?:skip|todo)\s*\(`,
    // pgTAP: `SELECT skip('needs pg 16', 2)`, `SELECT todo_start('...')` (#1499).
    String.raw`\b(?:SELECT|select)\s+(?:skip|todo_start)\s*\(`,
    // Pester: `It 'adds' -Skip { }`, `Describe 'x' -Skip:$true`, `Set-ItResult -Skipped` (#1498).
    String.raw`^\s*(?:It|Describe|Context)\b[^{\n]*\s-Skip\b`,
    String.raw`\bSet-ItResult\s+-(?:Skipped|Pending|Inconclusive)\b`,
    // testthat: `skip("later")`, `skip_if(...)`, `skip_on_cran()` and the rest of the family (#1500).
    String.raw`(?:^|[^.\w])skip(?:_if(?:_not)?|_on_\w+|_if_offline|_if_not_installed)?\s*\(`,
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
    String.raw`\bPHP_OS(?:_FAMILY)?\b`,
    String.raw`\b(?:extension_loaded|function_exists)\s*\(`,
    // Ruby: `RUBY_PLATFORM`, `Gem.win_platform?`, `RbConfig::CONFIG["host_os"]`, a gem that may be missing.
    String.raw`\bRUBY_PLATFORM\b|\bGem\.win_platform\?|\bRbConfig::CONFIG\b|\bLoadError\b`,
    // Lua: the path separator `package.config:sub(1, 1)`, LuaJIT's `jit.os`, an optional module.
    String.raw`\bpackage\.config\b|\bjit\.os\b|\bpcall\s*\(\s*require\b`,
    // Shell: `uname`, `$OSTYPE`, a tool that may be missing (`command -v jq`, `type -P`, `hash`).
    String.raw`\buname\b|\$\{?OSTYPE\b|\bcommand\s+-v\b|\btype\s+-P\b|^\s*hash\s+\w`,
    // C and C++: the platform macros of a preprocessor guard (#1490).
    String.raw`\b(?:_WIN32|_WIN64|_MSC_VER|__APPLE__|__linux__|__unix__|__FreeBSD__|__MINGW32__)\b`,
    // Dart: `Platform.isWindows`, `Platform.operatingSystem`, Flutter's `kIsWeb` (#1494).
    String.raw`\bPlatform\.(?:is[A-Z]\w*|operatingSystem)\b|\bkIsWeb\b`,
    // Scala: `scala.util.Properties.isWin` (#1496).
    String.raw`\bProperties\.(?:isWin|isMac|isLinux)\b`,
    // Swift: `#if os(Linux)`, `#if canImport(Darwin)`, `.enabled(if:` with a platform (#1492).
    String.raw`#if\s+!?(?:os|canImport)\s*\(|\bProcessInfo\.processInfo\.(?:operatingSystem\w*|isOperatingSystemAtLeast)\b`,
    // testthat's guards that name the platform or a missing capability, and R's platform checks.
    String.raw`\bskip_(?:on_os|on_cran|on_ci|if_offline|if_not_installed)\s*\(`,
    String.raw`\.Platform\$OS\.type\b|\bSys\.info\s*\(\s*\)\s*\[`,
  ].join("|"),
);
/** Lines above a skip that its guard condition may span. */
const GUARD_LINES = 3;

/**
 * New skips that are not capability guards (#1284): a skip taken only when the platform or the
 * machine cannot do what the test needs keeps the test running where it can, so it is not a
 * skipped failing test. A guard names the capability on the skip's line or in the lines above.
 */
function unguardedSkips(path: string, lines: readonly string[], shadow = false): number {
  // The markers a framework of the file's language spells its own way (RSpec `xit "..."`,
  // Minitest `skip`, #1493), next to the ones read in every file.
  const own = testConventions(path, shadow).skips;
  let total = 0;
  lines.forEach((line, index) => {
    const skips = (line.match(SKIPS)?.length ?? 0) + (line.match(own)?.length ?? 0);
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
    // SQLFluff (#1499).
    String.raw`--\s*noqa\b`,
    String.raw`#\s*pragma:\s*no cover\b`,
    String.raw`#!?\[allow\(`,
    String.raw`@SuppressWarnings\b`,
    String.raw`//\s*nolint\b`,
    // lintr: `# nolint`, `# nolint: object_name_linter.`, `# nolint start` (#1500).
    String.raw`#\s*nolint\b`,
    String.raw`#pragma\s+warning\s+disable\b`,
    String.raw`@phpstan-ignore`,
    String.raw`@psalm-suppress\b`,
    String.raw`@codeCoverageIgnore`,
    String.raw`#\s*(?:rubocop|standard):(?:disable|todo)\b`,
    // luacheck and selene (#1495).
    String.raw`--\s*luacheck:\s*(?:ignore|no\s|push\s+ignore)`,
    String.raw`--\s*selene:\s*allow\b`,
    // ShellCheck (#1497).
    String.raw`#\s*shellcheck\s+disable=`,
    // clang-tidy, and GCC's and Clang's diagnostic pragmas (#1490).
    String.raw`//\s*NOLINT(?:NEXTLINE|BEGIN)?\b`,
    String.raw`#\s*pragma\s+(?:GCC|clang)\s+diagnostic\s+ignored\b`,
    String.raw`//\s*ignore(?:_for_file)?:\s*\w`,
    String.raw`@nowarn\b|//\s*scalafix:(?:off|ok)\b|//\s*scalastyle:off\b`,
    String.raw`//\s*swiftlint:disable\b|//\s*swift-format-ignore\b`,
    // PSScriptAnalyzer, and the same attribute in C#: `[Diagnostics.CodeAnalysis.SuppressMessageAttribute(...)]` (#1498).
    String.raw`\[(?:System\.)?(?:Diagnostics\.CodeAnalysis\.)?SuppressMessage(?:Attribute)?\s*\(`,
  ].join("|"),
  "g",
);
/** Words before a quoted suppression that forbid it rather than prescribe it. */
const FORBIDS = /\b(?:not|never|no|without|avoid|forbid\w*|instead of|rather than)\b[^.;]{0,40}$/i;
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether the request, spec or plan prescribes a suppression (#2270): the text from the
 * suppression to the end of its line, or the whole line, occurs verbatim (whitespace collapsed)
 * in `text`, not after a word that forbids it. A bare marker (`# noqa`, a bare `eslint-disable`) is never
 * prescribed: a request that names one usually forbids it, and only one with its arguments
 * (`#[allow(unused_variables)]`, `# noqa: E501`) names a specific suppression.
 */
export function prescribedSuppression(
  line: string,
  index: number,
  marker: string,
  text: string,
): boolean {
  const own = collapse(line.slice(index));
  if (own.length <= marker.trim().length + 2) return false;
  const prescribed = collapse(text);
  // The whole line decides where it occurs, so a word before its code forbids it too.
  const whole = collapse(line);
  const candidate = prescribed.includes(whole) ? whole : own;
  for (let at = prescribed.indexOf(candidate); at >= 0; at = prescribed.indexOf(candidate, at + 1))
    if (!FORBIDS.test(prescribed.slice(Math.max(0, at - 60), at))) return true;
  return false;
}

/**
 * The suppressions on `lines` (string content blanked) that `text` does not prescribe, read
 * against the same line of `raw`, so `@SuppressWarnings("unchecked")` keeps its argument.
 */
function unprescribedSuppressions(
  lines: readonly string[],
  raw: readonly string[],
  text: string,
): number {
  let total = 0;
  lines.forEach((line, index) => {
    const source = raw.length === lines.length ? (raw[index] ?? line) : line;
    for (const match of line.matchAll(SUPPRESSIONS))
      if (!text || !prescribedSuppression(source, match.index ?? 0, match[0], text)) total++;
  });
  return total;
}
const ANY_TYPE = /\bas\s+any\b|:\s*any\b|<any>/g;
const TEST_HOOKS = new RegExp(
  [
    String.raw`NODE_ENV\s*[!=]==?\s*["'\`]test["'\`]`,
    String.raw`["'\`]test["'\`]\s*[!=]==?\s*process\.env\.NODE_ENV`,
    String.raw`process\.env\.(?:VITEST|JEST_WORKER_ID|BUN_TEST)\b`,
    String.raw`["']pytest["']\s+in\s+sys\.modules`,
    String.raw`\bPYTEST_CURRENT_TEST\b`,
    String.raw`\btesting\.Testing\(\)`,
    String.raw`\bRails\.env\.test\?`,
    String.raw`\bENV\[\s*["'](?:RAILS_ENV|RACK_ENV|APP_ENV)["']\s*\]\s*[!=]=\s*["']test["']`,
    String.raw`\bdefined\?\(\s*(?:RSpec|Minitest)\b`,
    // flutter test sets FLUTTER_TEST: `Platform.environment.containsKey('FLUTTER_TEST')` (#1494).
    String.raw`\bFLUTTER_TEST\b`,
    // XCTest sets XCTestConfigurationFilePath on macOS (#1492).
    String.raw`\bXCTestConfigurationFilePath\b|NSClassFromString\(\s*"XCTestCase"\s*\)`,
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
  /** A corrective's spec findings that explicitly request removal or relocation of tests. */
  removalFindings?: readonly TestRemovalFinding[];
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
   * (#1519): a change that leaves one out is reported unless a spec finding explicitly requests
   * its removal. Other conflicts still need a spec_conflict report.
   */
  protects?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Contents of test files the task can see, for literals that special-case test inputs. */
  testSources?: readonly string[];
  /**
   * Request (with a person's accepted answers), spec and plan text: a literal they name is a
   * requirement, not a test input, and a suppression they name verbatim is prescribed, not added
   * (#2270).
   */
  specText?: string;
  /**
   * Files whose suppression finding a person settled in a spec conflict (#2270): their
   * suppressions are not counted again at a later scan.
   */
  settledSuppressions?: ReadonlySet<string>;
  /** Also read the framework rows measured in shadow (`testConventions(path, true)`, #2147). */
  shadowTitles?: boolean;
}

export interface TestRemovalFinding {
  /** The finding's id, recorded with the tests it lets a correction replace (#2139). */
  id?: string;
  basis?: string;
  file: string | null;
  claim: string;
  suggestedFix: string;
}

const REMOVE_TEST = /\b(?:remove|delete|drop|move|relocate)\b/i;
const KEEP_TEST = /\b(?:not|never|don't|without)\s+(?:remove|delete|drop|move|relocate)\b/i;
const TEST_REMOVAL_OBJECT =
  /^(?:(?:all|the|these|those|three|\d+|existing|misplaced|redundant|out-of-scope)\s+)*(?:tests?\b|them\b)/i;
const REMOVE_FILE_TESTS =
  /\b(?:remove|delete|drop|move|relocate)\s+(?:(?:all|the|these|those|existing|misplaced|out-of-scope)\s+)*(?:tests?(?=\s+(?:from|in|of|to|into|out of)\b|[.!;]?\s*$)|(?:test\s+)?file\b)/i;
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Spec authority applies only to tests named literally or by an identifier glob (#1628). */
export function requestedTestRemovals(
  path: string,
  names: Iterable<string>,
  findings: readonly TestRemovalFinding[],
): { names: Set<string>; file: boolean } {
  const requested = new Set<string>();
  let file = false;
  const candidates = [...names];
  for (const finding of findings) {
    const action = REMOVE_TEST.exec(finding.suggestedFix);
    if (
      finding.basis !== "spec" ||
      finding.file !== path ||
      finding.claim.startsWith("Test integrity") ||
      !action ||
      KEEP_TEST.test(finding.suggestedFix)
    )
      continue;
    const text = `${finding.claim}\n${finding.suggestedFix}`;
    const object = finding.suggestedFix.slice(action.index + action[0].length).trim();
    const globs = [...text.matchAll(/\b[\w]+[\w*?]*[*?][\w*?]*/g)].map(([glob]) => ({
      token: glob,
      pattern: new RegExp(
        `^${glob
          .split(/([*?])/)
          .map((part) => (part === "*" ? ".*" : part === "?" ? "." : escapePattern(part)))
          .join("")}$`,
      ),
    }));
    const matched = candidates.filter((name) => {
      const literal = new RegExp(`(?<![\\w])${escapePattern(name)}(?![\\w])`);
      const named = literal.test(text) || globs.some((glob) => glob.pattern.test(name));
      return (
        named &&
        (TEST_REMOVAL_OBJECT.test(object) ||
          literal.test(object) ||
          globs.some((glob) => glob.pattern.test(name) && object.includes(glob.token)))
      );
    });
    for (const name of matched) requested.add(name);
    // A file-wide instruction must say so. An unnamed scope claim grants no exception.
    if (!matched.length && REMOVE_FILE_TESTS.test(finding.suggestedFix)) file = true;
  }
  if (file) for (const name of candidates) requested.add(name);
  return { names: requested, file };
}

/**
 * What the decision knows of one changed file: counts and flags, no text, so a bench trace holds
 * no code or prose (#1715). `measureTestIntegrity` reads them from the contents and
 * `integrityDecision` turns them into findings; `replayIntegrity` in `trace.ts` decides recorded
 * measures again. `names` carries the test titles and literals the finding details quote; it is
 * never recorded, and a decision without it words its details from the counts.
 */
export type IntegrityMeasure = {
  path: string;
  /** The approved plan gave the write a reason, or an amendment covers the path. */
  reasoned: boolean;
  /** A spec finding asks for the whole file's tests to be removed. */
  requestedFile: boolean;
  names?: IntegrityNames;
} & (
  | {
      /** The file existed but its earlier content was not kept: only a deletion can be judged. */
      form: "unknown-before";
      test: boolean;
      deleted: boolean;
    }
  | {
      form: "test-deleted";
      /** The file existed before the task (null content means the task created it). */
      existed: boolean;
      /** Every test of the file is one a spec finding asks to remove. */
      allRequested: boolean;
      testsBefore: number;
    }
  | {
      form: "test";
      testsBefore: number;
      testsAfter: number;
      /** Tests retitled or merged with their body kept (#1532). */
      matchedTests: number;
      matchedAssertions: number;
      /** Cases and assertions of the tests a spec finding asks to remove or that replace (#2139). */
      removedTests: number;
      removedAssertions: number;
      /**
       * Tests replaced under a new title at the request of a spec finding naming them (#2139), and
       * those findings' ids. Counted in `removedTests`; absent from records before the rule.
       */
      replacedTests?: number;
      replacedBy?: string[];
      /** Tests a correction of another finding added that the change leaves out (#1519). */
      lost: number;
      /** Removed test titles not counted in `lost`. */
      unclaimed: number;
      rewrite: boolean;
      strengthen: boolean;
      /** The file holds more expected literal text than before (read only under `strengthen`). */
      literalGrew: boolean;
      assertsBefore: number;
      assertsAfter: number;
      skips: number;
      /** Not a documentation file: suppressions and bypasses are counted. */
      checked: boolean;
      suppressions: number;
      bypass: number;
    }
  | {
      form: "source";
      deleted: boolean;
      hooks: number;
      /** Test input literals the file newly compares with that the request, spec and plan do not name. */
      specialLiterals: number;
      checked: boolean;
      suppressions: number;
      bypass: number;
    }
);

export interface IntegrityNames {
  /** Each left-out test's title, who added it and whether the change removed it (or never kept it). */
  lost: [name: string, origin: string, removed: boolean][];
  keep: string[];
  unclaimed: string[];
  special: string[];
}

/**
 * A test title is named in a finding's claim when the claim quotes it, or, for a title that is no
 * plain word (it has a space, an underscore, a digit or an inner capital), when it holds it as a
 * whole word: "the test adds" does not name a test titled `adds`.
 */
function claimNames(claim: string, name: string): boolean {
  const title = escapePattern(name);
  if (new RegExp(`([\`"'])${title}\\1`).test(claim)) return true;
  return /[\s_\d]|[a-z][A-Z]/.test(name) && new RegExp(`(?<![\\w])${title}(?![\\w])`).test(claim);
}

/**
 * The removed tests a correction replaced at a spec finding's request, decided on the diff and
 * not on the finding's wording (#2139): a spec-basis finding on the file whose claim names the
 * test as its subject, and a test under a new title the same change added to the file in its
 * place. ewvet T003 replaced `ScannerRecognitionMatchesReaderForLiteralTokens`, which spec finding
 * F1 named as testing the wrong path, by a facade test; F1's fix said "add", the removal rule
 * (`requestedTestRemovals`) wants "remove" or "move", and three correctives restored one test or
 * the other (587k tokens). Each new title pays for one removed test, in the order of the file; a
 * fix that says not to remove tests grants nothing.
 */
export function replacedTests(
  path: string,
  removed: readonly string[],
  added: number,
  findings: readonly TestRemovalFinding[],
): { names: Set<string>; findingIds: string[] } {
  const names = new Set<string>();
  const findingIds = new Set<string>();
  const subjects = findings.filter(
    (f) =>
      f.basis === "spec" &&
      f.file === path &&
      !f.claim.startsWith("Test integrity") &&
      !KEEP_TEST.test(f.suggestedFix),
  );
  for (const name of removed) {
    if (names.size >= added) break;
    const by = subjects.filter((f) => claimNames(f.claim, name));
    if (!by.length) continue;
    names.add(name);
    for (const f of by) if (f.id) findingIds.add(f.id);
  }
  return { names, findingIds: [...findingIds] };
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
  return integrityDecision(measureTestIntegrity(changes, options));
}

/** The counts and flags of each changed file the integrity decision reads. */
export function measureTestIntegrity(
  changes: readonly FileChange[],
  options: ScanOptions = {},
): IntegrityMeasure[] {
  const measures: IntegrityMeasure[] = [];
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
  const shadow = options.shadowTitles === true;
  for (const change of changes) {
    const { path } = change;
    const reasoned = options.reasoned?.has(path) === true;
    const guarded = options.protects?.get(path);
    const spans =
      isTestPath(path) && typeof change.before === "string"
        ? (() => {
            const view = codeView(path, change.before);
            return testSpans(path, view.lines, view.marks, shadow);
          })()
        : [];
    const requested = requestedTestRemovals(
      path,
      [...spans.map((span) => span.name), ...(guarded?.keys() ?? [])],
      options.removalFindings ?? [],
    );
    const base = { path, reasoned, requestedFile: requested.file };
    if (change.before === undefined) {
      measures.push({
        ...base,
        form: "unknown-before",
        test: isTestPath(path),
        deleted: change.after === null,
      });
      continue;
    }
    const beforeRaw = change.before ?? "";
    const afterRaw = change.after ?? "";
    const { cases: testCases, assertions: assertionForms } = testConventions(path, shadow);
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
    // Suppressions live in comments (or attributes), so they are counted on every line that is
    // not string content.
    const checks = () => {
      const checked = change.after !== null && !DOC_FILE.test(path);
      return {
        checked,
        suppressions:
          checked && options.settledSuppressions?.has(path) !== true
            ? unprescribedSuppressions(blankAfter.split(/\r?\n/), afterRaw.split(/\r?\n/), spec) -
              unprescribedSuppressions(blankBefore.split(/\r?\n/), beforeRaw.split(/\r?\n/), spec) +
              (TS_FILE.test(path) ? grew(ANY_TYPE) : 0)
            : 0,
        bypass: checked ? grew(BYPASS, [beforeRaw.split(/\r?\n/), afterRaw.split(/\r?\n/)]) : 0,
      };
    };
    if (isTestPath(path)) {
      const testsBefore = count(codeBefore, testCases);
      if (change.after === null) {
        const allRequested =
          requested.file ||
          (spans.length > 0 &&
            spans.every((span) => requested.names.has(span.name)) &&
            spans.length === testsBefore);
        measures.push({
          ...base,
          form: "test-deleted",
          existed: change.before !== null,
          allRequested,
          testsBefore,
        });
        continue;
      }
      const testsAfter = count(codeAfter, testCases);
      const namesBefore = testNames(path, before, viewBefore.marks, shadow);
      const namesAfter = testNames(path, after, viewAfter.marks, shadow);
      // A test retitled or merged with its body kept is not removed (#1532).
      const matched = matchTests(path, viewBefore, viewAfter, shadow);
      const targets = new Set(matched.renames.values());
      const gone = missingNames(namesBefore, namesAfter).filter(
        (name) => !matched.renames.has(name) && !requested.names.has(name),
      );
      // A test a spec finding names, replaced by one under a new title, is not removed (#2139).
      const replaced = replacedTests(
        path,
        gone,
        missingNames(namesAfter, namesBefore).filter((name) => !targets.has(name)).length,
        options.removalFindings ?? [],
      );
      const exempt = (name: string) => requested.names.has(name) || replaced.names.has(name);
      const removed = gone.filter((name) => !replaced.names.has(name));
      const lost = [...(guarded ?? [])].filter(([name]) => {
        const renamed = matched.renames.get(name);
        return !exempt(name) && !namesAfter.has(name) && !(renamed && namesAfter.has(renamed));
      });
      const keep = guarded
        ? [...guarded.keys()]
            .filter((name) => !exempt(name))
            .map((name) => matched.renames.get(name) ?? name)
        : [];
      // Count only the removed or replaced cases the spec names. Guard every other assertion.
      const excluded = spans.filter(
        (span) =>
          exempt(span.name) && !namesAfter.has(span.name) && !matched.renames.has(span.name),
      );
      const excludedCode = excluded.flatMap((span) =>
        codeLines(blankStringLiterals(path, before.slice(span.from, span.to).join("\n"))),
      );
      const unclaimed = removed.filter((name) => !lost.some(([lostName]) => lostName === name));
      const strengthen = options.strengthens?.has(path) === true;
      measures.push({
        ...base,
        form: "test",
        testsBefore,
        testsAfter,
        matchedTests: matched.tests,
        matchedAssertions: matched.assertions,
        removedTests: count(excludedCode, testCases),
        removedAssertions: count(excludedCode, assertionForms),
        ...(replaced.names.size
          ? { replacedTests: replaced.names.size, replacedBy: replaced.findingIds }
          : {}),
        lost: lost.length,
        unclaimed: unclaimed.length,
        rewrite: options.rewrites?.has(path) === true,
        strengthen,
        literalGrew: strengthen && literalText(after) > literalText(before),
        assertsBefore: count(codeBefore, assertionForms),
        assertsAfter: count(codeAfter, assertionForms),
        skips: unguardedSkips(path, codeAfter, shadow) - unguardedSkips(path, codeBefore, shadow),
        ...checks(),
        names: {
          lost: lost.map(([name, origin]) => [name, origin, removed.includes(name)]),
          keep: [...new Set(keep)],
          unclaimed,
          special: [],
        },
      });
      continue;
    }
    const deleted = change.after === null;
    const beforeCompared = compared(before);
    const special = deleted
      ? []
      : [...compared(after)].filter(
          ([value, n]) =>
            n > (beforeCompared.get(value) ?? 0) &&
            testLiterals.has(value) &&
            inputLike(value) &&
            !spec.includes(value),
        );
    measures.push({
      ...base,
      form: "source",
      deleted,
      hooks: deleted ? 0 : grew(TEST_HOOKS),
      specialLiterals: special.length,
      ...checks(),
      names: { lost: [], keep: [], unclaimed: [], special: special.map(([value]) => value) },
    });
  }
  return measures;
}

/** The findings the guard reports for the measured files, in the order of the files. */
export function integrityDecision(measures: readonly IntegrityMeasure[]): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const m of measures) {
    const { path, reasoned, requestedFile } = m;
    if (m.form === "unknown-before") {
      if (m.test && m.deleted && !reasoned && !requestedFile)
        findings.push({ rule: "test-deleted", path, detail: "deleted the test file" });
      continue;
    }
    if (m.form === "test-deleted") {
      if (m.existed && !reasoned && !m.allRequested)
        findings.push({
          rule: "test-deleted",
          path,
          detail: `deleted the test file${m.testsBefore ? ` with ${String(m.testsBefore)} test(s)` : ""}`,
        });
      continue;
    }
    if (m.form === "test") {
      const names = m.names;
      const lost: [string, string, boolean][] =
        names?.lost ?? Array.from({ length: m.lost }, () => ["", "", false]);
      for (const [name, origin, removed] of lost)
        findings.push({
          rule: "test-removed",
          path,
          detail: name
            ? `${removed ? "removed" : "left out"} test ${JSON.stringify(name)}, which ${origin} added`
            : "left out a test that a correction of another finding added",
          keep: names?.keep ?? [],
        });
      const unclaimed = names?.unclaimed ?? [];
      if (
        !reasoned &&
        !requestedFile &&
        m.testsBefore - m.testsAfter > m.matchedTests + m.removedTests
      )
        findings.push({
          rule: "test-count",
          path,
          detail: `test count dropped from ${String(m.testsBefore)} to ${String(m.testsAfter)}${unclaimed.length ? ` (removed ${quoted(unclaimed)})` : ""}`,
        });
      else if (!reasoned && !requestedFile && !m.rewrite && !m.strengthen && m.unclaimed)
        // Equal totals hide a swap: a strong test replaced by a weaker one under another name.
        findings.push({
          rule: "test-removed",
          path,
          detail: `removed test(s) ${unclaimed.length ? quoted(unclaimed) : String(m.unclaimed)} while the test count stayed ${String(m.testsAfter)}`,
        });
      const kept =
        m.testsAfter + m.matchedTests + m.removedTests >= m.testsBefore && m.assertsAfter > 0;
      const rewritten = kept && (m.rewrite || (m.strengthen && m.literalGrew));
      if (
        !reasoned &&
        !requestedFile &&
        !rewritten &&
        m.assertsBefore - m.assertsAfter > m.matchedAssertions + m.removedAssertions
      )
        findings.push({
          rule: "assertions",
          path,
          detail: `assertions dropped from ${String(m.assertsBefore)} to ${String(m.assertsAfter)} (removed or commented out)`,
        });
      if (m.skips > 0)
        findings.push({
          rule: "skip",
          path,
          detail: `added ${String(m.skips)} skip, only, todo or ignore marker(s)`,
        });
    } else if (!m.deleted) {
      if (m.hooks > 0)
        findings.push({
          rule: "test-hook",
          path,
          detail: `added ${String(m.hooks)} branch(es) on running under a test runner`,
        });
      if (m.specialLiterals > 0) {
        const special = m.names?.special ?? [];
        findings.push({
          rule: "literal-branch",
          path,
          detail: special.length
            ? `compares with test input literal(s) ${special
                .slice(0, 3)
                .map((value) => JSON.stringify(value))
                .join(", ")} that the request, spec and plan do not name`
            : `compares with ${String(m.specialLiterals)} test input literal(s) that the request, spec and plan do not name`,
        });
      }
    }
    if (!m.checked) continue;
    if (m.suppressions > 0)
      findings.push({
        rule: "suppression",
        path,
        detail: `added ${String(m.suppressions)} type or lint suppression(s) (ts-ignore, eslint-disable, any, type: ignore, allow and similar)`,
      });
    if (m.bypass > 0)
      findings.push({
        rule: "verification-bypass",
        path,
        detail: "added --no-verify or --passWithNoTests",
      });
  }
  return findings;
}

/**
 * Every integrity scan records its measures and findings as `integrity/decisions/...` (kind
 * `test-integrity`, kept in bench traces) whether or not it found anything, so a replay sees the
 * scans that passed too (#1715).
 */
export const INTEGRITY_KIND = "test-integrity";
export const INTEGRITY_DIR = "integrity/decisions/";

export interface IntegrityRecord {
  schemaVersion: 1;
  /** A task's own changes, or the whole run's before its review. */
  scope: "task" | "run";
  taskId: string | null;
  mode: "block" | "warn";
  measures: IntegrityMeasure[];
  findings: { rule: IntegrityRule; path: string }[];
  /**
   * The scan measured again with the shadow title rows (#2147), for the changed files whose
   * language has one, and the findings it would add. Absent when no such file changed, and in
   * records before #2147.
   */
  shadowTitles?: ShadowTitles;
  /**
   * Why a task's scan did not run (#2277): the host wrote its files with the content its plan fixed
   * (`host-written`), it may write nothing (`no-writes`), or it is a correction whose failing checks
   * already passed, so no session ran (`checks-passing`). Absent on a scan that ran. R72 evalpin's
   * T001 and T006 had no record at all, which read as a scan that never happened.
   */
  skipped?: "host-written" | "no-writes" | "checks-passing";
  /** The findings a prescribed test hook or verification bypass would clear (shadow, #2277). */
  shadowPrescribed?: { rule: IntegrityRule; path: string }[];
}

/** What the shadow title rows would change of a scan (#2147). */
export interface ShadowTitles {
  measures: IntegrityMeasure[];
  /** Findings the rows would add on those files. */
  findings: { rule: IntegrityRule; path: string }[];
  /** Findings of the live scan on those files that the rows would clear (a replaced test, #2139). */
  cleared: { rule: IntegrityRule; path: string }[];
}

export function integrityRecord(
  scope: IntegrityRecord["scope"],
  taskId: string | null,
  mode: IntegrityRecord["mode"],
  measures: readonly IntegrityMeasure[],
  findings: readonly IntegrityFinding[],
  shadowTitles: ShadowTitles | null = null,
  shadowPrescribed: readonly { rule: IntegrityRule; path: string }[] = [],
): IntegrityRecord {
  return {
    schemaVersion: 1,
    scope,
    taskId,
    mode,
    measures: recordedMeasures(measures),
    findings: findings.map(({ rule, path }) => ({ rule, path })),
    ...(shadowTitles ? { shadowTitles } : {}),
    ...(shadowPrescribed.length ? { shadowPrescribed: [...shadowPrescribed] } : {}),
  };
}

/**
 * The test-hook and verification-bypass findings that a prescribed exemption would clear (shadow,
 * #2277): the request, an accepted answer, the spec or the plan names the hook or the bypass with
 * the rest of its line verbatim, not to forbid it, as a prescribed suppression is (#2270), so a
 * brief that asks for `vitest run --passWithNoTests` while no test exists, or for a
 * `NODE_ENV === "test"` branch, is not gaming. Every occurrence is read on the file's raw lines,
 * and a finding clears when no unprescribed one was added. Recorded with the scan, counted nowhere.
 */
export function prescribedExemptions(
  changes: readonly FileChange[],
  specText: string,
  live: readonly IntegrityFinding[],
): { rule: IntegrityRule; path: string }[] {
  if (!specText) return [];
  const patterns: Partial<Record<IntegrityRule, RegExp>> = {
    "test-hook": TEST_HOOKS,
    "verification-bypass": BYPASS,
  };
  const prescribed = collapse(specText);
  const named = (candidate: string, marker: string) => {
    if (candidate.length <= marker.length + 2) return false;
    for (
      let at = prescribed.indexOf(candidate);
      at >= 0;
      at = prescribed.indexOf(candidate, at + 1)
    )
      if (!FORBIDS.test(prescribed.slice(Math.max(0, at - 60), at))) return true;
    return false;
  };
  // A hook's or a bypass's arguments come before it (`NODE_ENV === "test"`, `"vitest run
  // --passWithNoTests"`), so the whole line, or the quoted command that holds it, is what a brief
  // names; a bare marker is never prescribed.
  const unprescribed = (text: string | null, pattern: RegExp) => {
    let total = 0;
    for (const line of (text ?? "").split(/\r?\n/))
      for (const match of line.matchAll(pattern)) {
        const at = match.index ?? 0;
        const quote = Math.max(line.lastIndexOf('"', at), line.lastIndexOf("'", at));
        const candidates = [line, line.slice(at), quote >= 0 ? line.slice(quote) : ""].map(
          collapse,
        );
        if (!candidates.some((candidate) => named(candidate, match[0].trim()))) total++;
      }
    return total;
  };
  return live.flatMap(({ rule, path }) => {
    const pattern = patterns[rule];
    const change = changes.find((c) => c.path === path);
    if (!pattern || !change || change.before === undefined) return [];
    return unprescribed(change.after, pattern) - unprescribed(change.before, pattern) <= 0
      ? [{ rule, path }]
      : [];
  });
}

/**
 * The guard's shadow measure of new test-title rows (#2147): PHPUnit, ExUnit, zig test, OCaml's
 * Alcotest, OUnit and ppx tests, Objective-C XCTest and Foundry tests had no title extractor, so
 * the guard never named a test there (and the replacement rule of #2139 could not apply). A
 * language that gains titles also gains `test-removed` findings it never reported, so the rows
 * are read only here: the scan is measured again with them, and the findings it would add or
 * clear on the files of those languages are recorded with the scan, counted nowhere. Null when no changed file
 * is in such a language. Promoting a row drops its `shadow` flag.
 */
export function shadowTitleFindings(
  changes: readonly FileChange[],
  options: ScanOptions,
  live: readonly IntegrityFinding[],
): ShadowTitles | null {
  const shadowed = new Set(changes.filter((c) => hasShadowTitles(c.path)).map((c) => c.path));
  if (!shadowed.size) return null;
  const measures = measureTestIntegrity(changes, { ...options, shadowTitles: true }).filter((m) =>
    shadowed.has(m.path),
  );
  const key = (f: { rule: IntegrityRule; path: string }) => `${f.rule}\0${f.path}`;
  const shadow = integrityDecision(measures);
  const raised = new Set(live.map(key));
  const would = new Set(shadow.map(key));
  const keep = ({ rule, path }: { rule: IntegrityRule; path: string }) => ({ rule, path });
  return {
    measures: recordedMeasures(measures),
    findings: shadow.filter((f) => !raised.has(key(f))).map(keep),
    cleared: live.filter((f) => shadowed.has(f.path) && !would.has(key(f))).map(keep),
  };
}

/** The measures without the names: what a run records of a scan (no text). */
export function recordedMeasures(measures: readonly IntegrityMeasure[]): IntegrityMeasure[] {
  return measures.map(({ names: _names, ...rest }) => rest as IntegrityMeasure);
}

/** The instruction a repair gets for an integrity finding. */
export function integrityFix(finding: IntegrityFinding): string {
  const specRemoval =
    " A spec-basis finding explicitly requesting removal or relocation of named tests takes precedence over this host guard. Apply only those removals and keep every other test and assertion.";
  switch (finding.rule) {
    case "test-removed":
      return `Restore the removed tests in ${finding.path} with their assertions, under their names or with the same body under a new title, and make the code pass them.${finding.keep?.length ? ` Keep every one of these tests, which corrections of other findings added: ${finding.keep.map((name) => JSON.stringify(name)).join(", ")}.` : ""}${specRemoval} If the findings still cannot both hold, report outcome spec_conflict naming both findings instead of removing another test.`;
    case "test-deleted":
    case "test-count":
    case "assertions":
      return `Restore the removed tests and assertions in ${finding.path} and make the code pass them.${specRemoval} If the spec and the tests still cannot both hold, report outcome spec_conflict instead of changing other tests.`;
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
  root: string,
): string[] {
  if (testIntegrityOf(policy) !== "block") return [];
  return graph.tasks.flatMap((task) =>
    task.writes
      .filter(
        (w) => w.action !== "create" && !w.reason && preexistingTest(w.path, graph.tasks, root),
      )
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
