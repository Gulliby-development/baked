/**
 * Affected tests (#634): the existing test files that exercise the files a task changes, and the
 * command that runs only them.
 *
 * Telling an agent to "run the tests" raises regressions; handing it the tests that reach the
 * files it edits lowers them (TDAD, arXiv 2603.17973: 6.08% baseline regressions, 1.82% with a
 * source-to-test map). The map comes from the import statements of the workspace's JavaScript,
 * TypeScript and Python files, followed backwards from the task's files to the tests that reach
 * them, plus the naming conventions that pair a source with its test (`store.ts` with
 * `store.test.ts`, `store.py` with `test_store.py`, every `_test.go` file of a Go package).
 *
 * The module is pure over the file system: it reads files and returns paths and commands; the
 * scheduler decides when to run them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isTestFile as isLanguageTestFile, isTestFileAt } from "../intelligence/language-traits.js";
import { INLINE_ROWS_BEGIN, INLINE_ROWS_CLASS } from "./acceptance-rows-inline.js";
import { isStaticCheck } from "./check-policy.js";
import { PESTER_RUN, pesterOn } from "./pester.js";
import { testthatOn, testthatRun } from "./r-tools.js";
import { testGateFlags, withGateFlags } from "./test-gates.js";
import { toolchainCommand } from "./toolchain.js";
import type { Check } from "./types.js";

/** At most this many tests go to an attempt; the nearest ones (fewest import hops) first. */
export const MAX_AFFECTED_TESTS = 24;
/** Import hops followed back from a changed file: the test that imports a module that imports it. */
const MAX_HOPS = 3;
/** A workspace larger than this is not scanned; the attempt goes without the map. */
const MAX_SCANNED_FILES = 6000;
const MAX_FILE_BYTES = 512 * 1024;

const SKIPPED_DIRS = new Set([
  ".git",
  ".baked",
  "baked",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "vendor",
]);

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;
const PY_FILE = /\.py$/;
const GO_FILE = /\.go$/;
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Whether a workspace path is a test file of a supported ecosystem. */
export function isTestFile(path: string): boolean {
  const name = posix.basename(path);
  if (GO_FILE.test(name)) return name.endsWith("_test.go");
  // Django keeps an app's tests in `tests.py` (#1683); pytest runs a file it is given by path.
  if (PY_FILE.test(name)) return /^test_.*\.py$|_test\.py$|^tests\.py$/.test(name);
  if (!JS_FILE.test(name)) return false;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)(__tests__)\//.test(path);
}

const CS_FILE = /\.cs$/;
const RS_FILE = /\.rs$/;
const JVM_FILE = /\.(?:java|kt)$/;
const PESTER_FILE = /\.Tests\.ps1$/i;
const TESTTHAT_FILE = /(?:^|\/)tests\/testthat\/test[-_]?[^/]*\.r$/i;

/**
 * Whether a path is a test file of a compiled stack the written-tests check runs (#1396): a C#
 * file named `*Test(s).cs` or under a `Tests` or `*.Tests` directory, a Rust integration test
 * directly in a `tests/` directory, or a Java or Kotlin file under `src/test/`.
 */
export function isCompiledTestFile(path: string): boolean {
  const normal = path.replaceAll("\\", "/");
  const parts = normal.split("/");
  const name = parts.at(-1) ?? "";
  if (CS_FILE.test(name))
    return (
      !parts.some((part) => part === "obj" || part === "bin") &&
      (/Tests?\.cs$/.test(name) ||
        // `App.Tests/`, `App.UnitTests/`, `App.IntegrationTests/` (#1683).
        parts
          .slice(0, -1)
          .some((part) =>
            /(?:^|\.)(?:unit|integration|functional|acceptance|e2e)?tests?$/i.test(part),
          ))
    );
  if (RS_FILE.test(name)) return parts.at(-2) === "tests";
  return JVM_FILE.test(name) && /(?:^|\/)src\/test\//.test(normal);
}

/** Whether a task's written test file is one the written-tests check can run. */
export const isWrittenTestFile = (path: string): boolean =>
  isTestFile(path) ||
  isCompiledTestFile(path) ||
  PESTER_FILE.test(path) ||
  TESTTHAT_FILE.test(path);

