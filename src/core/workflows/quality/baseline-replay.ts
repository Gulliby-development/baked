/**
 * The baseline replay (#1945): the run's tests run once more in a copy of the delivered tree whose
 * other changed files are put back as they were before the run, so "the new tests fail on the old
 * code" and "the old tests still pass on it" become evidence a reviewer reads instead of a claim
 * nobody can check. Update briefs ask for it in most rounds (bench round 61: taskplan, ignorewhy,
 * tplfill; round 60: modeplan), and without it convergence answered inconclusive, then fail, and
 * stopped `no_progress` on a requirement the run could settle itself. Opt-in (`baselineReplay`).
 */
import { posix } from "node:path";
import { buildFailure, FAILED_TESTS, type TestRunner } from "../../verification/output-counts.js";
import type { ResolutionDiff } from "./dependency-resolution.js";
import { isTestCodePath } from "./duplication.js";
import type { ChangedFile } from "./rules.js";

/** Artifact of the latest baseline replay of a run. */
export const QUALITY_BASELINE_REPLAY = "quality/baseline-replay.json";

/** How much of a check's output the record keeps: the end, where runners print their failures. */
export const REPLAY_OUTPUT_CHARS = 4000;

export interface BaselineReplayCheck {
  id: string;
  status: "passed" | "failed" | "timeout";
  /** The tests the output reports as failed; null when no runner's summary or failures were read. */
  failedTests: string[] | null;
  /** The runner whose output was read, when one was. */
  runner: TestRunner | null;
  /** The end of the check's output. */
  output: string;
  /**
   * Some or all tests did not build, collect or load on the code before the change, so they did
   * not run and are not in `failedTests`: an update's new tests that call an API the old code
   * lacks (#1960). Absent when every test built.
   */
  buildFailed?: true;
  /** The first lines of that build failure, from the runner's output (`BUILD_FAILURES`). */
  buildErrors?: string[];
  /**
   * After a build failure, the same check run again per test target (`replayTargets`, #2020): a
   * build error in one target stops the aggregate command in cargo, pytest, dotnet and Maven, so
   * the record named the first broken file and no test of the others. Absent when the check built,
   * or when its runner already runs each target on its own.
   */
  targets?: BaselineReplayTarget[];
}

/** One test target of a check that did not build as a whole on the code before the change. */
export interface BaselineReplayTarget {
  /** The test file or project, relative to the workspace; "." for the whole check run again. */
  path: string;
  status: "passed" | "failed" | "timeout";
  /** The tests of this target the output reports as failed; null when it did not build. */
  failedTests: string[] | null;
  /** The target did not build, collect or load on the code before the change. */
  buildFailed?: true;
  buildErrors?: string[];
}

export interface BaselineReplay {
  schemaVersion: 1;
  /** The snapshot of the delivered tree the replay started from. */
  snapshotId: string;
  /** Files put back as they were before the run. */
  reverted: string[];
  /** Files the run created, removed for the replay. */
  removed: string[];
  /** Changed files whose content before the run was not kept, so they stay as delivered. */
  unknown: string[];
  checks: BaselineReplayCheck[];
  /**
   * The resolved dependencies of each folder before the change against the delivery (#1954): a
   * folder whose dependency files the run changed is listed on both sides; every other folder with
   * a source is identical by construction. Absent when the replay made no copy.
   */
  dependencies?: ResolutionDiff[];
  note?: string;
  /**
   * What the replay ran on: the files put back and removed and the delivered tests. A later
   * snapshot with the same inputs reuses the record instead of running again (#1960).
   */
  inputHash?: string;
}

/** The note of a run that created every changed file other than its tests (#1960). */
export const GREENFIELD_NOTE =
  "the run created every changed file other than tests, so there is no code before the change to replay the tests on: every test fails or does not build there by construction";

/**
 * What the replay changes in its copy: every changed file that is not a test goes back to its
 * content before the run, and one the run created is removed. Test files stay as delivered, since
 * they are what the replay runs.
 */
