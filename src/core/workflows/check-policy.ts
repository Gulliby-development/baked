import { posix } from "node:path";
import { isCodeFile } from "../intelligence/language-traits.js";
import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "./errors.js";
import { isTestCodePath } from "./quality/duplication.js";
import type { RunPolicy, TaskGraph } from "./schemas.js";
import { toolchainCommand } from "./toolchain.js";
import type { Check, Task } from "./types.js";

export function validateChecks(workspace: string, policy: RunPolicy, graph?: TaskGraph): void {
  const ids = new Set<string>();
  for (const check of policy.checks) {
    if (ids.has(check.id))
      throw new WorkflowFault("INVALID_DEFINITION", `Duplicate check ID ${check.id}`);
    ids.add(check.id);
    if (check.cwd !== ".") workspacePath(workspace, check.cwd);
    if (
      [check.executable, ...check.args].some((value) => value.includes("\0")) ||
      check.envNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    )
      throw new WorkflowFault("INVALID_DEFINITION", `Invalid process definition ${check.id}`);
    for (const output of check.writes) {
      workspacePath(workspace, output);
      if (
        /^(\.git|\.baked|baked|specs)(\/|$)|(^|\/)(AGENTS\.md|CLAUDE\.md|constitution\.md|package\.json|.*lock.*|tsconfig.*|biome.*|\.env(?:\..*)?)$/i.test(
          output,
        ) ||
        graph?.tasks.some((task) =>
          task.writes.some(
            (w) =>
              w.path.toLowerCase() === output.toLowerCase() ||
              w.path.toLowerCase().startsWith(`${output.toLowerCase()}/`),
          ),
        )
      )
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Generated output overlaps source/configuration: ${output}`,
        );
    }
  }
}

/** Commands that analyze source without running it: linters, formatters and type checkers. */
const STATIC_COMMAND =
  /\b(?:lint|eslint|biome|ruff|flake8|pylint|clippy|vet|fmt|gofmt|format|prettier|mypy|pyright|tsc|typecheck|check|ScriptAnalyzer)\b|\b(?:dart|flutter)\s+analyze\b/i;

/** Source code a linter or formatter reads: any written file that is not documentation or data. */
export const isCodePath = (path: string): boolean => isCodeFile(path);

/** The code files a task creates or modifies. */
export const writtenCodePaths = (task: Pick<Task, "writes">): string[] =>
  task.writes.filter((w) => w.action !== "delete" && isCodePath(w.path)).map((w) => w.path);

/**
 * Whether a feature-scope check analyzes source files statically (it names a fixer or runs a
 * linter, formatter or type checker). Test suites are not: they need other tasks' code to pass.
 */
export const isStaticCheck = (check: Check): boolean =>
  Boolean(check.fix) ||
  (!runsAggregateTarget(check) &&
    STATIC_COMMAND.test([check.id, check.executable, ...check.args].join(" ")));

/** Task runners whose targets the gate fallback offers (#1488). */
const TASK_RUNNER = /^(?:make|gmake|mingw32-make|just|task)$/;

/**
 * A task runner's `check` target: in the projects the fallback serves it is the test suite
 * (autotools' `make check`) or tests plus lint, not a linter, so it is no file-local static
 * check that runs after every code task and is corrected as diagnostics only (#1680).
 */
function runsAggregateTarget(check: Pick<Check, "executable" | "args">): boolean {
  const program = (check.executable.replaceAll("\\", "/").split("/").at(-1) ?? "")
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
  return TASK_RUNNER.test(program) && check.args.some((arg) => arg.toLowerCase() === "check");
}

/**
 * Static checks that analyze a whole compilation unit: they resolve every module, import and
 * type of the project, so in a task's own worktree they fail until the sibling tasks' files exist
 * (bench round 08, commitbump: `cargo clippy` E0583 for a `mod parse;` whose file another task
 * writes, and 2.2M tokens of repairs that could not pass). They run in the checks stage after
 * integration, not per task. `cargo fmt` and `rustfmt` count too: they follow every `mod x;` and
 * fail on a module file a later task writes (bench round 11, mdrefs: a skeleton task blocked on
 * "failed to resolve mod"). Other formatters and file-local linters (gofmt, ruff, biome, eslint)
 * read one file at a time and stay per task, as do `mix format`, `dart format` and `zig fmt`;
 * `dart analyze` and `flutter analyze` resolve every import, so they are whole-unit (#1753).
 * SQLFluff with the dbt templater compiles the whole dbt project (`ref()` to other models), so its
 * gate, `sqlfluff-dbt`, is too (#1499).
 */
const WHOLE_UNIT_COMMAND =
  /\b(?:clippy|vet|tsc|typecheck|mypy|pyright|rustfmt|sqlfluff-dbt)\b|\bcargo\s+(?:check|fmt)\b|\b(?:dart|flutter)\s+analyze\b/i;

export const isWholeUnitCheck = (check: Check): boolean =>
  WHOLE_UNIT_COMMAND.test([check.id, check.executable, ...check.args].join(" "));

/**
 * Whole-unit formatters (`cargo fmt`, `rustfmt`). Before integration they report every other
 * task's unformatted files, and the checks stage applies their fixer to the run's files after
 * integration, so a planned task's own run of one only adds a failing check and its output to the
 * agent's context (bench round 13, mdrefs: 9 of 15 fmt runs failed on other tasks' files, #842).
 */
export const isWholeUnitFormatter = (check: Check): boolean =>
  isWholeUnitCheck(check) &&
  /\b(?:rustfmt|fmt|format)\b/i.test([check.id, check.executable, ...check.args].join(" "));

/**
 * The checks that run for a task: the task-scope ones it names and the file-local static feature
 * ones covering its code. Whole-unit checks are left to the checks stage.
 */
export const coveringChecks = (policy: RunPolicy, task: Pick<Task, "writes">): Check[] =>
  writtenCodePaths(task).length
    ? policy.checks.filter((c) => c.scope === "feature" && isStaticCheck(c) && !isWholeUnitCheck(c))
    : [];

/**
 * Gives every task that writes source code the static feature checks (lint, format) that cover
 * its files, so a lint error shows in the task that wrote the file and not in a repair task after
 * the test tasks have run (bench round 03, md-site and zoneslot). The planner's own check IDs stay.
 */
export function withCoveringChecks(graph: TaskGraph, policy: RunPolicy): TaskGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const added = coveringChecks(policy, task)
        .map((c) => c.id)
        .filter((id) => !task.checkIds.includes(id));
      return added.length ? { ...task, checkIds: [...task.checkIds, ...added] } : task;
    }),
  };
}

/** The checks the host runs after a task: the task-scope checks it names, plus the covering static ones. */
export const taskCheckList = (policy: RunPolicy, task: Task): Check[] => {
  const covering = new Set(coveringChecks(policy, task).map((c) => c.id));
  return policy.checks.filter(
    (c) => task.checkIds.includes(c.id) && (c.scope === "task" || covering.has(c.id)),
  );
};

/**
 * The command that applies a check's fixer to one file. Most fixers take the file as a last
 * argument (`ruff check --fix <file>`, `biome check --write <file>`), but the whole-project
 * formatters do not, and an unaccepted argument makes them format nothing (bench round 08,
 * commitbump: `cargo fmt src/main.rs` answers "unexpected argument", 17 of 19 fmt checks stayed
 * red): `cargo fmt` takes file arguments only after `--`, `go fmt` takes packages (`gofmt -w`
 * takes files) and `dotnet format` takes a project and selects files with `--include`.
 */
/**
 * The fixers of a check in the order they run: the safe tier, then the unsafe tier (#395), which
 * applies only beside a safe one.
 */
export function fixerTiers(check: {
  fix?: { executable: string; args: string[] };
  fixUnsafe?: { executable: string; args: string[] };
}): { executable: string; args: string[] }[] {
  if (!check.fix) return [];
  return check.fixUnsafe ? [check.fix, check.fixUnsafe] : [check.fix];
}

/**
 * The files a fixer tier of `check` runs on, of `paths`: the unsafe tier of a check scoped to
 * tests fixes only test files (#2095), every other tier all of them.
 */
export function fixerTierPaths(
  check: Pick<Check, "fixUnsafeScope">,
  tier: number,
  paths: readonly string[],
): string[] {
  return tier > 0 && check.fixUnsafeScope === "tests" ? paths.filter(isTestCodePath) : [...paths];
}

/**
 * A fixer that formats its whole package whatever file it is given (`cargo fmt`). It runs once for
 * all of a task's files instead of once per file (bench round 13, mdrefs T010: one `cargo fmt` of
 * the whole crate per README, LICENSE and test file).
 */
export function isWholeUnitFixer(fix: { executable: string; args: string[] }): boolean {
  const { program, args } = toolchainCommand(fix.executable, fix.args);
  return program === "cargo" && args.includes("fmt") && !args.includes("--");
}

/** The command that applies a whole-unit fixer to several files in one run. */
/**
 * A workspace path as a command run in the check's `cwd` names it: a check in a subproject
 * (`cwd: "packages/web"`) gets `src/a.ts` for `packages/web/src/a.ts`, and `../x` for a path
 * outside it. Fixers and scoped checks take workspace paths; the command runs in the check's cwd.
 */
export const cwdPath = (check: Pick<Check, "cwd">, path: string): string =>
  !check.cwd || check.cwd === "." ? path : posix.relative(posix.normalize(check.cwd), path);

export function wholeUnitFixerCommand(
  fix: { executable: string; args: string[] },
  paths: readonly string[],
): { executable: string; args: string[] } {
  const { args, launch } = toolchainCommand(fix.executable, fix.args);
  return (
    launch([...args, "--", ...paths]) ?? {
      executable: fix.executable,
      args: [...fix.args, "--", ...paths],
    }
  );
}

export function fixerCommand(
  fix: { executable: string; args: string[] },
  path: string,
): { executable: string; args: string[] } {
  const { program: name, args, launch } = toolchainCommand(fix.executable, fix.args);
  const [first] = args;
  const command =
    name === "cargo" && args.includes("fmt") && !args.includes("--")
      ? launch([...args, "--", path])
      : name === "go" && first === "fmt"
        ? launch(["-w", path], "gofmt")
        : name === "dotnet" && first === "format" && !args.includes("--include")
          ? launch([...args, "--include", path])
          : launch([...args, path]);
  // A path a launcher cannot pass unchanged is given to the fixer's own command line.
  return command ?? { executable: fix.executable, args: [...fix.args, path] };
}

/** A criterion that claims the code is formatted: a formatter's name, or files "are formatted". */
const FORMAT_CLAIM =
  /\b(?:gofmt|go\s+fmt|rustfmt|cargo\s+fmt|ruff\s+format|prettier|dotnet\s+format|clang-format|mix\s+format|dart\s+format|zig\s+fmt)\b|-formatted\b|\b(?:code|files?|sources?)\b[^.;]{0,40}?\b(?:is|are|stays?|remains?)\s+(?:properly\s+|correctly\s+)?formatted\b/i;
/** A criterion that claims the code is lint-clean or passes a named linter. */
const LINT_CLAIM =
  /\blint(?:-clean|s|ed|ers?|ing)?\b|\b(?:clippy|ruff\s+check|eslint|flake8|pylint|go\s+vet|rubocop|ktlint|(?:dart|flutter)\s+analyze)\b/i;
const FORMAT_COMMAND = /\b(?:gofmt|fmt|format|prettier|biome|lint)\b/i;
const LINT_COMMAND =
  /\b(?:lint|eslint|biome|ruff|flake8|pylint|clippy|vet|rubocop|ktlint|golangci-lint)\b|\b(?:dart|flutter)\s+analyze\b/i;

/**
 * Whether the passing checks show a criterion's formatting or lint claim, or null when it makes
 * none. A walker passed "all new Go files are gofmt-formatted" from `go vet` and `go test` alone
 * while a file was not (bench round 41, fpbits, #1480). A claim of both needs a passing check of
 * each kind; a `lint` script counts for formatting, since JavaScript projects run their formatter
 * through it.
 */
export function styleClaimShown(text: string, passed: readonly Check[]): boolean | null {
  const kinds = [
    ...(FORMAT_CLAIM.test(text) ? [FORMAT_COMMAND] : []),
    ...(LINT_CLAIM.test(text) ? [LINT_COMMAND] : []),
  ];
  if (!kinds.length) return null;
  const commands = passed
    .filter(isStaticCheck)
    .map((c) => [c.id, c.executable, ...c.args].join(" "));
  return kinds.every((kind) => commands.some((command) => kind.test(command)));
}
