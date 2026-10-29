import stripAnsi from "strip-ansi";
import { hashJson } from "../specs/hash.js";
import { normalizeVolatile } from "../verification/volatile.js";

/**
 * A corrective whose required checks fail exactly as the corrective before it in the same chain
 * did (#1996). cfgquill lint a843cc11 (bench round 64): T005, T006 and T007 each failed gofmt and
 * tests-written with `internal\lint\rules_test.go:26:2217: illegal byte order mark`, byte for byte,
 * and each was a full model task (T007 alone 3.43M tokens); the chain stopped only when
 * `maxTaskRepairs` was spent, with a message that names a count, not the cause. A defect no model
 * action changes (a host-written region, a toolchain refusal) looks like three model failures
 * unless the rounds' evidence is compared.
 *
 * Each corrective's failing required checks are recorded as `repeats/tasks/<task>.json` (kind
 * `repeated-failure`, kept in bench traces): per check its id, its output normalized by
 * `normalizeCheckOutput`, and the files the output names failing; the hash covers all three. The
 * stop reason `repeated_failure` (`stop-reasons.ts`) is in shadow mode: a corrective whose hash
 * equals the one of the corrective it corrects records `decision.would_stop` with both round ids,
 * once per chain. `replayRepeatedFailures` (`trace.ts`) decides each record again.
 *
 * A task that ends unfinished (`Task T001 did not complete its implementation`, the run blocked
 * `invalid_output`) opens no corrective, so the chain comparison never sees it (#2437). R77
 * pairwick: the implement tasks of three feature runs failed one `scalafmt` check 121 times
 * across 143 attempts and their resumes, for 17.13M tokens, with no record. Each such end records
 * `unfinishedRecord` at the same path, and an end that fails as the task's previous unfinished end
 * did records the `repeated_failure` would-stop (key `task-<id>`) and names the repeat in the
 * block message and its `resume` remedy.
 */
export const REPEAT_KIND = "repeated-failure";
/** One record per corrective whose required checks failed: `repeats/tasks/<task>.json`. */
export const REPEAT_TASKS_DIR = "repeats/tasks/";
/** The tail of each check's normalized output a record keeps and hashes. */
export const REPEAT_OUTPUT_CHARS = 4000;

export interface RepeatCheck {
  id: string;
  /** The check's output, normalized and cut to its last `REPEAT_OUTPUT_CHARS` characters. */
  text: string;
  /** The files the output names failing, sorted. */
  files: string[];
}

export type RepeatDecision = "first" | "progress" | "repeat";

/** What `repeats/tasks/<task>.json` records: the decision's inputs, with output stood in by a trace. */
export interface RepeatRecord {
  taskId: string;
  /** The corrective this one corrects, whose record it is compared with; null after a planned task. */
  previous: string | null;
  /** The first task of the chain: the planned task the first corrective was opened for. */
  root: string;
  checks: RepeatCheck[];
  hash: string;
  previousHash: string | null;
  /** The offset of the first character where the two rounds' evidence differs; null when equal. */
  firstDifference: number | null;
  decision: RepeatDecision;
  /**
   * `unfinished`: the record of a task that ended unfinished (#2437), compared with the same
   * task's previous unfinished end (`previous` is then the task itself); absent for a corrective's.
   */
  end?: "unfinished";
  /** For an unfinished end: how many unfinished ends in a row, this one included, failed alike. */
  ends?: number;
}

/** Compares two rounds' failing checks; `replayRepeatedFailures` takes another rule to replay. */
export type RepeatRule = (previous: RepeatCheck[] | null, current: RepeatCheck[]) => RepeatDecision;