export function replayEdits(changed: readonly ChangedFile[]): {
  revert: { path: string; content: string }[];
  remove: string[];
  unknown: string[];
} {
  const revert: { path: string; content: string }[] = [];
  const remove: string[] = [];
  const unknown: string[] = [];
  for (const file of changed) {
    if (isTestCodePath(file.path)) continue;
    if (file.before === null) remove.push(file.path);
    else if (file.before === undefined) unknown.push(file.path);
    else revert.push({ path: file.path, content: file.before });
  }
  return { revert, remove, unknown };
}

/**
 * One more run of a check toward its targets: the check's arguments with the target's added, and
 * the paths, relative to the check's folder, of the targets its output speaks for (null: the whole
 * check, one record).
 */
export interface ReplayRun {
  args: string[];
  paths: string[] | null;
}

/** What a runner's row splits: the check's arguments and the test files under its folder. */
export interface ReplayTargetInput {
  /** The check's arguments. */
  args: readonly string[];
  /** The test files the run changed, relative to the check's folder. */
  tests: readonly string[];
  /** The file names in a folder relative to the check's folder; empty when it does not exist. */
  list: (dir: string) => string[];
}

/** How many runs one check's targets may take, so a large suite does not run once per file. */
export const REPLAY_TARGET_LIMIT = 12;

/** `args` with `extra` before a `--` separator (the test binary's own arguments stay after it). */
function withArgs(args: readonly string[], extra: string[]): string[] {
  const at = args.indexOf("--");
  return at < 0 ? [...args, ...extra] : [...args.slice(0, at), ...extra, ...args.slice(at)];
}

/** A rerun of the whole check with a flag that keeps going past a target that does not build. */
const keepGoing =
  (...flags: string[]) =>
  ({ args }: ReplayTargetInput): ReplayRun[] =>
    flags.some((flag) => args.includes(flag))
      ? []
      : [{ args: withArgs(args, [flags[0] as string]), paths: null }];

const PROJECT_FILE = /\.(?:sln|slnx|csproj|fsproj|vbproj)$/;

/** One run per changed PHP test file: the check's flags, the vendor script and the file. */
function phpTestFiles({ args, tests }: ReplayTargetInput): ReplayRun[] {
  // `php vendor/bin/phpunit tests`: the script stays, the folder gives way to the file.
  const kept = args.filter(
    (arg, i) => arg.startsWith("-") || (i === 0 && /vendor[\\/]bin[\\/]/.test(arg)),
  );
  return tests
    .filter((path) => path.endsWith(".php"))
    .sort()
    .map((path) => ({ args: [...kept, path], paths: [path] }));
}

/**
 * How the baseline replay splits a check per test target once it did not build as a whole, by the
 * runner whose build failure the output has (#2020): a `Record` over `TestRunner`, so a new runner
 * lands with its row. A row returns the runs, or says why its runner needs none (it already builds
 * and runs each file or package on its own).
 */
export const REPLAY_TARGETS: Record<
  TestRunner,
  ((input: ReplayTargetInput) => ReplayRun[]) | { none: string }