const DOC_EXTENSION = /\.(?:md|mdx|markdown|rst|adoc)$/i;
const DOC_NAME = /^(?:readme|changelog|license|licence|notice|authors|contributing)(?:\.\w+)?$/i;

/** Whether a path is documentation: Markdown, reStructuredText, AsciiDoc, or a README-like file. */
export function isDocumentationPath(path: string): boolean {
  const name = posix.basename(path.replaceAll("\\", "/"));
  return DOC_EXTENSION.test(name) || DOC_NAME.test(name);
}

/**
 * Whether another task's unfinished write keeps a task's written tests from running on their own:
 * it may change code or data the tests load. Documentation does not, unless the test task reads
 * it (#1408: a README task after the tests suppressed the check and a hang reached the feature
 * gate). A compiled test project builds every test file in it, so there another task's test file
 * holds the check back too (#1396).
 */
export function holdsWrittenTests(
  path: string,
  compiled: boolean,
  reads: readonly string[] = [],
): boolean {
  if (isDocumentationPath(path) && !reads.includes(path)) return false;
  return compiled ? !isTestFile(path) : !isWrittenTestFile(path);
}

/** The class a C#, Java or Kotlin test file declares, by the file-per-class convention. */
const className = (path: string): string =>
  posix.basename(path.replaceAll("\\", "/")).replace(/\.\w+$/, "");

/** The fully qualified JVM class of a file under `src/test/java` or `src/test/kotlin`. */
const jvmClass = (path: string): string => {
  const normal = path.replaceAll("\\", "/").replace(/\.\w+$/, "");
  const at = normal.search(/src\/test\/(?:java|kotlin)\//);
  return at === -1 ? className(path) : normal.slice(at).split("/").slice(3).join(".");
};

function walk(root: string): string[] | null {
  const files: string[] = [];
  const stack = [""];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(rel);
      } else if (
        entry.isFile() &&
        (JS_FILE.test(entry.name) || PY_FILE.test(entry.name) || GO_FILE.test(entry.name)) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(rel);
        if (files.length > MAX_SCANNED_FILES) return null;
      }
    }
  }
  return files.sort();
}

function read(root: string, path: string): string {
  try {
    const full = join(root, path);
    if (statSync(full).size > MAX_FILE_BYTES) return "";
    return readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

const JS_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s*)["']([^"'\n]+)["']/gm;

/** The workspace files a JavaScript or TypeScript file imports by a relative path. */
function jsImports(path: string, text: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(JS_SPECIFIER)) {
    const specifier = match[1] as string;
    if (!specifier.startsWith(".")) continue;
    const base = posix.normalize(posix.join(posix.dirname(path), specifier));
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [
      base,
      ...JS_EXTENSIONS.map((ext) => `${stem}${ext}`),
      ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ];
    const hit = candidates.find((candidate) => known.has(candidate));
    if (hit) out.push(hit);
  }
  return out;
}

/** Module name to file for Python: `pkg/mod.py` and `src/pkg/mod.py` both answer `pkg.mod`. */
function pythonModules(files: string[]): Map<string, string> {
  const modules = new Map<string, string>();
  for (const file of files) {
    if (!PY_FILE.test(file)) continue;
    const parts = file.replace(/\.py$/, "").split("/");
    if (parts[parts.length - 1] === "__init__") parts.pop();
    for (let start = 0; start < parts.length; start++) {
      const name = parts.slice(start).join(".");
      if (name && !modules.has(name)) modules.set(name, file);
    }
  }
  return modules;
}

const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+([^\n#]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w., ]+)/gm;

function pyImports(path: string, text: string, modules: Map<string, string>): string[] {
  const out: string[] = [];
  const resolve = (name: string): void => {
    const hit = modules.get(name);
    if (hit) out.push(hit);
  };
  const packageOf = (dots: number): string[] => {
    const parts = path.replace(/\.py$/, "").split("/");
    return parts.slice(0, Math.max(0, parts.length - dots));
  };
  for (const match of text.matchAll(PY_FROM)) {
    let source = match[1] as string;
    const names = (match[2] as string)
      .replace(/[()]/g, "")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0] ?? "")
      .filter(Boolean);
    const dots = source.match(/^\.*/)?.[0].length ?? 0;
    if (dots) source = [...packageOf(dots), source.slice(dots)].filter(Boolean).join(".");
    resolve(source);
    for (const name of names) resolve(source ? `${source}.${name}` : name);
  }
  for (const match of text.matchAll(PY_IMPORT))
    for (const name of (match[1] as string).split(","))
      resolve(name.trim().split(/\s+as\s+/)[0] ?? "");
  return out;
}

