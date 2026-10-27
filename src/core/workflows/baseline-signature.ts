import { hashJson } from "../specs/hash.js";

/**
 * Whether a required check fails as it did before any change, compared by shape (#2295).
 *
 * The live comparison (`failsAsBaseline` in `scheduler.ts`, which stops the checks stage with
 * `baseline_failure` and excuses a task's check at task end) reads `failureSignature`, whose
 * durations and times are matched by a few spellings: Gradle's `BUILD FAILED in 1m 3s`, dotnet's
 * `< 1 ms`, CTest's padded columns, Maven's `01:05 min`, an address, a seed or a temporary path
 * make two runs of one failure differ, and the run spends correctives on debt no task can reach.
 * `shapedFailureSignature` takes them out through `normalizeVolatile`, the table the
 * repeated-failure hash reads. Since a wider match stops runs that do not stop today, it ships in
 * shadow: the check baseline records both signatures (`failures` and `shapes`), each comparison
 * records its inputs as `baseline-signature/<check>-<hash>.json` (kind `baseline-signature`, kept
 * in bench traces, each signature line stood in on its own), the live decision stays the legacy
 * one, and a comparison only the shaped signatures match records the `baseline_signature`
 * would-stop. `replayBaselineSignatures` (`trace.ts`) decides each record again. Promoting it to
 * enforce is a pull request of its own that cites two bench rounds with no false would-stop.
 */
export const BASELINE_SIGNATURE_KIND = "baseline-signature";
export const BASELINE_SIGNATURE_DIR = "baseline-signature/";

/** Which signatures say the check fails as before any change. */
export type BaselineSignatureDecision = "both" | "legacy" | "shaped" | "neither";

/** One side of the comparison: the baseline's and the current check's signature, by line. */
export interface SignaturePair {
  before: string[];
  after: string[];
}

export interface BaselineSignatureInput {
  /** The live signatures (`failureSignature`). */
  legacy: SignaturePair;
  /** The signatures through the shared table (`shapedFailureSignature`). */
  shaped: SignaturePair;
  /** The task-end path also takes a failure that only lost baseline lines (#1913). */
  subset: boolean;
}

export interface BaselineSignatureRecord extends BaselineSignatureInput {
  checkId: string;
  /** `checks` for the checks stage's `baseline_failure` stop, `task` for the task-end excuse. */
  at: "checks" | "task";
  decision: BaselineSignatureDecision;
}

export type BaselineSignatureRule = (input: BaselineSignatureInput) => BaselineSignatureDecision;

/** Whether `after` is `before`, or with `subset` reports only lines `before` has. */
export function sameFailure(pair: SignaturePair, subset: boolean): boolean {
  const after = pair.after.filter(Boolean);
  if (!pair.before.length || !after.length) return false;
  if (pair.before.join("\n") === after.join("\n")) return true;
  if (!subset) return false;
  const lines = new Set(pair.before);
  return after.every((line) => lines.has(line));
}

export const baselineSignatureDecision: BaselineSignatureRule = (input) => {
  const legacy = sameFailure(input.legacy, input.subset);
  const shaped = sameFailure(input.shaped, input.subset);
  return legacy ? (shaped ? "both" : "legacy") : shaped ? "shaped" : "neither";
};

/** A signature as its record keeps it: one entry per line, each stood in on its own in a trace. */
export const signatureLines = (signature: string): string[] =>
  signature.split("\n").filter(Boolean);

export function baselineSignaturePath(checkId: string, input: BaselineSignatureInput): string {
  return `${BASELINE_SIGNATURE_DIR}${checkId}-${hashJson(input).slice(0, 12)}.json`;
}