> = {
  bun: { none: "bun test loads each test file on its own and runs the others" },
  jest: { none: "Jest runs each test file as its own suite" },
  vitest: { none: "Vitest runs each test file as its own suite" },
  tap: { none: "a TAP runner reports each test file on its own" },
  busted: { none: "busted loads each spec file on its own and runs the others" },
  go: { none: "go test builds each package on its own, and a package's files build together" },
  // A collection error aborts the session; this flag collects and runs the other files, and each
  // file that does not collect is named in an "ERROR collecting" line.
  pytest: ({ args, tests }) =>
    args.includes("--continue-on-collection-errors")
      ? []
      : [
          {
            args: withArgs(args, ["--continue-on-collection-errors"]),
            paths: tests.filter((path) => path.endsWith(".py")),
          },
        ],
  // cargo stops at the first target that does not compile: each integration test file is its own
  // target (`--test NAME`), and the library's in-file tests are `--lib`.
  cargo: ({ args, list }) => {
    if (args.some((arg) => /^--(?:test|lib|bins?|examples?|benches?|doc)$/.test(arg))) return [];
    const files = list("tests")
      .filter((name) => name.endsWith(".rs"))
      .sort();
    return [
      ...(list("src").includes("lib.rs")
        ? [{ args: withArgs(args, ["--lib"]), paths: ["src/lib.rs"] }]
        : []),
      ...files.map((name) => ({
        args: withArgs(args, ["--test", name.slice(0, -3)]),
        paths: [`tests/${name}`],
      })),
    ];
  },
  // dotnet test builds every project it is given: each test project the run's tests are in.
  dotnet: ({ args, tests, list }) => {
    const projects = new Set<string>();
    for (const path of tests)
      for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
        const project = list(dir).find((name) => /\.(?:cs|fs|vb)proj$/.test(name));
        if (project) {
          projects.add(dir === "." ? project : `${dir}/${project}`);
          break;
        }
        if (dir === "." || dir === "/") break;
      }
    const at = args.findIndex((arg) => PROJECT_FILE.test(arg));
    const verb = args.indexOf("test");
    return [...projects].sort().map((project) => ({
      args:
        at >= 0
          ? args.map((arg, i) => (i === at ? project : arg))
          : [...args.slice(0, verb + 1), project, ...args.slice(verb + 1)],
      paths: [project],
    }));
  },
  // A parse error in one test file stops PHPUnit and Pest before any test runs: each changed test
  // file runs on its own, in place of the check's own test folder (#1491).
  phpunit: phpTestFiles,
  pest: phpTestFiles,
  // A module whose tests do not compile stops the build; --fail-at-end builds and tests the others.
  maven: keepGoing("--fail-at-end", "-fae"),
  // RSpec runs no example once one spec file does not load: each spec file the run's tests are in,
  // on its own (`rspec spec/a_spec.rb`).
  rspec: ({ args, tests }) =>
    args.some((arg) => arg.endsWith(".rb"))
      ? []
      : tests
          .filter((path) => path.endsWith("_spec.rb"))
          .map((path) => ({ args: withArgs(args, [path]), paths: [path] })),
  // `rake test` loads every test file into one process before running any: each file on its own
  // (`rake test TEST=test/a_test.rb`). A Minitest file run by `ruby` is already one target.
  minitest: ({ args, tests }) =>
    !args.includes("rake") || args.some((arg) => arg.startsWith("TEST="))
      ? []
      : tests
          .filter((path) => /_test\.rb$|(?:^|\/)test_(?!helper\.rb$)[^/]*\.rb$/.test(path))
          .map((path) => ({ args: withArgs(args, [`TEST=${path}`]), paths: [path] })),
  // Gradle (JUnit output): --continue runs the other projects' tests after a compile failure.
  junit: keepGoing("--continue"),
};

/**
 * The runs that split a check that did not build as a whole, by its runner (`REPLAY_TARGETS`): the
 * one place the replay decides which targets a check has (#2020). A run whose arguments are the
 * check's own is left out (it would repeat the aggregate), as are the runs past
 * `REPLAY_TARGET_LIMIT`.
 */
export function replayTargets(runner: TestRunner | null, input: ReplayTargetInput): ReplayRun[] {
  const row = runner ? REPLAY_TARGETS[runner] : null;
  if (!row || typeof row !== "function") return [];
  const same = (args: readonly string[]) =>
    args.length === input.args.length && args.every((arg, i) => arg === input.args[i]);
  return row(input)
    .filter((run) => !same(run.args))
    .slice(0, REPLAY_TARGET_LIMIT);
}

