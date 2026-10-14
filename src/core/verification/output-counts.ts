import type { Check } from "../workflows/types.js";

/**
 * Counts read from check output, so an update run can compare a passing check with the same
 * check on the code it started from: a linter that exits 0 with more infos or warnings, or a test
 * suite that runs fewer tests, passes on its exit code alone (bench R03: new `useTemplate` infos).
 * Every parser recognizes one tool's summary line and returns null for anything else; a null on
 * either side means no comparison and never a finding.
 */
export type CountKind = "diagnostics" | "tests";

export interface OutputCount {
  /** The tool whose summary was read; a comparison needs the same tool on both sides. */
  tool: string;
  count: number;
}

/** Where the baseline counts are stored for the run. */
export const CHECK_BASELINE_PATH = "facts/check-baseline.json";

/** A test file by its path; a run that deletes one may lower the test count. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._](test|spec)\.[a-z]+$|_test\.go$/i;

/** Signature of a check's command: a check is compared only with a baseline of the same command. */
export const commandKey = (check: Pick<Check, "executable" | "args" | "cwd">): string =>
  JSON.stringify([check.executable, check.args, check.cwd]);

const sum = (output: string, pattern: RegExp): number | null => {
  let total: number | null = null;
  for (const match of output.matchAll(pattern)) total = (total ?? 0) + Number(match[1]);
  return total;
};

const lines = (output: string, pattern: RegExp): number =>
  output.split(/\r?\n/).filter((line) => pattern.test(line)).length;