/** The file name a test pairs with by convention: `store` for `store.test.ts` and `test_store.py`. */
function pairedStem(path: string): string {
  return posix
    .basename(path)
    .replace(/\.(?:test|spec)(?=\.[cm]?[jt]sx?$)/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "");
}

export interface AffectedTest {
  path: string;
  /** Import hops from the changed file; 0 for a test paired by name or a changed test itself. */
  hops: number;
}

/**
 * The existing test files that reach `sources` (workspace-relative paths), nearest first, at most
 * MAX_AFFECTED_TESTS. Empty when none do or the workspace is too large to scan.
 */
export function affectedTests(root: string, sources: string[]): AffectedTest[] {
  const files = walk(root);
  if (!files || sources.length === 0) return [];
  const known = new Set(files);
  const modules = pythonModules(files);
  // Reverse edges: file -> the files that import it.
  const importers = new Map<string, Set<string>>();
  for (const file of files) {
    if (GO_FILE.test(file)) continue;
    const text = read(root, file);
    if (!text) continue;
    const targets = JS_FILE.test(file)
      ? jsImports(file, text, known)
      : pyImports(file, text, modules);
    for (const target of targets) {
      if (target === file) continue;
      const set = importers.get(target) ?? new Set<string>();
      set.add(file);
      importers.set(target, set);
    }
  }
  const found = new Map<string, number>();
  const note = (path: string, hops: number): void => {
    if (isTestFile(path) && known.has(path) && (found.get(path) ?? Number.POSITIVE_INFINITY) > hops)
      found.set(path, hops);
  };
  const tests = files.filter(isTestFile);
  for (const source of sources) {
    note(source, 0);
    if (GO_FILE.test(source)) {
      // A Go package's tests are every _test.go file of its directory.
      for (const test of tests)
        if (test.endsWith("_test.go") && posix.dirname(test) === posix.dirname(source))
          note(test, 0);
      continue;
    }
    const stem = pairedStem(source);
    for (const test of tests)
      if (!GO_FILE.test(test) && pairedStem(test) === stem && test !== source) note(test, 0);
    let frontier = [source];
    const seen = new Set(frontier);
    for (let hop = 1; hop <= MAX_HOPS && frontier.length; hop++) {
      const next: string[] = [];
      for (const file of frontier)
        for (const importer of importers.get(file) ?? []) {
          if (seen.has(importer)) continue;
          seen.add(importer);
          note(importer, hop);
          if (!isTestFile(importer)) next.push(importer);
        }
      frontier = next;
    }
  }
  return [...found]
    .map(([path, hops]) => ({ path, hops }))
    .sort((a, b) => a.hops - b.hops || a.path.localeCompare(b.path))
    .slice(0, MAX_AFFECTED_TESTS);
}

/** The options of `python -m unittest` that take no value. */
const UNITTEST_FLAG = /^-(?:[vqfbck]|-(?:verbose|quiet|failfast|buffer|catch|locals))$/;

/** Keeps a test runner's own flags and drops the paths or patterns a check named. */
const flagsOnly = (args: string[]): string[] =>
  args.filter(
    (arg, i) =>
      arg.startsWith("-") ||
      /^(?:--(?:timeout|testTimeout|test-timeout|config)|-c)$/.test(args[i - 1] ?? ""),
  );

/**
 * A command that runs only `tests` with the runner of one of the policy's test checks, or null
 * when no check runs a test runner that takes test files (`bun test`, `vitest`, `jest`,
 * `node --test`, `pytest`, `go test`). Package scripts (`npm test`, `bun run test`) are not
 * used: what they pass on is up to the script.
 */
