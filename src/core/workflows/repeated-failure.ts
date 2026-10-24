import { tmpdir } from "node:os";
import stripAnsi from "strip-ansi";
import { hashJson } from "../specs/hash.js";

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
}

/** Compares two rounds' failing checks; `replayRepeatedFailures` takes another rule to replay. */
export type RepeatRule = (previous: RepeatCheck[] | null, current: RepeatCheck[]) => RepeatDecision;

// Wall-clock stamps and durations: go test's `0.012s`, bun's `[1.23ms]`, jest's `(5 ms)`,
// pytest's `in 0.12s`, cargo's `finished in 0.00s`. A whole number with a unit stays, since it is
// as often a value the test asserts (`expected 5s`).
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const CLOCK = /\b\d{2}:\d{2}:\d{2}[.,]\d+\b/g;
const DECIMAL_DURATION = /\b\d+\.\d+\s?(?:ns|µs|us|ms|s|m)\b/g;
const BRACKETED_DURATION = /([[(])\s*\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s)\s*([\])])/g;
const ADDRESS = /\b0x[0-9a-f]{6,}\b/gi;

const tempRoots = (): string[] =>
  [tmpdir().replaceAll("\\", "/"), "/tmp", "/var/folders", "/private/var/folders"].filter(
    (root, index, all) => root.length > 1 && all.indexOf(root) === index,
  );

/**
 * A check's output with what changes between two runs of the same failure taken out: terminal
 * colors, line endings and trailing spaces, path separators, wall-clock stamps, durations,
 * temporary directories and memory addresses. Line and column positions stay, so a failure that
 * moved is progress, never a repeat. A check runner whose failing output carries another such
 * value adds its rule here, with the case in `tests/repeated-failure.test.ts` (two runs of each
 * toolchain's failing check hash equal).
 */
export function normalizeCheckOutput(output: string): string {
  let text = stripAnsi(output).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  text = text.replaceAll("\\", "/");
  for (const root of tempRoots()) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}/[^\\s:'"\`)]+`, "gi"), "<tmp>");
  }
  text = text.replace(/[A-Za-z]:\/Users\/[^/\s]+\/AppData\/Local\/Temp\/[^\s:'"`)]+/gi, "<tmp>");
  text = text
    .replace(TIMESTAMP, "<time>")
    .replace(CLOCK, "<time>")
    .replace(BRACKETED_DURATION, "$1<duration>$2")
    .replace(DECIMAL_DURATION, "<duration>")
    .replace(ADDRESS, "<address>");
  return text
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
