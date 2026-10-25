import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import {
  CHAIN_KIND,
  CHAIN_TASKS_DIR,
  type ChainRecord,
  chainFindings,
  chainRecord,
  chainSubject,
  correctiveChain,
  rewriteStep,
  rewritesSymbol,
} from "../workflows/finding-chain.js";
import { counterexampleOf } from "../workflows/quality/properties.js";
import { recoveryAdvice } from "../workflows/remedies.js";
import {
  CorrectionSchema,
  DEFAULT_FRESH_RESTART_AFTER,
  DEFAULT_MAX_TASK_REPAIRS,
  type Review,
  type RunPolicy,
  type Spec,
  type TaskGraph,
  validateTaskGraph,
} from "../workflows/schemas.js";
import { namesRunDocument } from "../workflows/spec-amendment.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RuntimeState, Task } from "../workflows/types.js";
import { runRoot } from "../workflows/worktree.js";
import {
  robustnessShapes,
  sweepClass,
  sweepEntryPoints,
  sweepRelation,
  sweepStep,
  sweepTestFiles,
  testSweepStep,
} from "./class-sweep.js";
import { findingSetHash } from "./convergence-stop.js";
import { canHold, requestedDeliverable } from "./deliverable-paths.js";
import { isFailedTestLine } from "./failed-test-line.js";
import { noteSiblingFindings } from "./initiative-ownership.js";
import { growingCounts } from "./output-counts.js";
import { reproCannotSeeCorrection } from "./repro.js";

/**
 * Planned tasks a correction of `task` may write for: those of the same profile that cover one of
 * its criteria. A plan that gives tests a task of their own leaves a code fix and the test that
 * pins the old behavior in two tasks; the correction needs both files.
 */
function relatedRootTasks(task: Pick<Task, "profileId" | "criterionIds">, root: TaskGraph): Task[] {
  return root.tasks.filter(
    (base) =>
      base.profileId === task.profileId &&
      base.criterionIds.some((id) => task.criterionIds.includes(id)),
  );
}

/**
 * One write per path for a correction. The action follows the file, not the order of the merged
 * writes: a path a planned task creates is modified once the integrated change has it and created
 * while it does not. A correction that ran before the creating task got the later task's `modify`
 * and the tool policy refused every attempt (bench round 11, mdrefs T011: 1.44M tokens).
 */
export function mergeCorrectionWrites(
  writes: Task["writes"],
  expectedFiles: Record<string, string> | null | undefined,
): Task["writes"] {
  const byPath = new Map<string, Task["writes"][number]>();
  for (const write of writes) {
    const created =
      write.action === "create" ||
      (write.action === "modify" && byPath.get(write.path)?.action === "create");
    byPath.set(write.path, created ? { ...write, action: "create" } : write);
  }
  return [...byPath.values()].map((write) => ({
    ...write,
    action:
      write.action === "create" && expectedFiles?.[write.path] !== undefined
        ? ("modify" as const)
        : write.action,
  }));
}

const fileStem = (path: string): string =>
  path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;
/** The stem a test file is named after (`cli_test.go`, `test_cli.py`, `cli.test.ts`, `CliTest.java`), or null for a non-test file. */
function testedStem(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const stripped = name.replace(/^test_/i, "").replace(/(?:[._-](?:test|spec)|Tests?)$/, "");
  if (stripped === name && !TEST_DIR.test(path)) return null;
  return stripped.toLowerCase();
}
/** Whether `test` is a test file of the source file `source`, by name. */
export function isTestOf(test: string, source: string): boolean {
  return testedStem(source) === null && testedStem(test) === fileStem(source);
}

/**
 * What a correction of `base` may write: its own files and those of the related planned tasks,
 * once each (see `mergeCorrectionWrites`).
 */
export function correctionWrites(
  base: Task,
  root: TaskGraph,
  expectedFiles: Record<string, string> | null | undefined,
): Task["writes"] {
  return mergeCorrectionWrites(
    [base, ...relatedRootTasks(base, root)].flatMap((task) => task.writes),
    expectedFiles,
  );
}

/**
 * The task checks a correction of `base` runs: its own and those of the related planned tasks. A
 * correction that may edit the test file must also run the test check, or it cannot see that its
 * fix is incomplete and the same failure comes back as no progress.
 */
export function correctionChecks(base: Task, root: TaskGraph): string[] {
  return [...new Set([base, ...relatedRootTasks(base, root)].flatMap((task) => task.checkIds))];
}

export function correctionAuthorized(task: Task, root: TaskGraph): boolean {
  const related = relatedRootTasks(task, root);
  return (
    task.origin !== "planned" &&
    related.length > 0 &&
    task.writes.every((w) =>
      related.some((base) =>
        base.writes.some(
          (b) =>
            b.path === w.path &&
            (b.action === w.action || (b.action === "create" && w.action === "modify")),
        ),
      ),
    ) &&
    task.checkIds.every((id) => related.some((base) => base.checkIds.includes(id))) &&
    task.requirementIds.every((id) => related.some((base) => base.requirementIds.includes(id))) &&
    task.criterionIds.every((id) => related.some((base) => base.criterionIds.includes(id)))
  );
}