export function affectedTestCheck(
  checks: readonly Check[],
  all: string[],
  rows: ReadonlySet<string> = new Set(),
  gates: ReadonlyMap<string, string[]> = new Map(),
): Check | null {
  if (all.length === 0) return null;
  for (const check of checks) {
    if (isStaticCheck(check)) continue;
    // A check in a subdirectory (`cwd: "api"`) runs the tests under it, by paths relative to it.
    const base = check.cwd === "." ? "" : `${check.cwd.replace(/\/+$/, "")}/`;
    const tests = all.filter((t) => t.startsWith(base)).map((t) => t.slice(base.length));
    if (!tests.length) continue;
    const files = tests.map((t) => `./${t}`);
    const { program: name, args, launch } = toolchainCommand(check.executable, check.args);
    const js = files.filter((f) => JS_FILE.test(f));
    const py = files.filter((f) => PY_FILE.test(f));
    let prefix: string[] | null = null;
    let targets: string[] = [];
    if (name === "bun" && args[0] === "test") {
      prefix = ["test", ...flagsOnly(args.slice(1))];
      targets = js;
    } else if ((name === "npx" || name === "bunx") && /^(vitest|jest)$/.test(args[0] ?? "")) {
      const runner = args[0] as string;
      const rest = flagsOnly(args.slice(1));
      prefix = runner === "vitest" ? [runner, "run", ...rest] : [runner, ...rest];
      targets = js;
    } else if (name === "vitest") {
      prefix = ["run", ...flagsOnly(args)];
      targets = js;
    } else if (name === "jest" || (name === "node" && args.includes("--test"))) {
      prefix = flagsOnly(args);
      targets = js;
    } else if (name === "pytest" || name === "py.test") {
      prefix = flagsOnly(args);
      targets = py;
    } else if (/^python[\d.]*$/.test(name) && args[0] === "-m" && args[1] === "pytest") {
      prefix = ["-m", "pytest", ...flagsOnly(args.slice(2))];
      targets = py;
    } else if (/^python[\d.]*$/.test(name) && args[0] === "-m" && args[1] === "unittest") {
      // Discovery options (`discover -s tests -p ...`) take values and do not apply to named files.
      prefix = ["-m", "unittest", ...args.slice(2).filter((arg) => UNITTEST_FLAG.test(arg))];
      targets = py;
    } else if (name === "go" && args[0] === "test") {
      prefix = withGateFlags(["test", ...flagsOnly(args.slice(1))], gates.get("go"), 1);
      targets = [
        ...new Set(
          tests.filter((t) => GO_FILE.test(t)).map((t) => `./${dirname(t).replaceAll("\\", "/")}`),
        ),
      ];
    }
    if (!prefix) {
      const compiled = compiledTestArgs(
        name,
        args,
        tests.filter((t) => isCompiledTestFile(t) || PESTER_FILE.test(t) || TESTTHAT_FILE.test(t)),
        new Set(tests.filter((t) => rows.has(`${base}${t}`))),
      );
      const gated =
        compiled && name === "cargo"
          ? withGateFlags(compiled, gates.get("cargo"), compiled[0] === "nextest" ? 2 : 1)
          : compiled;
      const command = gated && launch(gated);
      if (!command) continue;
      return {
        ...check,
        ...command,
        id: `${check.id}-affected`,
        required: false,
        scope: "task",
        writes: [],
        requireTests: true,
      };
    }
    const command = targets.length ? launch([...prefix, ...targets]) : null;
    if (!command) continue;
    return {
      ...check,
      ...command,
      id: `${check.id}-affected`,
      required: false,
      scope: "task",
      writes: [],
      requireTests: true,
    };
  }
  return null;
}

/**
 * The arguments that run only `tests` with a compiled stack's test check, or null (#1396):
 * `dotnet test --filter` on the test classes, `cargo test --test` on integration test files,
 * maven's `test` goal with `-Dtest` and gradle's `--tests`. dieodds (C#, bench round 39) had no
 * task check for its test tasks: a wrong expectation surfaced at the feature gate and took five
 * correctives (1.76M tokens).
 */
/**
 * `rows`: the files that hold an inline acceptance rows block, whose class (#1763) a filter by
 * the file's class would leave out (#1617).
 */
