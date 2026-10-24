/**
 * The baseline replay (#1945): the run's tests run once more in a copy of the delivered tree whose
 * other changed files are put back as they were before the run, so "the new tests fail on the old
 * code" and "the old tests still pass on it" become evidence a reviewer reads instead of a claim
 * nobody can check. Update briefs ask for it in most rounds (bench round 61: taskplan, ignorewhy,
 * tplfill; round 60: modeplan), and without it convergence answered inconclusive, then fail, and
 * stopped `no_progress` on a requirement the run could settle itself. Opt-in (`baselineReplay`).
 */
import type { TestRunner } from "../../verification/output-counts.js";
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

/** What the spec author, the spec reviewer and the reviewers are told when the replay is on. */
export const BASELINE_REPLAY_NOTE = {
  spec: "The host runs the baseline replay: after the checks pass, it runs the test checks once more in a copy of the delivered tree whose changed non-test files are put back as they were before the run (files the run created are removed), and records which tests fail there. A criterion that named new tests fail on the code before the change, or that existing tests still pass on it, is automated: the replay proves it. Name the tests, not a revert you expect a person to make.",
  analysis:
    "The host runs the baseline replay (the test checks on the delivered tests with the other changed files put back as they were before the run, recorded as evidence quality/baseline-replay.json), so a criterion that named tests fail, or pass, on the code before the change is automated and checkable; it is never a finding for needing a second tree.",
  review:
    "Evidence quality/baseline-replay.json is the baseline replay: the test checks run on the delivered tests with every other changed file put back as it was before the run (reverted), files the run created removed (removed), and files whose earlier content was not kept left as delivered (unknown). Each check lists its status and failedTests. Settle a criterion that tests fail, or pass, on the code before the change from it: the named tests must be in failedTests (or absent from it for tests that must still pass). failedTests null means the output was not read, so read its output. buildFailed means some or all tests did not build or load on the code before the change, so they did not run and are not in failedTests (buildErrors holds the first errors): a test that does not build there fails on the code before the change, and is not a test that still passes there. A note instead of checks means there was nothing to replay, for example a feature that created all its code.",
} as const;
