import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "./errors.js";
import type { RunPolicy, TaskGraph } from "./schemas.js";
import type { Check, Task } from "./types.js";

export function validateChecks(workspace: string, policy: RunPolicy, graph?: TaskGraph): void {
  if (policy.maxCostUsd !== null)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "A dollar cap requires verified model pricing; maxCostUsd must be null",
    );
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

const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|pyi?|rs|go|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|vue|svelte)$/i;
/** Commands that analyze source without running it: linters, formatters and type checkers. */
const STATIC_COMMAND =
  /\b(?:lint|eslint|biome|ruff|flake8|pylint|clippy|vet|fmt|format|prettier|mypy|pyright|tsc|typecheck|check)\b/i;

/** Source code a linter or formatter reads: any written file that is not documentation or data. */
export const isCodePath = (path: string): boolean => CODE_FILE.test(path);

/** The code files a task creates or modifies. */
export const writtenCodePaths = (task: Pick<Task, "writes">): string[] =>
  task.writes.filter((w) => w.action !== "delete" && isCodePath(w.path)).map((w) => w.path);

/**
 * Whether a feature-scope check analyzes source files statically (it names a fixer or runs a
 * linter, formatter or type checker). Test suites are not: they need other tasks' code to pass.
 */
export const isStaticCheck = (check: Check): boolean =>
  Boolean(check.fix) || STATIC_COMMAND.test([check.id, check.executable, ...check.args].join(" "));

/**
 * Static checks that analyze a whole compilation unit: they resolve every module, import and
 * type of the project, so in a task's own worktree they fail until the sibling tasks' files exist
 * (bench round 08, commitbump: `cargo clippy` E0583 for a `mod parse;` whose file another task
 * writes, and 2.2M tokens of repairs that could not pass). They run in the checks stage after
 * integration, not per task. `cargo fmt` and `rustfmt` count too: they follow every `mod x;` and
 * fail on a module file a later task writes (bench round 11, mdrefs: a skeleton task blocked on
 * "failed to resolve mod"). Other formatters and file-local linters (gofmt, ruff, biome, eslint)
 * read one file at a time and stay per task.
 */
const WHOLE_UNIT_COMMAND =
  /\b(?:clippy|vet|tsc|typecheck|mypy|pyright|rustfmt)\b|\bcargo\s+(?:check|fmt)\b/i;

export const isWholeUnitCheck = (check: Check): boolean =>
  WHOLE_UNIT_COMMAND.test([check.id, check.executable, ...check.args].join(" "));

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
 * A fixer that formats its whole package whatever file it is given (`cargo fmt`). It runs once for
 * all of a task's files instead of once per file (bench round 13, mdrefs T010: one `cargo fmt` of
 * the whole crate per README, LICENSE and test file).
 */
export function isWholeUnitFixer(fix: { executable: string; args: string[] }): boolean {
  const name = fix.executable
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
  return name === "cargo" && fix.args.includes("fmt") && !fix.args.includes("--");
}

/** The command that applies a whole-unit fixer to several files in one run. */
export function wholeUnitFixerCommand(
  fix: { executable: string; args: string[] },
  paths: readonly string[],
): { executable: string; args: string[] } {
  return { executable: fix.executable, args: [...fix.args, "--", ...paths] };
}

export function fixerCommand(
  fix: { executable: string; args: string[] },
  path: string,
): { executable: string; args: string[] } {
  const name = fix.executable
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
  const [first] = fix.args;
  if (name === "cargo" && fix.args.includes("fmt") && !fix.args.includes("--"))
    return { executable: fix.executable, args: [...fix.args, "--", path] };
  if (name === "go" && first === "fmt") return { executable: "gofmt", args: ["-w", path] };
  if (name === "dotnet" && first === "format" && !fix.args.includes("--include"))
    return { executable: fix.executable, args: [...fix.args, "--include", path] };
  return { executable: fix.executable, args: [...fix.args, path] };
}