function compiledTestArgs(
  name: string,
  args: string[],
  tests: string[],
  rows: ReadonlySet<string> = new Set(),
): string[] | null {
  if (name === "dotnet" && args[0] === "test") {
    const classes = tests
      .filter((t) => CS_FILE.test(t))
      .flatMap((t) => [
        className(t),
        ...(rows.has(t) ? [INLINE_ROWS_CLASS.xunit(className(t))] : []),
      ]);
    if (!classes.length || args.includes("--filter")) return null;
    return [...args, "--filter", classes.map((c) => `FullyQualifiedName~${c}.`).join("|")];
  }
  if (name === "cargo" && args[0] === "nextest" && args[1] === "run") {
    const files = tests.filter((t) => RS_FILE.test(t)).map(className);
    if (!files.length) return null;
    return ["nextest", "run", ...flagsOnly(args.slice(2)), ...files.flatMap((f) => ["--test", f])];
  }
  if (name === "cargo" && args[0] === "test") {
    const files = tests.filter((t) => RS_FILE.test(t)).map(className);
    if (!files.length) return null;
    const end = args.indexOf("--");
    const head = flagsOnly(end === -1 ? args.slice(1) : args.slice(1, end));
    return [
      "test",
      ...head,
      ...files.flatMap((file) => ["--test", file]),
      ...(end === -1 ? [] : args.slice(end)),
    ];
  }
  // Pester takes its test files in its configuration's `Run.Path`; only the gate's own command is
  // narrowed, since a project's own `-Command` script may do more than run Pester (#1498).
  if (/^(?:pwsh|powershell)$/i.test(name)) {
    const files = tests.filter((t) => PESTER_FILE.test(t)).map((t) => `./${t}`);
    const at = args.indexOf(PESTER_RUN);
    if (!files.length || at < 0 || args[at - 1] !== "-Command") return null;
    return [...args.slice(0, at), pesterOn(files), ...args.slice(at + 1)];
  }
  // testthat selects files by its `filter` on their names; only the gate's own expression is
  // narrowed, since a project's own `-e` script may do more than run testthat (#1500).
  if (/^rscript$/i.test(name)) {
    const files = tests.filter((t) => TESTTHAT_FILE.test(t));
    const at = args.findIndex((arg) => arg === testthatRun(true) || arg === testthatRun(false));
    if (!files.length || at < 1 || args[at - 1] !== "-e") return null;
    return [
      ...args.slice(0, at),
      testthatOn(files, args[at] === testthatRun(true)),
      ...args.slice(at + 1),
    ];
  }
  const classes = tests
    .filter((t) => JVM_FILE.test(t))
    .flatMap((t) => [jvmClass(t), ...(rows.has(t) ? [INLINE_ROWS_CLASS.junit(jvmClass(t))] : [])]);
  if (!classes.length) return null;
  if (
    (name === "mvn" || name === "mvnw") &&
    args.some((arg) => /^(?:test|verify|install|package)$/.test(arg))
  ) {
    if (args.some((arg) => arg.startsWith("-Dtest="))) return null;
    return [
      ...flagsOnly(args),
      "test",
      `-Dtest=${classes.join(",")}`,
      "-Dsurefire.failIfNoSpecifiedTests=false",
    ];
  }
  if (
    (name === "gradle" || name === "gradlew") &&
    args.some((arg) => /^(?:test|check|build)$/.test(arg))
  ) {
    if (args.includes("--tests")) return null;
    return [...flagsOnly(args), "test", ...classes.flatMap((c) => ["--tests", c])];
  }
  return null;
}

/** The tests that reach a task's write paths and the check that runs only them. */
export function affectedTestsFor(
  root: string,
  checks: readonly Check[],
  writes: readonly { path: string }[],
): { tests: AffectedTest[]; check: Check | null } {
  const tests = affectedTests(
    root,
    writes.map((w) => w.path),
  );
  return {
    tests,
    check: affectedTestCheck(
      checks,
      tests.map((t) => t.path),
    ),
  };
}

/** The gate flags the test files declare (#1832): a Cargo feature, a Go build tag. */
function gateFlags(root: string, files: readonly string[]): Map<string, string[]> {
  return testGateFlags(
    files.flatMap((path) => {
      try {
        return [{ path, text: readFileSync(join(root, path), "utf8") }];
      } catch {
        return [];
      }
    }),
  );
}