const unique = (ids: string[]): string[] => [...new Set(ids)];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Planned files a check's output names, in plan order. Linters and compilers print the paths
 * they reject, often absolute and with backslashes on Windows. Model reports write them in
 * Markdown: in a code span or emphasis, a link, a list or an assignment (`` `tests/a.py::t` ``,
 * `**a.py**`, `[a.py](a.py)`, `path=a.py`, `<a.py>`), so those may precede a path too (#1207).
 */
export function pathsInOutput(output: string, tasks: Task[]): string[] {
  const text = output.replaceAll("\\", "/");
  const paths = unique(tasks.flatMap((t) => t.writes.map((w) => w.path)));
  return paths.filter((path) =>
    new RegExp(`(?:^|[\\s/"'(:\`*[,=<])${escapeRegExp(path)}(?![\\w.-])`, "m").test(text),
  );
}

/** Source extensions whose files are named by class in test runner output (JVM, .NET). */
const CLASS_FILE = /\.(?:java|kt|kts|scala|groovy|cs|fs|vb)$/;

/**
 * Planned files a test runner names by class rather than by path (#1270). Maven Surefire prints
 * `[ERROR]   QueryTest.depthCuts:42 expected...` and `Tests run: 3, Failures: 1, ... in
 * com.acme.engine.QueryTest`, and JVM stack frames `at com.acme.engine.Query.cut(Query.java:57)`:
 * none carries the file's path, so `pathsInOutput` finds nothing and the correction gets the
 * files of the tasks that cover the finding's criteria instead of the failing ones (plainbooks
 * 2d0a6a57 T024 could not edit Query.java or QueryTest.java). A fully qualified class matches the
 * file at that package path; a simple class name or a `Name.java:line` frame matches only a
 * planned file no other planned file shares the name with.
 */
export function classFilesInOutput(output: string, tasks: Task[]): string[] {
  const paths = unique(tasks.flatMap((t) => t.writes.map((w) => w.path))).filter((path) =>
    CLASS_FILE.test(path),
  );
  if (!paths.length) return [];
  const stem = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const unambiguous = (name: string) => {
    const named = paths.filter((path) => stem(path) === name);
    return named.length === 1 ? named : [];
  };
  const found = new Set<string>();
  // `(Query.java:57)` in a stack frame, `QueryTest.java:42` in a compiler or assertion line.
  for (const m of output.matchAll(/\b([A-Z]\w*)\.(?:java|kt|scala|groovy|cs|fs|vb):\d+/g))
    for (const path of unambiguous(m[1] ?? "")) found.add(path);
  // A fully qualified class, `com.acme.engine.QueryTest` (a nested `$Inner` names its file).
  for (const m of output.matchAll(/\b((?:[a-z_]\w*\.)+)([A-Z]\w*)\b/g)) {
    const suffix = `${(m[1] ?? "").replaceAll(".", "/")}${m[2] ?? ""}`;
    for (const path of paths)
      if (path.replace(/\.[^.]+$/, "").endsWith(`/${suffix}`)) found.add(path);
  }
  // Surefire's failure list, `[ERROR]   QueryTest.method:42` or `[ERROR] QueryTest.method »`.
  for (const m of output.matchAll(/^\[(?:ERROR|FAIL\w*)\]\s+([A-Z]\w*)\.\w+(?::\d+|\s+»)/gm))
    for (const path of unambiguous(m[1] ?? "")) found.add(path);
  // dotnet's failure summary can omit a namespace and the source path.
  for (const m of output.matchAll(/^\s*Failed\s+(?:\w+\.)*?([A-Z]\w*)\.\w+(?:\s|\[|\(|$)/gm))
    for (const path of unambiguous(m[1] ?? "")) found.add(path);
  return paths.filter((path) => found.has(path));
}

/**
 * Planned files a check's output reports a failure in: the paths that start an unindented line,
 * as a compiler error (`tests/cli.test.ts(258,45): error TS2769`, `src/a.go:3:1: ...`), a test
 * runner's file header (`tests/cli.test.ts:`) or a `FAILED`/`FAIL` line. Indented lines (related
 * information, stack frames, code excerpts) only explain a failure located elsewhere, except the
 * two forms test runners locate assertions with: `go test`'s indented `cli_test.go:42:` under a
 * `--- FAIL`, and a Rust test's `panicked at tests/cli.rs:12:5`.
 */
export function failingPathsInOutput(output: string, tasks: Task[]): string[] {
  const text = output.replaceAll("\\", "/");
  const paths = unique(tasks.flatMap((t) => t.writes.map((w) => w.path)));
  return paths.filter(
    (path) =>
      new RegExp(
        `^(?:(?:FAILED|FAIL|ERROR|error)[:\\s]\\s*)?(?:[A-Za-z]:)?(?:[^\\s:()]*/)?${escapeRegExp(path)}(?:[:(]|\\s|$)`,
        "m",
      ).test(text) ||
      new RegExp(`panicked at (?:[A-Za-z]:)?(?:[^\\s:]*/)?${escapeRegExp(path)}:\\d+`).test(text) ||
      goAssertionIn(text, path, paths),
  );
}

/**
 * Whether `go test` output locates an assertion in the Go test file `path`. Go prints the file's
 * base name only (`    cli_test.go:42: usage mismatch`), so the file counts when no other
 * planned file has that name, or when a `FAIL` package line ends in the file's directory
 * (centsplit-update 21e03a4e: the help test a dependent task updates became a corrective, #972).
 */
function goAssertionIn(text: string, path: string, paths: string[]): boolean {
  if (!path.endsWith("_test.go")) return false;
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (!new RegExp(`^\\s+${escapeRegExp(name)}:\\d+:`, "m").test(text)) return false;
  const namesakes = paths.filter((p) => p === name || p.endsWith(`/${name}`));
  if (namesakes.length === 1) return true;
  // Several planned files share the name: the `FAIL` package line (an import path) picks the one
  // in that directory; a root-level file stays ambiguous.
  if (slash < 0) return false;
  const dir = path.slice(0, slash);
  return [...text.matchAll(/^FAIL[ \t]+(\S+)/gm)].some(
    (m) => m[1] === dir || m[1]?.endsWith(`/${dir}`),
  );
}

/** A runner's line for a test file that passed: jest `PASS a`, vitest ` ✓ a (3 tests)`, pytest `a::t PASSED` or `a ....  [50%]`. */
const PASSING_LINE = /^\s*(?:PASS|✓|√|✔)\s|\bPASSED\b|^\s*\S+\s+\.+\s*(?:\[\s*\d+%\])?\s*$/;
const BUN_FAILED = /^\s*(?:\(fail\)|✗)/;
const BUN_PASSED = /^\s*(?:\(pass\)|✓)/;

/**
 * Planned files a check's output reports failing (#1419, #1420): the files `pathsInOutput`,
 * `failingPathsInOutput` (Go's base-name assertion lines) and `classFilesInOutput` (JVM and .NET
 * classes) name, less those named only on a runner's passing lines. jest, vitest and verbose
 * pytest list every test file they ran, and bun prints a header for every file, so the passing
 * files counted as failing ones: a corrective then saw its own task's passing test and opened a
 * correction of itself instead of waiting for the sibling fixing the failing one. The single place
 * the corrective decisions ask which files fail.
 */
export function failingFilesInOutput(output: string, tasks: Task[]): string[] {
  const named = unique([
    ...pathsInOutput(output, tasks),
    ...failingPathsInOutput(output, tasks),
    ...classFilesInOutput(output, tasks),
  ]);
  if (!named.length) return [];
  const lines = output.replaceAll("\\", "/").split(/\r?\n/);
  const failing = new Set<string>();
  const mentioned = new Set<string>();
  for (const path of named) {
    const at = new RegExp(`(?:^|[\\s/"'(:\`*[,=<])${escapeRegExp(path)}(?![\\w.-])`);
    const header = new RegExp(`^(?:[A-Za-z]:)?(?:\\S*/)?${escapeRegExp(path)}:\\s*$`);
    lines.forEach((line, index) => {
      if (!at.test(line) && !line.startsWith(path)) return;
      mentioned.add(path);
      if (header.test(line)) {
        // bun's file header: the file fails when a test under it does.
        const section: string[] = [];
        for (const next of lines.slice(index + 1)) {
          if (/^\S.*:\s*$/.test(next)) break;
          section.push(next);
        }
        if (section.some((l) => BUN_FAILED.test(l)) || !section.some((l) => BUN_PASSED.test(l)))
          failing.add(path);
      } else if (!PASSING_LINE.test(line)) failing.add(path);
    });
  }
  // Files no line names (a class or a Go base name) count as the parsers found them.
  return named.filter((path) => failing.has(path) || !mentioned.has(path));
}

/** Lines of a check's output that name what fails: test names and assertion messages. */
const FAILURE_LINE =
  /^\s*(?:\(fail\)|✗|✘|×|✖|⨯|FAIL|not ok|error:|AssertionError|Expected|Received|E\s{2,}|---\s*FAIL|Failed asserting)/i;

/**
 * What fails in a check's output, normalized so two runs of the same failure compare equal:
 * the failing test names and assertion lines, without timings, durations, absolute paths and
 * line numbers. A run going from six failing tests to one changes it; the same failure does not.
 * Empty when the output names nothing recognizable.
 */
export function failureSignature(output: string): string {
  const lines = output
    .replaceAll("\\", "/")
    .split(/\r?\n/)
    .filter((line) => FAILURE_LINE.test(line) || isFailedTestLine(line))
    .map((line) =>
      line
        .replace(/\[<?\s*[\d.]+\s*m?s\]/gi, "")
        .replace(/\(\d+(?:\.\d+)?\s*m?s\)/gi, "")
        // Go's package line ends with its elapsed time (`FAIL\tpkg\t0.212s`), which differs
        // between runs of the same failure (aclvet 5684de0e, #1189).
        .replace(/^(\s*(?:FAIL|ok)\s.*?)\s+\d+(?:\.\d+)?m?s(?:\s+\(cached\))?\s*$/, "$1")
        // vitest's failed-test line ends with a bare time (` × adds 3ms`).
        .replace(/^(\s*[✗✕✘×✖⨯]\s.*?)\s+\d+(?:\.\d+)?\s?m?s\s*$/, "$1")
        // Maven Surefire's `Time elapsed: 0.052 s <<< FAILURE!` and dotnet's summary
        // `Duration: 45 ms` (or `< 1 ms`, `1 m 2 s`) are on the failure lines themselves (#1678).
        .replace(
          /\b(Time elapsed|Duration):\s*<?\s*\d[\d.,]*\s*(?:ms|s|sec|m|min)\b(?:\s+\d[\d.,]*\s*(?:ms|s|sec)\b)*/gi,
          "$1",
        )
        .replace(/(?:[A-Za-z]:)?(?:\/[\w.@-]+)+\/([\w.-]+)/g, "$1")
        .replace(/:\d+(?::\d+)?/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    // Surefire's `Tests run: 4` and dotnet's `Passed: 3, Total: 4` grow as tasks add passing tests.
    .map(growingCounts)
    .filter(Boolean);
  return [...new Set(lines)].sort().slice(0, 6).join(" | ").slice(0, 400);
}

/**
 * Whether a test check's output says the runner collected no test at all: pytest's exit 5
 * ("no tests ran", "collected 0 items", or only "No files were found in testpaths" when the
 * configured `testpaths` directory does not exist yet), or "No tests found" / "No test files found"
 * of the JavaScript runners, Bun's "0 test files matching" (exit 1), Gradle 9's "did not discover
 * any tests to execute" (#1864), Go's "no test files", SwiftPM's "no tests found", Mix's "did not
 * match any directory/file: test" or "no tests to run", Flutter's "Test directory "test" not
 * found" (#1753), and RSpec's "No examples found." or "All examples were filtered out" and
 * Minitest's "0 runs, 0 assertions" (#1493), all of which exit 0, PHPUnit's "No tests executed!"
 * (#1491; Pest says "No tests found") and busted's "No test files found matching Lua pattern"
 * (#1495). A plan that writes the tests last has this state until its test tasks run, and it is no
 * defect of the code (#1031, #1208).
 */
export function noTestsCollected(output: string): boolean {
  return /\bno tests ran\b|\bno tests executed!|\bno test files found matching lua pattern\b|\bcollected 0 items\b|\bno tests? (?:files? )?found\b|\bno test files\b|\bno files were found in testpaths\b|\b0 test files matching\b|\bdid not discover any tests to execute\b|\bno tests to run\b|\bdid not match any directory\/file\b|\btest directory "?test"? not found\b|\bno examples found\b|\ball examples were filtered out\b|^0 runs, 0 assertions\b/im.test(
    output,
  );
}

/**
 * The "path does not exist" lines of the gates that take path arguments, each capturing the path
 * (#1913). A gate that names a folder a later task creates (`ruff check src tests` before the test
 * task) fails with only this until that task runs. A new lint or test gate that takes paths adds
 * its form here, with a case in `tests/missing-path-owner.test.ts`.
 */
export const MISSING_PATH_LINES: readonly { tool: string; line: RegExp }[] = [
  // ruff: `E902 No such file or directory (os error 2)` then `--> tests:1:1`; older ruff and
  // flake8 put the path first: `tests:0:1: E902 FileNotFoundError: [Errno 2] ...`.
  { tool: "ruff", line: /^\s*-->\s+(\S+?):\d+:\d+\s*$/ },
  { tool: "ruff, flake8", line: /^(\S+?):\d+:\d+:\s+E902\b/ },
  { tool: "mypy", line: /\bcan't read file '([^']+)'/ },
  { tool: "black", line: /\bPath '([^']+)' does not exist/ },
  { tool: "pytest", line: /\bfile or directory not found:\s+(\S+)/ },
  { tool: "eslint", line: /\bNo files matching the pattern "([^"]+)"/ },
  {
    tool: "phpstan",
    line: /^\s*(?:\S+\s+)?(?:Path|The file|File)\s+'?([^'\s]+)'?\s+(?:does not|doesn't) exist/i,
  },
  { tool: "go", line: /\bstat\s+(\S+):\s+directory not found/ },
  { tool: "go", line: /"(\S+?)" matched no packages/ },
  { tool: "go", line: /\bdirectory\s+(\S+)\s+(?:does not exist|not found)/ },
  { tool: "luacheck", line: /^Checking\s+(\S+)\s+I\/O error/ },
  // busted, selene and StyLua given a path that does not exist (#1495).
  { tool: "busted", line: /^Error (?:->|→) Cannot find file or directory: (\S+)$/ },
  { tool: "selene", line: /\bError getting metadata of (\S+?): No such file or directory/ },
  { tool: "stylua", line: /\bno file or directory found matching '([^']+)'/ },
  // PHPUnit given a folder that does not exist: `Test directory "/w/tests" not found` (10 and
  // later), `Cannot open file "tests.php".` (9).
  { tool: "phpunit", line: /\bTest (?:directory|file) "([^"]+)" not found/ },
  { tool: "phpunit", line: /\bCannot open file "([^"]+?)(?:\.php)?"/ },
  // RSpec: `An error occurred while loading ./spec/a_spec.rb.`, a missing file only when RSpec's
  // own `load` failed (`Failure/Error: __send__(method, file)`), not a `require` inside the file.
  { tool: "rspec", line: /^An error occurred while loading (\S+?)\.?(?: - Did you mean\?)?$/ },
  { tool: "ruby", line: /^ruby: No such file or directory -- (\S+) \(LoadError\)$/ },
  { tool: "rake", line: /^File does not exist: (\S+)$/ },
  { tool: "rubocop", line: /^Error: No such file or directory: (\S+)$/ },
];