/**
 * The targets one run speaks for (#2020): a run of one target (or of the whole check) carries its
 * outcome; a run of several (pytest past collection errors) gives each file the build errors that
 * name it and the failed tests whose names hold its path or its file name. `toWorkspace` turns a
 * path relative to the check's folder into one relative to the workspace.
 */
export function replayTargetRecords(
  run: { paths: string[] | null; runner: TestRunner },
  outcome: { status: "passed" | "failed" | "timeout"; output: string },
  toWorkspace: (path: string) => string,
): BaselineReplayTarget[] {
  const names = FAILED_TESTS[run.runner](outcome.output);
  const errors = outcome.status === "failed" ? (buildFailure(outcome.output, 1000) ?? []) : [];
  const target = (path: string, failed: string[], build: string[]): BaselineReplayTarget => ({
    path,
    status:
      outcome.status === "timeout"
        ? "timeout"
        : failed.length || build.length
          ? "failed"
          : outcome.status,
    failedTests: build.length && !failed.length ? null : failed,
    ...(build.length ? { buildFailed: true as const, buildErrors: build.slice(0, 5) } : {}),
  });
  if (!run.paths) return [target(".", names, errors)];
  if (run.paths.length === 1) return [target(toWorkspace(run.paths[0] as string), names, errors)];
  return run.paths.map((path) => {
    const stem = posix.basename(path).replace(/\.[^.]+$/, "");
    const own = new RegExp(`(?:^|[./:(])${stem.replace(/[^\w]/g, "\\$&")}(?:[.:()]|$)`);
    return target(
      toWorkspace(path),
      names.filter((name) => name.includes(path) || own.test(name)),
      errors.filter((line) => line.includes(path)),
    );
  });
}

/** What the spec author, the spec reviewer and the reviewers are told when the replay is on. */
export const BASELINE_REPLAY_NOTE = {
  spec: "The host runs the baseline replay: after the checks pass, it runs the test checks once more in a copy of the delivered tree whose changed non-test files are put back as they were before the run (files the run created are removed), and records which tests fail there. A criterion that named new tests fail on the code before the change, or that existing tests still pass on it, is automated: the replay proves it. Name the tests, not a revert you expect a person to make. When some test files do not build on the old code, the replay runs each test file or project on its own, so a criterion about named tests holds per target: name the tests and the file they are in. The replay also compares the resolved dependencies before the change with the delivered ones, so a criterion that the resolved dependencies stay unchanged is automated too.",
  analysis:
    "The host runs the baseline replay (the test checks on the delivered tests with the other changed files put back as they were before the run, recorded as evidence quality/baseline-replay.json), so a criterion that named tests fail, or pass, on the code before the change is automated and checkable, and so is one that the resolved dependencies stay unchanged (the record compares them); it is never a finding for needing a second tree.",
  review:
    "Evidence quality/baseline-replay.json is the baseline replay: the test checks run on the delivered tests with every other changed file put back as it was before the run (reverted), files the run created removed (removed), and files whose earlier content was not kept left as delivered (unknown). Each check lists its status and failedTests. Settle a criterion that tests fail, or pass, on the code before the change from it: the named tests must be in failedTests (or absent from it for tests that must still pass). failedTests null means the output was not read, so read its output. buildFailed means some or all tests did not build or load on the code before the change, so they did not run and are not in failedTests (buildErrors holds the first errors): a test that does not build there fails on the code before the change, and is not a test that still passes there. A check that did not build as a whole also lists targets: the same check run again per test file or project (path, status, failedTests, buildFailed, buildErrors), so one target that does not build no longer hides the names of the others; settle a criterion about named tests per target. A note instead of checks means there was nothing to replay, for example a feature that created all its code. dependencies compares the resolved dependencies before the change with the delivered ones, per folder and source (npm, bun, cargo, uv, poetry, nuget, dotnet, go, maven, gradle): identical true, or the added, removed and changed coordinates; a note says why a side could not be listed. Settle a criterion that the resolved dependencies are unchanged from it.",
} as const;
