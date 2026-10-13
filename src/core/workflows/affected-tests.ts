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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isStaticCheck } from "./check-policy.js";
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
  if (PY_FILE.test(name)) return /^test_.*\.py$|_test\.py$/.test(name);
  if (!JS_FILE.test(name)) return false;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)(__tests__)\//.test(path);
}

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

const programName = (executable: string): string =>
  executable
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();

/** Keeps a test runner's own flags and drops the paths or patterns a check named. */
const flagsOnly = (args: string[]): string[] => args.filter((arg) => arg.startsWith("-"));

/**
 * A command that runs only `tests` with the runner of one of the policy's test checks, or null
 * when no check runs a test runner that takes test files (`bun test`, `vitest`, `jest`,
 * `node --test`, `pytest`, `go test`). Package scripts (`npm test`, `bun run test`) are not
 * used: what they pass on is up to the script.
 */
export function affectedTestCheck(checks: readonly Check[], tests: string[]): Check | null {
  if (tests.length === 0) return null;
  const files = tests.map((t) => `./${t}`);
  for (const check of checks) {
    if (isStaticCheck(check) || check.cwd !== ".") continue;
    const name = programName(check.executable);
    const args = check.args;
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
    } else if (name === "go" && args[0] === "test") {
      prefix = ["test", ...flagsOnly(args.slice(1))];
      targets = [
        ...new Set(
          tests.filter((t) => GO_FILE.test(t)).map((t) => `./${dirname(t).replaceAll("\\", "/")}`),
        ),
      ];
    }
    if (!prefix || targets.length === 0) continue;
    return {
      ...check,
      id: `${check.id}-affected`,
      args: [...prefix, ...targets],
      required: false,
      scope: "task",
      writes: [],
    };
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