/** Whether RSpec's own `load` of the file named at `index` failed, a few lines below it. */
const rspecMissing = (lines: readonly string[], index: number): boolean =>
  lines
    .slice(index + 1, index + 4)
    .some((line) => /^Failure\/Error: __send__\(method, file\)/.test(line));

/** Whether an E902 error comes just before ruff's `-->` location line at `index`. */
const ruffMissing = (lines: readonly string[], index: number): boolean =>
  lines
    .slice(Math.max(0, index - 3), index)
    .some((line) => /\bE902\b|No such file or directory/.test(line));

/**
 * The planned files under a path a check's output says does not exist: the path itself when it is
 * a planned write, or the planned writes it is a folder of (#1913). A failure that names only such
 * paths is the task's that writes them, not the task that ran the check. `./`, a trailing `/` or
 * `/...` and an absolute prefix (`stat /w/tests`) are ignored.
 */
export function missingPlannedPaths(
  output: string,
  tasks: readonly Pick<Task, "writes">[],
): string[] {
  const lines = output.replaceAll("\\", "/").split(/\r?\n/);
  const named = new Set<string>();
  lines.forEach((line, index) => {
    for (const { tool, line: pattern } of MISSING_PATH_LINES) {
      const path = pattern.exec(line)?.[1];
      // The `-->` location line names a missing path only right after an E902 error.
      if (
        !path ||
        (tool === "ruff" && !ruffMissing(lines, index)) ||
        (tool === "rspec" && !rspecMissing(lines, index))
      )
        continue;
      const clean = path
        .replace(/^\.\//, "")
        .replace(/\/\.\.\.$/, "")
        .replace(/\/+$/, "");
      if (clean && clean !== ".") named.add(clean);
    }
  });
  if (!named.size) return [];
  const planned = unique(
    tasks.flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path)),
  );
  // An absolute path (`stat /w/tests`) holds a planned folder at its end; a relative one is exact.
  const holds = (missing: string, dir: string) =>
    missing === dir || (/^(?:\/|[A-Za-z]:\/)/.test(missing) && missing.endsWith(`/${dir}`));
  return planned.filter((path) =>
    [...named].some((missing) => {
      const parts = path.split("/");
      return parts.some((_, i) => holds(missing, parts.slice(0, i + 1).join("/")));
    }),
  );
}