/**
 * A check's output with what changes between two runs of the same failure taken out: terminal
 * colors, line endings and trailing spaces, path separators, and the volatile values
 * `normalizeVolatile` (`src/core/verification/volatile.ts`) takes out. Line and column positions
 * stay, so a failure that moved is progress, never a repeat. A check runner whose failing output
 * carries another such value adds its rule to `normalizeVolatile`, never here, with the case in
 * `tests/repeated-failure.test.ts` (two runs of each toolchain's failing check hash equal through
 * this function and both `failureSignature`s; every runner of `TEST_RUNNERS` has one, #2295).
 */
export function normalizeCheckOutput(output: string): string {
  const text = stripAnsi(output)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\\", "/");
  return normalizeVolatile(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** One failing check of a round, as the record keeps it. */
export function repeatCheck(id: string, output: string, files: readonly string[]): RepeatCheck {
  return {
    id,
    text: normalizeCheckOutput(output).slice(-REPEAT_OUTPUT_CHARS),
    files: [...new Set(files.map((f) => f.replaceAll("\\", "/")))].sort(),
  };
}

const ordered = (checks: readonly RepeatCheck[]): RepeatCheck[] =>
  [...checks].sort((a, b) => a.id.localeCompare(b.id) || a.text.localeCompare(b.text));

/** The hash of a round's failing checks: each check's id, normalized output and files. */
export function failureHash(checks: readonly RepeatCheck[]): string {
  return hashJson(ordered(checks).map((c) => ({ id: c.id, text: c.text, files: c.files })));
}

const evidenceText = (checks: readonly RepeatCheck[]): string =>
  ordered(checks)
    .map((c) => `${c.id}\n${c.files.join("\n")}\n${c.text}`)
    .join("\n\0\n");

/** The offset of the first character where two rounds' evidence differs, or null when equal. */
export function firstDifference(
  previous: readonly RepeatCheck[],
  current: readonly RepeatCheck[],
): number | null {
  const a = evidenceText(previous);
  const b = evidenceText(current);
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether a corrective's failing checks repeat the corrective's before it: `first` without an
 * earlier corrective's record, `repeat` when the hashes are equal (the same checks, outputs and
 * files), `progress` otherwise. Only the round right before counts: a failure that comes back
 * after a different one in between is not a repeat.
 */
export const repeatedFailureDecision: RepeatRule = (previous, current) =>
  previous === null
    ? "first"
    : failureHash(previous) === failureHash(current)
      ? "repeat"
      : "progress";

/** The record of one corrective's failing checks, decided against its predecessor's record. */
export function repeatRecord(
  taskId: string,
  /** The task the corrective was opened for. */
  corrected: string | null,
  /** That task's own record, when it is a corrective whose checks failed. */
  previous: RepeatRecord | null,
  checks: RepeatCheck[],
  decide: RepeatRule = repeatedFailureDecision,
): RepeatRecord {
  const hash = failureHash(checks);
  return {
    taskId,
    previous: previous ? previous.taskId : null,
    root: previous?.root ?? corrected ?? taskId,
    checks: ordered(checks),
    hash,
    previousHash: previous?.hash ?? null,
    firstDifference: previous ? firstDifference(previous.checks, checks) : null,
    decision: decide(previous?.checks ?? null, checks),
  };
}

/**
 * The record of a task's unfinished end, decided against the task's previous unfinished end
 * (#2437). An end without a failing check records no checks and decides `first`: nothing failed
 * to repeat, and the next end compares with it, so a failure that comes back after an end without
 * one is not a repeat.
 */
export function unfinishedRecord(
  taskId: string,
  /** The task's latest record, when it is an unfinished end's. */
  previous: RepeatRecord | null,
  checks: RepeatCheck[],
  decide: RepeatRule = repeatedFailureDecision,
): RepeatRecord {
  const before =
    previous?.end === "unfinished" && previous.checks.length && checks.length ? previous : null;
  const record = repeatRecord(taskId, null, before, checks, decide);
  return {
    ...record,
    end: "unfinished",
    ends: record.decision === "repeat" ? (before?.ends ?? 1) + 1 : 1,
  };
}
