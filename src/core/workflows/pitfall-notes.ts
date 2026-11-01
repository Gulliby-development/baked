import { implementerPitfalls } from "../agents/profiles/language-pitfalls.js";
import { hashBytes } from "../specs/hash.js";
import { normalizeCheckOutput } from "./repeated-failure.js";

/**
 * What an implementer step is told of the traps of its languages and of its run (#2598). R84
 * wrapsmith (PowerShell, 21.57M tokens): each handler task wrote the same `[Parameter(Mandatory)]
 * [int[]] $Positional` declaration without `[AllowEmptyCollection()]` and failed Pester on
 * `Cannot bind argument to parameter 'Positional' because it is an empty array`, 25 checks across
 * three features, with 4.65M tokens of repeat attempts, because no task heard what its sibling's
 * failure was.
 *
 * `notes` are the `implement` rows of `LANGUAGE_PITFALLS` for the languages of the files the task
 * writes. `traps` are the failing check outputs of the run's other tasks, normalized as
 * `repeated_failure` normalizes them (`normalizeCheckOutput`, #1996), each cut to its first error
 * line and kept once by that line's hash: one line each, `RUN_TRAPS_MAX` at most. Every
 * implementer step records them as `pitfalls/tasks/<task>.json` (kind `language-pitfalls`, kept in
 * bench traces with its text stood in); only the policy field `languagePitfalls: "on"` puts them
 * into the step's input (`languagePitfalls`, `runTraps`). Absent is shadow.
 */
export const PITFALLS_KIND = "language-pitfalls";
export const PITFALLS_DIR = "pitfalls/tasks/";
/** The most run traps a step is told. */
export const RUN_TRAPS_MAX = 3;
/** The longest error line a trap keeps. */
export const TRAP_LINE_CHARS = 200;
/** The lines of a failing output searched for its error line. */
const TRAP_SCAN_LINES = 200;

/** A line that names an error: an exception or error type, or the word error itself. */
const ERROR_LINE = /\b\w*(?:Exception|Error)\b|\berror\b/i;

/** A failing check run of a task of the run. */
export interface RunFailure {
  taskId: string;
  checkId: string;
  output: string;
}

/** One trap: the first error line of a failing check output of another task. */
export interface RunTrap {
  taskId: string;
  checkId: string;
  line: string;
  /** The hash of the normalized line, which keeps each trap once. */
  hash: string;
}

/** What `pitfalls/tasks/<task>.json` records. */
export interface PitfallsRecord {
  taskId: string;
  /** Whether the step's input held them (`languagePitfalls: "on"`). */
  applied: boolean;
  notes: string[];
  traps: RunTrap[];
  /** The characters the notes and the trap rules add to the step's input. */
  chars: number;
}

/** The first line of a failing output that names an error, normalized and cut; null when none does. */
export function trapLine(output: string): string | null {
  const lines = normalizeCheckOutput(output).split("\n").slice(0, TRAP_SCAN_LINES);
  const line = lines.map((l) => l.trim()).find((l) => ERROR_LINE.test(l));
  return line ? line.slice(0, TRAP_LINE_CHARS) : null;
}

/** The traps the other tasks' failures show, in the order given, each error line once. */
export function runTraps(failures: readonly RunFailure[], taskId: string): RunTrap[] {
  const traps: RunTrap[] = [];
  for (const failure of failures) {
    if (failure.taskId === taskId) continue;
    const line = trapLine(failure.output);
    if (!line) continue;
    const hash = hashBytes(line);
    if (traps.some((t) => t.hash === hash)) continue;
    traps.push({ taskId: failure.taskId, checkId: failure.checkId, line, hash });
    if (traps.length === RUN_TRAPS_MAX) break;
  }
  return traps;
}

/** A trap as the one-line rule the next task reads. */
export const trapRule = (trap: RunTrap): string =>
  `${trap.taskId} of this run failed ${trap.checkId} with: ${trap.line} (avoid the same mistake in the files you write)`;

/** The record of an implementer step: its languages' notes and its run's traps. */
export function pitfallsRecord(
  taskId: string,
  writes: readonly string[],
  failures: readonly RunFailure[],
  applied: boolean,
): PitfallsRecord {
  const notes = implementerPitfalls(writes);
  const traps = runTraps(failures, taskId);
  const chars = [...notes, ...traps.map(trapRule)].reduce((sum, text) => sum + text.length, 0);
  return { taskId, applied, notes, traps, chars };
}