/**
 * A corrective task's title: what its first finding claims, not the finding's id. Reports listed
 * tasks such as "Correct 2f2d7618-1056-452e-a487-c9c888b7e163" that said nothing (#1146).
 */
export function correctionTitle(
  findings: Pick<Review["findings"][number], "claim" | "file">[],
): string {
  const [first] = findings;
  if (!first) return "Correct findings";
  const claim = first.claim.replace(/\s+/g, " ").trim();
  const where = first.file && !claim.includes(first.file) ? ` (${first.file})` : "";
  const text = `${claim}${where}`;
  const short = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  const more = findings.length > 1 ? ` and ${findings.length - 1} more` : "";
  return `Correct: ${short}${more}`;
}

/**
 * Whether open findings already name every failing test of a check's output. A task that reports
 * a defect while other tasks' failures are still being corrected sees the same red check; those
 * failures are not its to answer again (cimatrix 5670e55c: a README task opened a third and a
 * fourth corrective task for two defects already in correction, #1146).
 */
export function failuresCovered(
  output: string,
  open: Pick<Review["findings"][number], "claim" | "impact">[],
): boolean {
  const failing = failureSignature(output).split(" | ").filter(Boolean);
  if (!failing.length || !open.length) return false;
  const named = open.map((f) => `${f.claim}\n${f.impact}`).join("\n");
  return failing.every((line) => named.includes(line));
}

/** The failing tests and assertions a check finding's impact quotes (`Failing: ...`), or null. */
export function failingOf(impact: string): string | null {
  const match =
    /Failing: ([\s\S]*?)(?:\. Property counterexample: |\. The failing test runs |$)/.exec(impact);
  return match?.[1]?.trim() || null;
}

/** The claim of a finding for a required check that failed. */
export const checkFailedClaim = (checkId: string): string => `Required check ${checkId} failed`;

/**
 * The claim of a finding for a required check that passed with more diagnostics than the code
 * the run started from: it did not fail, and saying so started a correction for a passing lint
 * check (#1791).
 */
export const checkRatchetClaim = (checkId: string): string =>
  `Required check ${checkId} passed with more diagnostics`;

/** The claims a passing run of a check closes. */
export const checkClaims = (checkId: string): string[] => [
  checkFailedClaim(checkId),
  checkRatchetClaim(checkId),
];

/** The check a check finding's claim names, failed or ratcheted; else null. */
export const checkOfClaim = (claim: string): string | null =>
  /^Required check (\S+) (?:failed|passed with more diagnostics)$/.exec(claim)?.[1] ?? null;

/**
 * Findings for a failed run-level check. Run 6931efd6: ruff flagged three test files of three
 * tasks, but the one finding (no file) went to the first task with the check, whose correction
 * could not edit the other two files. When the output names planned files, each task that
 * writes one gets its own finding on that file, so each is corrected from its owner.
 */
export function failedCheckFindings(
  check: { id: string },
  evidenceId: string,
  output: string,
  tasks: Task[],
  fallback: Pick<Review["findings"][number], "requirementIds" | "criterionIds">,
  suggestedFix: string,
  newId: () => string,
  ratchet?: { severity: Review["findings"][number]["severity"] },
): Review["findings"] {
  const finding = (
    file: string | null,
    ids: Pick<Review["findings"][number], "requirementIds" | "criterionIds">,
  ): Review["findings"][number] => ({
    id: newId(),
    kind: "correctness",
    severity: ratchet?.severity ?? "high",
    requirementIds: ids.requirementIds,
    criterionIds: ids.criterionIds,
    file,
    symbol: null,
    evidenceIds: [evidenceId],
    claim: ratchet ? checkRatchetClaim(check.id) : checkFailedClaim(check.id),
    impact: `${signature ? `Implementation cannot be accepted. Failing: ${signature}` : "Implementation cannot be accepted"}${counterexample ? `. Property counterexample: ${counterexample}` : ""}`,
    suggestedFix,
  });
  const signature = failureSignature(output);
  // A failing property's shrunk input is the reproduction the correction starts from (#637).
  const counterexample = counterexampleOf(output);
  const owners = new Map<string, { task: Task; file: string }>();
  const named = failingFilesInOutput(output, tasks);
  // The code a failing test exercises is where its fix usually goes (plainbooks 2d0a6a57: the
  // failing QueryTest needed Query.java), so the planned subjects of the named tests count too
  // (#1270).
  const planned = unique(tasks.flatMap((t) => t.writes.map((w) => w.path)));
  const subjects = planned.filter((source) => named.some((test) => isTestOf(test, source)));
  for (const path of named) {
    const task = tasks.find((t) => t.writes.some((w) => w.path === path));
    if (task && !owners.has(task.id)) owners.set(task.id, { task, file: path });
  }
  // A subject gets its own finding even when its owner already has one, so the correction's first
  // attempt, which starts from the findings' files, may write it.
  for (const path of subjects) {
    const task = tasks.find((t) => t.writes.some((w) => w.path === path));
    if (task && ![...owners.values()].some((o) => o.file === path))
      owners.set(`${task.id}\n${path}`, { task, file: path });
  }
  if (!owners.size) return [finding(null, fallback)];
  return [...owners.values()].map(({ task, file }) => finding(file, task));
}

/**
 * The planned task a finding is corrected from. A task that writes the finding's file and covers
 * one of its criteria comes first. Otherwise the task that writes the file is widened to the
 * finding's criteria that tasks of its profile cover, with the requirements those tasks map them
 * to, so the correction may also write their files: a plan can give the store to one task and the
 * criterion the store breaks to the CLI and test tasks.
 */
export function correctionBase(
  finding: Pick<Review["findings"][number], "file" | "criterionIds" | "requirementIds">,
  root: TaskGraph,
  spec: Spec,
): Task | undefined {
  const exact = root.tasks.find(
    (t) =>
      (!finding.file || t.writes.some((w) => w.path === finding.file)) &&
      (finding.criterionIds.some((id) => t.criterionIds.includes(id)) ||
        finding.requirementIds.some((id) => t.requirementIds.includes(id))),
  );
  if (exact || !finding.file) return exact;
  const owner = root.tasks.find((t) => t.writes.some((w) => w.path === finding.file));
  if (!owner) return undefined;
  const covering = (id: string) =>
    root.tasks.filter((t) => t.profileId === owner.profileId && t.criterionIds.includes(id));
  const criteria = finding.criterionIds.filter((id) => covering(id).length > 0);
  const requirements = criteria.flatMap((id) => {
    const verified = spec.criteria.find((c) => c.id === id)?.requirementIds ?? [];
    return covering(id).flatMap((t) => t.requirementIds.filter((r) => verified.includes(r)));
  });
  return {
    ...owner,
    criterionIds: unique([...owner.criterionIds, ...criteria]),
    requirementIds: unique([...owner.requirementIds, ...requirements]),
  };
}

/**
 * The first step of a correction whose finding carries a repro (#765): run it before editing,
 * so the fix starts from the failure the reviewer showed, and again after the fix.
 */