/** The number of diagnostics a linter or type checker reported, by its summary line. */
export function diagnosticCount(output: string): OutputCount | null {
  // Biome: "Checked 12 files in 3ms. No fixes applied." then "Found 2 warnings." / "Found 3 infos."
  if (/\bChecked \d+ files? in\b/.test(output)) {
    const found = sum(output, /\bFound (\d+) (?:errors?|warnings?|infos?)\b/g);
    return { tool: "biome", count: found ?? 0 };
  }
  // ESLint: "✖ 5 problems (2 errors, 3 warnings)"
  const eslint = output.match(/✖ (\d+) problems? \(/);
  if (eslint) return { tool: "eslint", count: Number(eslint[1]) };
  // Ruff: "Found 3 errors." / "All checks passed!"
  if (/^All checks passed!/m.test(output)) return { tool: "ruff", count: 0 };
  // tsc: "Found 2 errors in 1 file." / "Found 1 error in src/a.ts:3"
  const tsc = output.match(/^Found (\d+) errors? in\b/m);
  if (tsc) return { tool: "tsc", count: Number(tsc[1]) };
  const ruff = output.match(/^Found (\d+) errors?\.?$/m);
  if (ruff) return { tool: "ruff", count: Number(ruff[1]) };
  // Clippy: "warning: `app` (bin "app") generated 3 warnings"; a clean build only says Finished.
  if (/^\s*Finished\b.*\btarget\(s\)/m.test(output) && /\b(?:Checking|Compiling)\b/.test(output))
    return {
      tool: "cargo",
      count: sum(output, /\bgenerated (\d+) warnings?\b/g) ?? 0,
    };
  // dotnet build: "    3 Warning(s)" and "    0 Error(s)"
  const warnings = output.match(/^\s*(\d+) Warning\(s\)/m);
  const errors = output.match(/^\s*(\d+) Error\(s\)/m);
  if (warnings && errors) return { tool: "dotnet", count: Number(warnings[1]) + Number(errors[1]) };
  return null;
}

/** The number of tests a runner ran, by its summary line. */
export function testCount(output: string): OutputCount | null {
  // bun test: "Ran 42 tests across 3 files."
  const bun = output.match(/^Ran (\d+) tests? across \d+ files?/m);
  if (bun) return { tool: "bun", count: Number(bun[1]) };
  // jest: "Tests:       1 failed, 12 passed, 13 total"
  const jest = output.match(/^Tests:\s+.*?\b(\d+) total\b/m);
  if (jest) return { tool: "jest", count: Number(jest[1]) };
  // vitest: "      Tests  12 passed (12)" / "Tests  1 failed | 11 passed (12)"
  const vitest = output.match(/^\s*Tests\s+.*\((\d+)\)\s*$/m);
  if (vitest) return { tool: "vitest", count: Number(vitest[1]) };
  // pytest: "===== 3 passed, 1 skipped in 0.12s ====="
  const pytest = output.match(/^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s\b.*=+\s*$/m);
  if (pytest) {
    const total = sum(
      pytest[1] ?? "",
      /(\d+) (?:passed|failed|skipped|xfailed|xpassed|errors?)\b/g,
    );
    if (total !== null) return { tool: "pytest", count: total };
  }
  // cargo test: "test result: ok. 4 passed; 0 failed; 1 ignored; ..." per test binary
  if (/^test result: /m.test(output)) {
    const passed = sum(output, /^test result: \w+\. (\d+) passed;/gm) ?? 0;
    const failed = sum(output, /; (\d+) failed;/g) ?? 0;
    const ignored = sum(output, /; (\d+) ignored;/g) ?? 0;
    return { tool: "cargo", count: passed + failed + ignored };
  }
  // dotnet test: "Passed!  - Failed: 0, Passed: 12, Skipped: 0, Total: 12" / "Total tests: 12"
  const dotnet = sum(output, /\bTotal(?: tests)?: (\d+)\b/g);
  if (dotnet !== null) return { tool: "dotnet", count: dotnet };
  // Maven surefire: "Tests run: 12, Failures: 0, Errors: 0, Skipped: 0" (the summary, no time).
  const maven = output.match(
    /^\[\w+\] Tests run: (\d+), Failures: \d+, Errors: \d+, Skipped: \d+\s*$/m,
  );
  if (maven) return { tool: "maven", count: Number(maven[1]) };
  // go test -v: one "=== RUN   TestName" per top-level test; without -v there is no count.
  const go = lines(output, /^=== RUN\s+[^/\s]+\s*$/);
  if (go) return { tool: "go", count: go };
  return null;
}

/** Reads the count of a kind from a check's output. */
export const outputCount = (kind: CountKind, output: string): OutputCount | null =>
  kind === "diagnostics" ? diagnosticCount(output) : testCount(output);

/**
 * Every count a check's output has: a build-and-test command can report both diagnostics and
 * tests. A failing run's test count is not kept, since some tests never ran.
 */
export function outputCounts(output: string, passed: boolean): BaselineCount[] {
  const kinds: CountKind[] = passed ? ["diagnostics", "tests"] : ["diagnostics"];
  return kinds.flatMap((kind) => {
    const count = outputCount(kind, output);
    return count ? [{ kind, ...count }] : [];
  });
}

export interface BaselineCount extends OutputCount {
  kind: CountKind;
}

/**
 * How a passing check falls behind the code the run started from: more diagnostics, or fewer
 * tests unless the run deletes test files. Null when the counts cannot be compared or held.
 */
export function baselineRegression(
  baseline: BaselineCount,
  output: string,
  deletesTests = false,
): string | null {
  const now = outputCount(baseline.kind, output);
  if (!now || now.tool !== baseline.tool) return null;
  if (baseline.kind === "diagnostics" && now.count > baseline.count)
    return `diagnostics rose from ${baseline.count} to ${now.count} against the code the run started from (${now.tool}); fix the new ones, the check passing on its exit code is not enough`;
  if (baseline.kind === "tests" && now.count < baseline.count && !deletesTests)
    return `tests fell from ${baseline.count} to ${now.count} against the code the run started from (${now.tool}); restore the existing tests the change removed or skipped`;
  return null;
}

/** A path into one of BAKED's worktrees, `.../.baked/worktrees/RUN/main` or `.../RUN/T005`. */
const WORKTREE_PATH =
  /(?:[A-Za-z]:)?(?:[\\/][^\\/\s"'`()<>:]+)*[\\/]\.baked[\\/]worktrees[\\/][^\\/\s"'`()<>:]+[\\/][^\\/\s"'`()<>:]+/g;

/**
 * The output of a failing check with what changes between two runs of the same failure left out
 * (colours, durations, timestamps, the workspace path), so the checks stage can tell a required
 * check that still fails exactly as it did on the code the run started from (#934). Every
 * worktree path counts as the workspace: the baseline is measured in the run worktree and a later
 * check may run in a task worktree (mouse-mover-update 3d7389cf, #1055).
 */
export function failureSignature(output: string, root: string): string {
  const project = root.replace(/[\\/]\.baked[\\/]worktrees[\\/].*$/, "");
  const text = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(WORKTREE_PATH, "<root>")
    .split(root)
    .join("<root>")
    .split(project)
    .join("<root>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds|m)\b/g, "<duration>")
    .replace(/\[\d+(\.\d+)?(ms|s)\]/g, "<duration>")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}