/** The JUnit and xUnit test files that hold an inline acceptance rows block. */
function inlineRowFiles(root: string, files: readonly string[]): Set<string> {
  return new Set(
    files.filter((path) => {
      if (!/\.(?:java|cs)$/.test(path)) return false;
      try {
        return INLINE_ROWS_BEGIN.test(readFileSync(join(root, path), "utf8"));
      } catch {
        return false;
      }
    }),
  );
}

/** How long the test files a task wrote may run on their own after it (#1271). */
export const WRITTEN_TESTS_TIMEOUT_MS = 60_000;

/**
 * The check that runs only the test files a task writes, required and with a short timeout
 * (#1271), or null when no test check of the policy takes test files.
 */
export function writtenTestsCheck(
  root: string,
  checks: readonly Check[],
  writes: readonly { path: string; action: string }[],
  text = "",
): Check | null {
  const files = writes
    .filter((w) => w.action !== "delete" && isWrittenTestFile(w.path))
    .map((w) => w.path)
    .filter((path) => existsSync(join(root, path)))
    // A source file named like a test (`PermTest.cs` without a test attribute) has no tests to run (#1848).
    .filter((path) => !isLanguageTestFile(path) || isTestFileAt(root, path));
  const gate = affectedTestCheck(
    checks,
    files,
    inlineRowFiles(root, files),
    gateFlags(root, files),
  );
  if (!gate) return null;
  const minCases = requiredCases(text);
  const timeoutMs = Math.min(gate.timeoutMs, WRITTEN_TESTS_TIMEOUT_MS);
  return {
    ...gate,
    id: gate.id.replace(/-affected$/, "-written"),
    required: true,
    timeoutMs,
    onTimeout: "failed",
    ...(minCases !== undefined ? { minCases } : {}),
  };
}

/**
 * The `-written` check that will run the test files in `writes`, known before they exist, so a
 * planned task can be told it in its input (#1518): its ID, the files and its timeout.
 */
export function plannedWrittenTests(
  checks: readonly Check[],
  writes: readonly { path: string; action: string }[],
): { id: string; paths: string[]; timeoutMs: number } | null {
  const paths = writes
    .filter((w) => w.action !== "delete" && isWrittenTestFile(w.path))
    .map((w) => w.path);
  const gate = paths.length ? affectedTestCheck(checks, paths) : null;
  if (!gate) return null;
  return {
    id: gate.id.replace(/-affected$/, "-written"),
    paths,
    timeoutMs: Math.min(gate.timeoutMs, WRITTEN_TESTS_TIMEOUT_MS),
  };
}

const CASE_COUNT =
  /\bat least\s+(\d{1,3}(?:,\d{3})+|\d+)\s+(?:(?:randomly|independently|random(?:ly)?|generated|distinct|different)\s+){0,2}(?:inputs?|cases?|samples?|runs?|examples?|iterations?|scenarios?|datasets?|values?)\b/gi;
const PROPERTY_TEXT =
  /\bpropert(?:y|ies)\b|\bfast-check\b|\bhypothesis\b|\bgenerated inputs?\b|\bfuzz/i;
/** The property gate's own minimum of generated inputs (`quality/properties.ts`). */
export const DEFAULT_MIN_CASES = 100;

/**
 * The generated inputs a task's text requires of its tests: the largest "at least N inputs" it
 * names, or the property gate's 100 for a property test task that names no number, or undefined.
 * url-shortener 4c3137f0 T003 (bench round 36, #1367) planned "at least 100 generated inputs per
 * criterion"; the timeout note said "tens", the corrective cut the tests to 32 cases and the
 * review asked for 100 again: three correctives, 3.14M tokens.
 */
export function requiredCases(text: string): number | undefined {
  const counts = [...text.matchAll(CASE_COUNT)].map((match) =>
    Number((match[1] ?? "").replace(/,/g, "")),
  );
  const most = Math.max(0, ...counts.filter((count) => Number.isFinite(count)));
  if (most > 0) return most;
  return PROPERTY_TEXT.test(text) ? DEFAULT_MIN_CASES : undefined;
}

/** The text of a task that may name how many generated inputs its tests need. */
export function taskCaseText(task: { title: string; description: string }): string {
  return `${task.title}\n${task.description}`;
}