function reproStep(finding: Pick<Review["findings"][number], "repro" | "file">): string {
  const repro = finding.repro;
  if (!repro) return "";
  // A document finding's repro that runs code is evidence, not a gate: the host does not run it
  // and run_repro leaves it out (#1375), so the correction is not told to make it pass (#1422).
  if (reproCannotSeeCorrection(finding.file, repro))
    return `\nEvidence: the review ran ${[repro.executable, ...repro.args].map((a) => JSON.stringify(a)).join(" ")} and saw ${JSON.stringify(repro.actual)}. It shows what the code does; this correction changes ${finding.file}, which that command does not read, so it is not run again and does not have to change.`;
  const command = [repro.executable, ...repro.args].map((a) => JSON.stringify(a)).join(" ");
  // run_repro runs it with its input files and stdin; run_probe takes only a command line (#1283).
  return `\nReproduce first: run_repro runs ${command}${repro.files?.length || repro.stdin !== undefined ? " with its input files and stdin" : ""} as the host does before it accepts the task. Call it before editing. The review saw it print ${JSON.stringify(repro.actual)} where the spec needs ${JSON.stringify(repro.expected)}. After the fix, run it again and confirm it no longer reproduces.`;
}

/**
 * The last step of a correction for a reviewer's finding (#943): the reviewer shows one case, and
 * the same defect often sits in sibling code paths (todo-cli: `add --help` was repaired, then the
 * re-review found `tag` and `untag`, and the run stopped). One repair should cover them all. It
 * goes to the corrections of review passes too, not only of convergence (#1160).
 */
const SIBLING_STEP =
  "\nThe review shows one case. Look for the same defect in sibling code paths (other commands, options, branches or callers that share the faulty pattern) and fix every case you find, checking each one as you checked the reported one.";

/**
 * The last step of a correction for a finding that repeats an earlier corrected one (#1774): the
 * earlier fix covered one case of a class, so this one names the class instead of looking for
 * sibling code paths in general. md-site (bench round 52): a tab before `javascript:` was fixed,
 * then a U+0001 before it was found and corrected for 2.46M tokens.
 */
const repeatStep = (repeatOf: string): string =>
  `\nThis finding repeats ${repeatOf}, which an earlier correction of this run fixed for one case only; its patch is under recurringFindings in your input. Name the class of input both findings belong to (for example every control or whitespace character before a URL scheme, not only a tab), extend that fix to the whole class where it changed the code, and add one table-driven test with a row per case, both findings' cases included.`;

/** The group key prefix of a class sweep's findings (#1160). */
const SWEEP_KEY = "sweep\n";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

/** A finding of a failed check run: it names the check and cites that run's evidence. */
const checkRunFinding = (finding: Pick<Review["findings"][number], "claim" | "evidenceIds">) =>
  checkOfClaim(finding.claim) !== null && finding.evidenceIds.length > 0;

/**
 * How many corrections lead to a task: 0 for a planned task, 1 for the correction of a planned
 * task, 2 for the correction of that correction, and so on.
 */
function correctionDepth(state: RuntimeState, taskId: string): number {
  let depth = 0;
  let current = state.graph?.tasks.find((t) => t.id === taskId);
  const seen = new Set<string>();
  while (current && current.origin !== "planned" && !seen.has(current.id)) {
    seen.add(current.id);
    depth++;
    const predecessor = current.findingIds
      .map((id) => state.repairPredecessors[id])
      .find((id): id is string => Boolean(id));
    current = predecessor ? state.graph?.tasks.find((t) => t.id === predecessor) : undefined;
  }
  return depth;
}

function correctionRoot(state: RuntimeState, taskId: string): string {
  let current = taskId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const task = state.graph?.tasks.find((t) => t.id === current);
    if (!task || task.origin === "planned") break;
    const predecessor = task.findingIds.map((id) => state.repairPredecessors[id]).find(Boolean);
    if (!predecessor) break;
    current = predecessor;
  }
  return current;
}

/**
 * Adds corrective tasks for findings. `scope: "task"` is a correction a task's own failed checks
 * start during the implement stage: it is bounded by `maxTaskRepairs` per chain of corrections
 * and does not spend a repair round, which counts checks-stage passes (cfgtrace 276e4858: two
 * task-level corrections used both rounds and the checks stage could not repair eight failing
 * tests). `scope: "review"` is a correction a review pass starts: it counts review rounds, which
 * have their own `maxRepairRounds` budget, so a checks stage that needed both rounds still leaves
 * the review its corrections (mdrefs 8531a4f0: a reproduced medium finding was refused as round 3
 * with every required check green).
 */
