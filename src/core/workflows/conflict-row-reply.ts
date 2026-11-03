import type { EvidenceState } from "./evidence-decisions.js";
import type { RowBlockDrift, RowBlockRecord } from "./row-block-drift.js";

/**
 * A spec conflict about a test file whose rows the request prescribes, answered on the host with
 * the row diff instead of a model settle (#2493). R80 deltaglue cli T010 (run 25985b82): the
 * model transcribed row 2 of `tests/problems-choices-b.test.ts` without the input's final
 * `data: [DONE]\n\n` event, the program (correct) printed one more line, the model reported a
 * "contradictory prescribed row" (an error of its own transcription), the host settled "the
 * approved spec and the request win over the test this run wrote", and the next attempt changed
 * the expected output instead of restoring the input: 1,176,244 tokens in 13 attempts, and the
 * changed row was delivered.
 *
 * When a conflict's test side names a file `suppliedRows` reads (its sides, the paths its report
 * names or the task's failing check names), the host compares the file with the prescribed rows
 * through `rowBlockDrifts` (the one reader of drifting rows, #2486). A delivered file that drifts
 * is verified evidence for the `prescribed-rows` site of `evidenceDecision`: the request's rows
 * win, and the reply names each drifting row and the literal the file lacks. A named row file
 * that keeps every row is offered evidence the host could not find (`unverified`): the conflict
 * goes on to the other settles. With `conflictRowReply: "on"` the host replies and opens no
 * model settle; otherwise (shadow) the decision and the reply it would send are recorded under
 * `conflicts/rows/<task>-<n>.json` (kind `conflict-rows`) and the conflict takes today's path.
 * The decision itself is recorded under `conflicts/evidence/` and replayed by
 * `replayEvidenceDecisions`.
 */
export const CONFLICT_ROWS_KIND = "conflict-rows";
export const CONFLICT_ROWS_DIR = "conflicts/rows/";

/** A prescribed-row file the conflict names, as the host compared it (no prose). */
export interface ConflictRowFile {
  path: string;
  /** The file is in the attempt's tree. */
  delivered: boolean;
  /** The rows the request prescribes for it. */
  rows: number;
  /** The rows the file does not keep as given (`RowBlockRecord.drifting`), from 1. */
  drifting: number[];
}

/** What `conflicts/rows/<task>-<n>.json` records. */
export interface ConflictRowRecord {
  schemaVersion: 1;
  taskId: string;
  /** The how-manieth row comparison of this task's conflicts, from 1. */
  report: number;
  /** `on`: the host replied; `shadow`: the reply is only recorded. */
  mode: "on" | "shadow";
  files: ConflictRowFile[];
  /** The `prescribed-rows` evidence decision: the request's rows win. */
  decision: boolean;
  /** The reply the host sends (or would send), naming each drifting row; null without one. */
  reply: string | null;
}

/** The compared files of a conflict, from `rowBlockDrifts` records. */
export const conflictRowFiles = (records: readonly RowBlockRecord[]): ConflictRowFile[] =>
  records.map((r) => ({
    path: r.path,
    delivered: r.delivered,
    rows: r.rows.length,
    drifting: [...r.drifting],
  }));

/**
 * The evidence the compared files give: `verified` when a delivered file drifts from its rows,
 * `unverified` when every named row file keeps them (or is not there), `absent` when the conflict
 * names no file whose rows the request prescribes.
 */
export function conflictRowEvidence(files: readonly ConflictRowFile[]): EvidenceState {
  if (!files.length) return "absent";
  return files.some((f) => f.delivered && f.drifting.length) ? "verified" : "unverified";
}

const LIMIT = 6;

/**
 * The row diff: for each drifting row, the literals the file lacks as the request spells them,
 * or the first value the file row in its place does not hold. Only from `rowBlockDrifts`.
 */
export function conflictRowDiff(drifts: readonly RowBlockDrift[]): string {
  const lines = drifts.slice(0, LIMIT).map((drift) => {
    const where = `row ${drift.row} of ${drift.path}`;
    if (drift.missing.length)
      return `${where} lacks ${drift.missing.map((m) => `"${m.text}"`).join(", ")} (the row as the request gives it: ${drift.text})`;
    if (drift.differs)
      return `${where}: line ${drift.differs.line}, the row's place, does not hold "${drift.differs.text}" (value ${drift.differs.token} of ${drift.differs.tokens}) where the row gives it (the row as the request gives it: ${drift.text})`;
    return `${where} is not kept as given (the row as the request gives it: ${drift.text})`;
  });
  const more = drifts.length > LIMIT ? `; and ${drifts.length - LIMIT} more drifting rows` : "";
  return `${lines.join("; ")}${more}`;
}

/** What the task's next attempt reads when the request's rows win (#2493). */
export function conflictRowNote(
  taskId: string,
  assumedPath: string,
  report: string,
  drifts: readonly RowBlockDrift[],
): string {
  const paths = [...new Set(drifts.map((d) => d.path))].join(", ");
  return `Assumed under clarification assume (${assumedPath}): task ${taskId} reported a conflict about ${paths}, whose rows the request prescribes: ${report.slice(0, 1500)} The host compared the file with the request's rows: ${conflictRowDiff(drifts)}. The request's rows win over the test this run wrote: restore each named row in ${paths} exactly as the request gives it (its input and its expected output alike), change no other row and no expected output to fit the program, and make the code pass. Report implemented or already_satisfied, not spec_conflict.`;
}