export function appendCorrections(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  submittedFindings: Review["findings"],
  kind: "repair" | "convergence",
  scope: "round" | "task" | "review" = "round",
): void {
  if (!state.graph || !state.rootGraph || !state.spec || !state.approvalRoot)
    throw new WorkflowFault("STALE_DECISION", "Repair requires an approved root graph");
  const siblingNotes = noteSiblingFindings(
    state,
    scope === "review" ? "review" : kind,
    submittedFindings,
  );
  for (const id of siblingNotes) store.findingStatus(runId, id, "resolved");
  const findings = submittedFindings.filter((finding) => !siblingNotes.has(finding.id));
  if (!findings.length) return;
  for (const finding of findings) {
    const kind = requestedDeliverable(finding);
    const paths = state.rootGraph.tasks.flatMap((task) =>
      task.writes.filter((write) => write.action !== "delete").map((write) => write.path),
    );
    if (kind && !canHold(paths, kind))
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `Finding ${finding.id} needs a writable ${kind} path, but the approved tasks have none. Re-plan to approve its target or assign an initiative owner.`,
      );
  }
  const run = store.run(runId);
  const taskLevel = kind === "repair" && scope === "task";
  const chain = taskLevel
    ? Math.max(
        0,
        ...findings.map((f) => {
          const predecessor = state.repairPredecessors[f.id];
          return predecessor ? correctionDepth(state, predecessor) : 0;
        }),
      )
    : 0;
  const reviewPass = kind === "repair" && scope === "review";
  const checksRound = kind === "repair" && scope === "round";
  // The counter this correction spends and the name its artifact and correction record carry.
  const roundKind = reviewPass ? "review" : kind;
  const round = taskLevel
    ? chain + 1
    : (reviewPass
        ? (run.review_rounds ?? 0)
        : kind === "repair"
          ? run.repair_rounds
          : run.convergence_rounds) + 1;
  // A person's "one more round" at a convergence decision raises both limits for that stage.
  const limit = taskLevel
    ? (policy.maxTaskRepairs ?? DEFAULT_MAX_TASK_REPAIRS)
    : kind === "repair"
      ? policy.maxRepairRounds +
        (checksRound ? (state.extraRepairRounds ?? 0) : (state.extraReviewRounds ?? 0))
      : policy.maxConvergenceRounds + state.extraConvergenceRounds;
  const cap = policy.maxCorrectiveTasks + state.extraCorrectiveTasks;
  const exhaustedChains = taskLevel
    ? findings.flatMap((f) => {
        const predecessor = state.repairPredecessors[f.id];
        if (!predecessor) return [];
        const id = correctionRoot(state, predecessor);
        const required =
          correctionDepth(state, predecessor) + 1 - limit - (state.extraTaskRepairs?.[id] ?? 0);
        return required > 0 ? [{ id, required }] : [];
      })
    : [];
  const findingSet = findingSetHash(findings);
  // A task-level correction repeating its task's failure is bounded by its chain length; it
  // leaves the stage-level repeat count to the checks stage and reviews.
  const repeats = taskLevel
    ? 0
    : state.previousFindingSet === findingSet
      ? state.noProgressRounds + 1
      : 0;
  // A repair that leaves the failing output as it was may have had no way to see the cause
  // (hookdrop c325575b: a library dropped a character the code could not restore). Repeats before
  // `freshRestartAfter` get the next repair round, told to isolate the failure with run_probe
  // before editing again. At `freshRestartAfter` the correction starts from a clean context:
  // the accumulated attempts are what it would otherwise keep repeating. A repeat after that
  // stops the run. Convergence repeats go to a person first (convergenceStop), so a convergence
  // round never repeats.
  const after =
    kind === "repair" && !taskLevel ? (policy.freshRestartAfter ?? DEFAULT_FRESH_RESTART_AFTER) : 0;
  const fresh = kind === "repair" && !taskLevel && repeats === after;
  // A checks failure after a review or convergence correction gets one repair round of its own
  // when early failures spent the budget: md-site 2f949017 used both rounds on two generated
  // property tests, and a regression the last convergence corrective made in another test was
  // refused with 13 of 13 tasks done (#1272). The same findings repeating still stop the run.
  const regression = checksRound && state.correctedSinceRepair === true && round > limit;
  const repeatGranted = kind === "repair" && repeats > after && state.extraRepeatRepairs > 0;
  // The fresh-context attempt is the restart of a repeated failure, not another repair round, so
  // the round limit does not refuse it; the corrective task cap still applies.
  const overRounds = taskLevel
    ? exhaustedChains.length > 0
    : round > limit && !fresh && !regression;
  const countRound = (tasks: number): void => {
    store.addRound(runId, roundKind, tasks);
    if (repeatGranted) state.extraRepeatRepairs--;
    if (checksRound) {
      if (regression) state.extraRepairRounds = (state.extraRepairRounds ?? 0) + 1;
      state.correctedSinceRepair = false;
    } else if (kind === "convergence" || reviewPass) state.correctedSinceRepair = true;
  };
  const refuse = (
    setting: string,
    value: number,
    count: number,
    required = taskLevel ? Math.max(1, ...exhaustedChains.map((c) => c.required)) : round - limit,
  ): never => {
    // Not BUDGET_EXHAUSTED: `workflow extend` raises tokens, calls and time, none of which helps.
    const advice =
      setting === "maxConvergenceRounds"
        ? "Narrow the spec, raise the limit with workflow revise, or fork the run."
        : "Grant one more repair with workflow repair, narrow the spec, revise, or fork the run.";
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      recoveryAdvice(
        `no_progress: ${count} finding(s) remain after the policy's ${setting} (${value}). ${advice}`,
        `no_progress: ${count} finding(s) remain after the policy's ${setting} (${value}). Narrow the spec or raise ${setting}.`,
        ...(setting === "maxConvergenceRounds" ? [] : [{ action: "repair" as const, runId }]),
        { action: "revise", runId, setting },
        { action: "fork", runId },
      ),
      {
        reason: "no_progress",
        limit: setting,
        repairBlock: {
          limit: setting,
          scope: kind === "convergence" ? "convergence" : scope,
          required,
          taskIds: [...new Set(exhaustedChains.map((c) => c.id))],
        },
      },
    );
  };
  if (overRounds)
    refuse(
      taskLevel ? "maxTaskRepairs" : kind === "repair" ? "maxRepairRounds" : "maxConvergenceRounds",
      // The setting a person would raise, without the rounds granted for regressions.
      kind === "repair" && !taskLevel ? policy.maxRepairRounds : limit,
      findings.length,
    );
  if (repeats > after && !repeatGranted)
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      kind === "repair"
        ? recoveryAdvice(
            `no_progress: a correction started from a clean context left the same ${findings.length} finding(s) as the ${String(after)} repair round(s) before it. Grant one more repair with workflow repair, fix the cause by hand or revise the plan, then resume.`,
            `no_progress: a correction started from a clean context left the same ${findings.length} finding(s) as the ${String(after)} repair round(s) before it. Another repair may repeat them again.`,
            { action: "repair", runId },
            { action: "revise", runId },
          )
        : "no_progress: consecutive reflection rounds repeat the same findings",
      {
        reason: "no_progress",
        ...(kind === "repair"
          ? { freshRestart: true, repairBlock: { limit: "freshRestart", scope, required: 1 } }
          : {}),
      },
    );
  const isolate =
    "isolate the cause with run_probe (a minimal program or the failing test alone) and confirm what the code or a library actually does before editing again; if the cause lies outside the files you may edit, say so in unresolved.";
  // A corrective whose own check fails the same way as the finding it was opened for left that
  // defect as it was: md-site d486645a (bench round 34) opened T011 for T008 and T012 for T011,
  // each told only "Task T0NN required check tests-written failed" for the same failing test
  // (#1285). The next correction is told it is the same defect, which corrective left it, and to
  // isolate the cause first.
  const repeatedBy = (finding: Review["findings"][number]): string | null => {
    if (!taskLevel) return null;
    const predecessor = state.repairPredecessors[finding.id];
    const corrective = state.graph?.tasks.find(
      (t) => t.id === predecessor && t.origin !== "planned",
    );
    const failing = failingOf(finding.impact);
    if (!corrective || !failing) return null;
    return store
      .findings(runId)
      .some(
        (row) =>
          corrective.findingIds.includes(row.id) &&
          failingOf((JSON.parse(row.body_json) as { impact?: string }).impact ?? "") === failing,
      )
      ? corrective.id
      : null;
  };
  const toCorrect =
    repeats > 0 && !fresh
      ? findings.map((f) => ({
          ...f,
          suggestedFix: `${f.suggestedFix} The previous correction left this failure unchanged: ${isolate}`,
        }))
      : findings.map((f) => {
          const by = repeatedBy(f);
          return by
            ? {
                ...f,
                suggestedFix: `${f.suggestedFix} This is the same failure ${by} was opened for, and ${by}'s change left it: ${isolate}`,
              }
            : f;
        });
  const predecessorsBefore = { ...state.repairPredecessors };
  // Above every id a row of the run has used, so a correction never takes over the row (and the
  // status) of a task an earlier plan revision cancelled (#1190).
  let next =
    Math.max(
      ...[...state.graph.tasks, ...store.tasks(runId)]
        .map((t) => Number(t.id.slice(1)))
        .filter(Number.isFinite),
    ) + 1;
  // Findings against the same task and file become one corrective task: each task reads the
  // files again from scratch, so three failed checks of one task were three full rereads. The
  // findings of one failing check run (they cite the same evidence) of tasks with one profile
  // become one task that may write every implicated file: one run is one failure to fix, and a
  // task per file (md-site c0456d78, four tasks for one failing test run) paid for the same
  // reading four times and left the later tasks with nothing to change.
  //
  // Review findings on one file become one task too, whichever planned task each resolves to: a
  // file that two planned tasks write (one creates it, a later one extends it) split md-site
  // 23c03a8e's three findings in src/front-matter.ts into three tasks of 239k, 347k and 910k,
  // each reading the same file and tests again (#994). A finding that names no file joins a task
  // already correcting its planned task. The most severe findings come first in the task.
  const groups = new Map<string, { base: Task; bases: Task[]; findings: Review["findings"] }>();
  const runGroups = new Map<string, string>();
  const ordered = [...toCorrect].sort(
    (a, b) =>
      Number(!a.file) - Number(!b.file) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  // A finding on a run document has no task to correct it: its spec amendment, recorded before
  // this call, settles it (#1066).
  const plannedPaths = state.rootGraph.tasks.flatMap((t) => t.writes.map((w) => w.path));
  // With `classSweep`, the robustness findings of a review or convergence pass become one task per
  // profile that sweeps the class across its entry points (#1160), and the test-style findings one
  // that sweeps the sibling test files (#1191).
  const sweepOf = (finding: Review["findings"][number]): "robustness" | "tests" | null =>
    policy.classSweep === true &&
    (kind === "convergence" || reviewPass) &&
    !checkRunFinding(finding)
      ? sweepClass(finding)
      : null;
  const sweeping = (finding: Review["findings"][number]): boolean => sweepOf(finding) !== null;
  const sweepFiles = (
    findings: Review["findings"],
    profileId: string,
    base: Task,
    root: TaskGraph,
  ): string[] =>
    findings.some((f) => sweepOf(f) === "tests")
      ? sweepTestFiles(findings, root, profileId)
      : sweepEntryPoints(
          findings,
          root,
          profileId,
          base,
          sweepRelation(
            runRoot(store.workspace, state),
            findings.map((f) => f.file).filter((f): f is string => Boolean(f)),
            criteriaText(findings),
          ),
        );
  // The criteria of the findings and their requirements, as one text an entry point may be named in.
  const criteriaText = (findings: Review["findings"]): string => {
    const spec = state.spec;
    if (!spec) return "";
    const ids = new Set(findings.flatMap((f) => f.criterionIds));
    const criteria = spec.criteria.filter((c) => ids.has(c.id));
    const requirements = new Set(criteria.flatMap((c) => c.requirementIds));
    return [
      ...criteria.map((c) => `${c.given}\n${c.when}\n${c.then}`),
      ...spec.requirements.filter((r) => requirements.has(r.id)).map((r) => r.text),
    ].join("\n");
  };
  const documents = ordered.filter((f) => namesRunDocument(f, plannedPaths));
  for (const finding of ordered) {
    if (documents.includes(finding)) continue;
    const predecessor = state.repairPredecessors[finding.id];
    const base =
      (predecessor && state.graph?.tasks.find((t) => t.id === predecessor)) ||
      correctionBase(finding, state.rootGraph, state.spec);
    if (!base || (finding.file && !base.writes.some((w) => w.path === finding.file)))
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `Correction requires writes outside the approved task scope${finding.file ? `: ${finding.file}` : ""}. Revise the run's plan or replan the initiative feature to approve the required path.`,
      );
    state.repairPredecessors[finding.id] = base.id;
    const fileKey = finding.file
      ? `${base.profileId}\n${finding.file}`
      : ([...groups].find(
          ([, g]) => g.base.profileId === base.profileId && g.bases.some((b) => b.id === base.id),
        )?.[0] ?? `${base.id}\n`);
    let key = fileKey;
    if (checkRunFinding(finding)) {
      const run = `${finding.evidenceIds[0]}:${base.profileId}`;
      key = groups.has(fileKey) ? fileKey : (runGroups.get(run) ?? fileKey);
      runGroups.set(run, key);
    }
    const sweepKind = sweepOf(finding);
    if (sweepKind) key = `${SWEEP_KEY}${sweepKind}\n${base.profileId}`;
    const existing = groups.get(key);
    const group = existing
      ? {
          base: {
            ...existing.base,
            criterionIds: unique([...existing.base.criterionIds, ...base.criterionIds]),
            requirementIds: unique([...existing.base.requirementIds, ...base.requirementIds]),
          },
          bases: existing.bases.some((b) => b.id === base.id)
            ? existing.bases
            : [...existing.bases, base],
          findings: existing.findings,
        }
      : { base, bases: [base], findings: [] as Review["findings"] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  // Only findings on run documents: their amendments settle them and no file changes, so the
  // reviews stand and only the convergence is judged again, with the amendment in its prompt.
  if (!groups.size && documents.length) {
    for (const finding of documents) store.findingStatus(runId, finding.id, "resolved");
    state.convergence = null;
    // It still counts as a round, so a reviewer that keeps raising run documents meets the limit.
    if (!taskLevel) {
      state.noProgressRounds = repeats;
      state.previousFindingSet = findingSet;
      countRound(0);
    }
    return;
  }
  // The cap counts corrective tasks: the findings of one failed check run become one task, so one
  // pytest run recorded against six owning files is one task, not six (cfgtrace 276e4858).
  if (run.corrective_tasks + groups.size > cap) {
    state.repairPredecessors = predecessorsBefore;
    refuse("maxCorrectiveTasks", cap, findings.length, run.corrective_tasks + groups.size - cap);
  }
  if (!taskLevel) {
    state.noProgressRounds = repeats;
    state.previousFindingSet = findingSet;
  }
  const root = state.rootGraph;
  // A task-level repair may amend completed tests, but cannot create a future test or take
  // over a shared test file whose next planned slice has still to run (#1612).
  const taskRows = taskLevel ? store.tasks(runId) : [];
  const finished = new Set(
    taskRows
      .filter((row) => ["implemented", "verified", "blocked"].includes(row.status))
      .map((row) => row.id),
  );
  const availableTest = (path: string): boolean =>
    !taskLevel ||
    testedStem(path) === null ||
    (state.expectedFiles?.[path] !== undefined &&
      !root.tasks.some((t) => !finished.has(t.id) && t.writes.some((w) => w.path === path)) &&
      root.tasks.some(
        (t) => finished.has(t.id) && t.writes.some((w) => w.path === path && w.action !== "delete"),
      ));
  // A planned file the correction needs: its owner of the same profile joins the group, so the
  // correction may write it and the acceptance rule still finds it related.
  const writable = (group: { bases: Task[] }): string[] =>
    group.bases
      .flatMap((b) => correctionWrites(b, root, null))
      .map((w) => w.path)
      .filter(availableTest);
  const join = (group: { base: Task; bases: Task[] }, path: string): void => {
    if (!availableTest(path) || writable(group).includes(path)) return;
    const owner = root.tasks.find(
      (t) => t.profileId === group.base.profileId && t.writes.some((w) => w.path === path),
    );
    if (!owner || group.bases.some((b) => b.id === owner.id)) return;
    group.bases.push(owner);
    group.base = {
      ...group.base,
      criterionIds: unique([...group.base.criterionIds, ...owner.criterionIds]),
      requirementIds: unique([...group.base.requirementIds, ...owner.requirementIds]),
    };
  };
  const planned = unique(root.tasks.flatMap((t) => t.writes.map((w) => w.path)));
  for (const group of groups.values()) {
    // The files a failing check names, and the planned files the findings name in their claim or
    // fix (expenses-py 1363445a: "update tests/test_cli.py" from a task that could not write it).
    for (const finding of group.findings) {
      for (const path of state.repairScope?.[finding.id] ?? []) join(group, path);
      for (const path of pathsInOutput(`${finding.claim}\n${finding.suggestedFix}`, root.tasks))
        join(group, path);
    }
    // The planned tests of the files the correction writes: a fix often needs its regression
    // assertion there (junitdigest 3e5be74b T014 could not add one to internal/cli/cli_test.go).
    // A sweep may write its entry points, and its first attempt is focused on them (#765).
    if (group.findings.some(sweeping)) {
      const entries = sweepFiles(group.findings, group.base.profileId, group.base, root);
      for (const path of entries) join(group, path);
      for (const finding of group.findings.filter(sweeping))
        state.repairScope[finding.id] = unique([
          ...(state.repairScope[finding.id] ?? []),
          ...entries,
        ]);
    }
    const written = writable(group);
    for (const path of planned)
      if (availableTest(path) && written.some((source) => isTestOf(path, source)))
        join(group, path);
    for (const finding of group.findings) {
      const kind = requestedDeliverable(finding);
      if (!kind || canHold(writable(group), kind)) continue;
      const targets = root.tasks
        .filter(
          (task) =>
            task.profileId === group.base.profileId &&
            task.criterionIds.some((id) => finding.criterionIds.includes(id)),
        )
        .flatMap((task) =>
          task.writes.filter((write) => write.action !== "delete").map((write) => write.path),
        )
        .filter((path) => canHold([path], kind));
      for (const path of targets) join(group, path);
      if (!canHold(writable(group), kind))
        throw new WorkflowFault(
          "INPUT_CHANGED",
          `Finding ${finding.id} has no writable ${kind} target in its corrective task. Re-plan to approve the required deliverable.`,
        );
    }
  }
  // A review or convergence finding that is the CHAIN_REWRITE_AT-th of a chain on one symbol or
  // one defect family of a file: its corrective rewrites against the chain's battery when the
  // policy says so, and the decision is recorded either way (#1959, #2048).
  const chainable = (finding: Review["findings"][number]): boolean =>
    (kind === "convergence" || reviewPass) && !checkRunFinding(finding);
  // A chain needs a repeatOf link or a family, so a round without either reads no findings.
  const known = findings.some((f) => chainable(f) && (f.repeatOf || f.family))
    ? chainFindings(store, runId, findings)
    : new Map();
  const chainRecords: ChainRecord[] = [];
  const additions = [...groups].map(([key, { base, bases, findings: grouped }]) => {
    const id = `T${String(next++).padStart(3, "0")}`;
    const ids = grouped.map((f) => f.id);
    const found = key.startsWith(SWEEP_KEY)
      ? null
      : correctiveChain(known, grouped.filter(chainable));
    const record = found
      ? chainRecord(id, found.finding, found.chain, policy.chainRewrite ?? "off")
      : null;
    if (record) chainRecords.push(record);
    const rewrite = rewritesSymbol(record) ? record : null;
    // A repeat chain on a test file sweeps the test files instead of a symbol rewrite (#2098).
    const testChain = record?.corrective === "test-sweep";
    const lastStep = (finding: Review["findings"][number]): string =>
      rewrite && finding.id === rewrite.findingId
        ? rewriteStep(
            chainSubject(rewrite),
            rewrite.chain.map((f) => f.id),
            rewrite.family && rewrite.symbols
              ? { name: rewrite.family, file: rewrite.file, symbols: rewrite.symbols }
              : undefined,
          )
        : finding.repeatOf
          ? repeatStep(finding.repeatOf)
          : SIBLING_STEP;
    const sweep = key.startsWith(`${SWEEP_KEY}tests\n`)
      ? testSweepStep(sweepFiles(grouped, base.profileId, base, root))
      : testChain
        ? testSweepStep(
            sweepTestFiles(grouped, root, base.profileId).filter((path) =>
              writable({ bases }).includes(path),
            ),
          )
        : key.startsWith(SWEEP_KEY)
          ? sweepStep(
              unique(grouped.flatMap(robustnessShapes)),
              sweepFiles(grouped, base.profileId, base, root),
              unique(grouped.flatMap((f) => (f.file ? [f.file] : []))),
            )
          : "";
    return {
      ...base,
      writes: mergeCorrectionWrites(
        bases
          .flatMap((b) => correctionWrites(b, root, state.expectedFiles))
          .filter((w) => availableTest(w.path)),
        state.expectedFiles,
      ),
      checkIds: unique(bases.flatMap((b) => correctionChecks(b, root))),
      id,
      title: rewrite
        ? `Rewrite ${chainSubject(rewrite)}: ${correctionTitle(grouped).replace(/^Correct: /, "")}`
        : correctionTitle(grouped),
      description: grouped
        .map(
          (finding) =>
            `${grouped.length > 1 ? `Finding ${finding.id}: ` : ""}${finding.claim}\nImpact: ${finding.impact}\nProposed fix: ${finding.suggestedFix}${reproStep(finding)}${(kind === "convergence" || reviewPass) && !sweep && !checkRunFinding(finding) ? lastStep(finding) : ""}`,
        )
        .join("\n\n")
        .concat(sweep),
      dependsOn: [],
      origin: kind,
      findingIds: ids,
      rationale: `${ids.length > 1 ? "Findings" : "Finding"} ${ids.join(", ")} against approved criteria`,
    };
  });
  const graph: TaskGraph = { ...state.graph, tasks: [...state.graph.tasks, ...additions] };
  const errors = validateTaskGraph(state.spec, graph);
  if (errors.length) throw new WorkflowFault("INVALID_REFERENCE", errors.join("\n"));
  const correction = CorrectionSchema.parse({
    schemaVersion: 1,
    parentDigest: state.approvalRoot,
    parentGraphHash: hashJson(state.graph),
    rule: "bounded-correction",
    newGraphHash: hashJson(graph),
    findingIds: findings.map((f) => f.id),
    taskIds: additions.map((t) => t.id),
    roundKind,
    round,
  });
  const artifact = store.artifact(
    runId,
    "correction",
    taskLevel
      ? `corrections/task-${additions[0]?.id ?? "T000"}.json`
      : `corrections/${roundKind}-${round}.json`,
    canonical(correction),
  );
  for (const record of chainRecords)
    store.artifact(runId, CHAIN_KIND, `${CHAIN_TASKS_DIR}${record.taskId}.json`, canonical(record));
  state.correctionHashes.push(artifact.content_hash);
  state.manifest.correctionHashes = [...state.correctionHashes];
  state.graph = graph;
  state.manifest.effectiveGraphHash = hashJson(graph);
  // The reviews this correction supersedes, with what they reviewed, for the next round.
  if (state.expectedFiles) {
    const { expectedFiles: files, snapshotId } = state;
    state.priorReviews = Object.fromEntries(
      Object.entries(state.reviews).map(([key, review]) => [key, { review, files, snapshotId }]),
    );
  }
  state.reviews = {};
  state.convergence = null;
  state.verificationState = "stale";
  store.syncTasks(runId, graph);
  for (const task of additions)
    for (const id of task.findingIds) store.findingStatus(runId, id, "confirmed", task.id);
  for (const finding of documents) store.findingStatus(runId, finding.id, "resolved");
  if (fresh) {
    const account = freshAccount(store, runId, state, roundKind, round, repeats, findings);
    for (const task of additions) {
      const artifact = store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/fresh-start.json`,
        canonical({ taskId: task.id, repeats, ...account }),
      );
      state.freshTasks[task.id] = artifact.id;
    }
  }
  if (taskLevel) store.addCorrectiveTasks(runId, additions.length);
  else countRound(additions.length);
}

/**
 * The host's account of the repair rounds a fresh-context correction replaces, from the journal:
 * each earlier corrective task, what it changed and the failures that came back. Nothing a worker
 * wrote about itself is used, so the fresh attempt does not inherit its reasoning.
 */
function freshAccount(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  roundKind: "repair" | "review" | "convergence",
  round: number,
  repeats: number,
  findings: Review["findings"],
): { summary: string; attempts: { taskId: string; title: string; changed: string[] }[] } {
  const attempts: { taskId: string; title: string; changed: string[] }[] = [];
  for (let earlier = round - repeats; earlier < round; earlier++) {
    const record = store.latestArtifact(runId, `corrections/${roundKind}-${String(earlier)}.json`);
    if (!record) continue;
    const { taskIds } = JSON.parse(store.readArtifact(runId, record.id)) as { taskIds: string[] };
    for (const taskId of taskIds) {
      const diff = store.latestArtifact(runId, `tasks/${taskId}/diff.json`);
      const changed = diff
        ? (JSON.parse(store.readArtifact(runId, diff.id)) as { changed?: string[] }).changed
        : [];
      attempts.push({
        taskId,
        title: state.graph?.tasks.find((t) => t.id === taskId)?.title ?? taskId,
        changed: changed ?? [],
      });
    }
  }
  const tried = attempts
    .map(
      (a) =>
        `${a.taskId} changed ${a.changed.length ? a.changed.slice(0, 8).join(", ") : "no file"}`,
    )
    .join("; ");
  const failing = findings.map((f) => f.claim).join("; ");
  return {
    summary: `${String(attempts.length)} earlier correction(s) of this failure (${tried || "no record"}) each left it as it was: ${failing}. Their approach did not work.`,
    attempts,
  };
}
