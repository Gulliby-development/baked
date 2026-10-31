import { ROUTING_ARTIFACT } from "../llm/model-routing.js";
import { canonical, hashBytes } from "../specs/hash.js";
import { releaseLinkCount } from "./release-writes.js";
import { type RecoveryAdvice, recoveryAdvice } from "./remedies.js";
import { REPEAT_KIND, type RepeatDecision } from "./repeated-failure.js";
import { ROW_CLAIM_RESUME_DIR, ROW_SPEC_REPAIR_PREFIX } from "./row-claim-repair.js";
import { ROW_RESTORE_RESUME_DIR } from "./row-restore.js";
import type { WorkflowStore } from "./store.js";
import { type WriteRefusal, writeRefusalOf } from "./write-refusals.js";

export const INVALID_OUTPUT_NOTE =
  "The previous attempt of this stage was rejected as invalid output with the diagnostic below. Correct what it names in this attempt.";
/**
 * The repeat key of the last invalid-output note (`invalidOutputKey`): the writes the host refused,
 * or the diagnostic's hash when it refused none, and the run inputs a person can change without
 * touching the prompt (`invalidOutputInputs`). A resume whose key equals it repeats the attempt
 * (#1348, #2191, #2520).
 */
export const INVALID_OUTPUT_KEY = "invalid-output/repeat-key.json";

/**
 * The run inputs besides the prompt that a person can change after an invalid output, for the
 * repeat key: the routing revision (a reroute), the `host-release` links that converted a
 * released run's stale creates (`release`, #2540), and the resume records of a test file's
 * miscounted prescribed rows (`rows`, `row-restores/resume/`, #2543: the host restores them before
 * the blocked task's next session), each only once there is one, so older keys still match. A new
 * way to change a run's input without the prompt adds its revision here (AGENTS.md).
 */
export function invalidOutputInputs(
  store: WorkflowStore,
  runId: string,
): { routing: number; release?: number; rows?: number; claims?: number } {
  const release = releaseLinkCount(store, runId);
  const rows = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith(ROW_RESTORE_RESUME_DIR)).length;
  // The restatements the resume checked against the request's rows (#2561), and the spec and
  // prompt repairs that followed them (#2563).
  const claims = store
    .artifacts(runId)
    .filter(
      (a) =>
        a.logical_path.startsWith(ROW_CLAIM_RESUME_DIR) ||
        a.logical_path.startsWith(ROW_SPEC_REPAIR_PREFIX),
    ).length;
  return {
    routing: store.latestArtifact(runId, ROUTING_ARTIFACT)?.revision ?? 0,
    ...(release ? { release } : {}),
    ...(rows ? { rows } : {}),
    ...(claims ? { claims } : {}),
  };
}

/** One write the tool policy refused in the attempts that ended in a stop: its code and path. */
export interface RefusedWrite {
  /** Which refusal (`WRITE_REFUSALS`); not named `error`, which a trace stands in as prose. */
  code: WriteRefusal;
  path: string;
}

/**
 * The inputs of the invalid-output repeat decision, recorded at each `invalid_output` stop under
 * `repeats/invalid-output/<diagnostic>.json` (kind `repeated-failure`) so a trace replays it
 * (`replayRepeatedFailures`, #2520).
 */
export interface InvalidOutputFacts {
  /**
   * The writes the tool policy refused in the attempts that ended in this stop, sorted and
   * without duplicates. When there are any, the key is built from them: a worker that restates
   * the same refusal in new words repeats the same attempt (R82 slotprompt blocks 733c7777: four
   * attempts, each refused "Create target already exists", each blocked reason worded anew).
   */
  refusals: RefusedWrite[];
  /** The hash of the diagnostic (its first 2000 characters): the key only without refusals. */
  diagnostic: string;
  /** `invalidOutputInputs`: the run inputs a person can change besides the prompt. */
  inputs: { routing: number; release?: number; rows?: number; claims?: number };
  /** Whether the prompt already holds this diagnostic's note (a resume gave it). */
  noted: boolean;
  /** The key the last resume recorded (`INVALID_OUTPUT_KEY`); null when none did. */
  previous: string | null;
}

/** The record of one `invalid_output` stop's repeat decision. */
export interface InvalidOutputRecord extends InvalidOutputFacts {
  diagnosticId: string;
  key: string;
  decision: RepeatDecision;
}

/** Where each `invalid_output` stop's repeat decision is recorded (kind `repeated-failure`). */
export const INVALID_OUTPUT_REPEATS_DIR = "repeats/invalid-output/";

/**
 * The repeat key of a stop: built from what the host observed, the refused writes, when the
 * attempts carried any, and from the diagnostic's hash only when they carried none. Never from
 * the model's wording when the host saw the cause (AGENTS.md).
 */
export function invalidOutputKey(
  inputs: Pick<InvalidOutputFacts, "refusals" | "diagnostic" | "inputs">,
): string {
  return inputs.refusals.length
    ? canonical({ refusals: inputs.refusals, inputs: inputs.inputs })
    : canonical({ diagnostic: inputs.diagnostic, inputs: inputs.inputs });
}

/**
 * Whether a plain resume after a stop would repeat the last resume: `repeat` when the last resume
 * recorded this very key (the attempt after it stopped the same way), `progress` when it recorded
 * another, `first` when no resume gave anything to compare. A key from the diagnostic also needs
 * the prompt to hold this diagnostic's note; a note from before the key was recorded was given
 * with the run's first routing. A key from refusals needs no note: the note holds the model's
 * wording, which the key leaves out.
 */
export function invalidOutputDecision(inputs: InvalidOutputFacts): RepeatDecision {
  const key = invalidOutputKey(inputs);
  if (inputs.refusals.length)
    return inputs.previous === null ? "first" : inputs.previous === key ? "repeat" : "progress";
  if (!inputs.noted) return "first";
  const previous =
    inputs.previous ??
    canonical({
      diagnostic: inputs.diagnostic,
      inputs: { ...inputs.inputs, routing: Math.min(inputs.inputs.routing, 1) },
    });
  return previous === key ? "repeat" : "progress";
}

/**
 * The writes the tool policy refused between the stop before `diagnosticId`'s and that stop: the
 * `tool.finished` errors of the attempts that ended in it, by code and path, sorted.
 */
export function refusedWrites(
  store: WorkflowStore,
  runId: string,
  diagnosticId: string,
): RefusedWrite[] {
  const diagnostics = new Set(
    store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("errors/"))
      .map((a) => a.id),
  );
  let from = 0;
  let to = Number.POSITIVE_INFINITY;
  for (const event of store.eventsOfType(runId, "artifact.committed")) {
    if (event.type !== "artifact.committed" || !diagnostics.has(event.payload.artifactId)) continue;
    if (event.payload.artifactId === diagnosticId) {
      to = event.seq;
      break;
    }
    from = event.seq;
  }
  const pairs = new Map<string, RefusedWrite>();
  for (const event of store.eventsOfType(runId, "tool.finished")) {
    if (event.type !== "tool.finished" || event.seq <= from || event.seq >= to) continue;
    const refused = event.payload.error ? writeRefusalOf(event.payload.error) : null;
    if (refused) pairs.set(`${refused.code}\0${refused.path}`, refused);
  }
  return [...pairs.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code),
  );
}

/**
 * What a plain resume after the run's latest stop would note, and whether it would repeat the last
 * resume (`invalidOutputDecision` on `invalidOutputKey`). Null when the run recorded no
 * diagnostic. It writes nothing, so the run views can ask before a person presses retry (#2201);
 * the resume itself (`noteInvalidOutput`) records the note and the key.
 */
export function invalidOutputRepeat(
  store: WorkflowStore,
  runId: string,
): { note: string; key: string; repeats: boolean; record: InvalidOutputRecord } | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return null;
  const diagnostic = store.readArtifact(runId, latest.id).trim().slice(0, 2000);
  if (!diagnostic) return null;
  const note = `\n${INVALID_OUTPUT_NOTE}\n${canonical({ diagnostic })}`;
  const recorded = store.latestArtifact(runId, INVALID_OUTPUT_KEY);
  const inputs: InvalidOutputFacts = {
    refusals: refusedWrites(store, runId, latest.id),
    diagnostic: hashBytes(diagnostic),
    inputs: invalidOutputInputs(store, runId),
    noted: store.state(runId).prompt.includes(note),
    previous: recorded ? store.readArtifact(runId, recorded.id) : null,
  };
  const key = invalidOutputKey(inputs);
  const decision = invalidOutputDecision(inputs);
  return {
    note,
    key,
    repeats: decision === "repeat",
    record: { diagnosticId: latest.id, ...inputs, key, decision },
  };
}

/**
 * Records the repeat decision of the run's latest `invalid_output` stop with its inputs, for the
 * replay (`replayRepeatedFailures`). Written at the stop, before any person changes an input.
 */
export function recordInvalidOutputDecision(store: WorkflowStore, runId: string): void {
  const repeat = invalidOutputRepeat(store, runId);
  if (!repeat) return;
  store.artifact(
    runId,
    REPEAT_KIND,
    `${INVALID_OUTPUT_REPEATS_DIR}${repeat.record.diagnosticId}.json`,
    canonical(repeat.record),
  );
}

/** A blocked `invalid_output` run whose plain resume the repeat guard would refuse. */
export function repeatsInvalidOutput(store: WorkflowStore, runId: string): boolean {
  const run = store.run(runId);
  return (
    run.status === "blocked" &&
    run.reason === "invalid_output" &&
    invalidOutputRepeat(store, runId)?.repeats === true
  );
}

/**
 * The advice of a repeated invalid output: the refusal of a plain resume, and the run views'
 * recovery for such a stop, so they lead with the rerouted retry and offer no plain one.
 */
export function repeatedInvalidOutputAdvice(runId: string): RecoveryAdvice {
  return recoveryAdvice(
    `The run stopped again with the same diagnostic after the last resume, so another resume would repeat the same attempt. Change the input instead: switch the failing stage to another model (\`baked workflow reroute ${runId} --route STAGE=MODEL --resume\`), revise the run (\`baked workflow revise ${runId}\`), run an initiative feature again (\`baked workflow initiative replan ID --feature F\`), or cancel it`,
    "The run stopped again with the same diagnostic after the last resume. Switch the stage's model or change the input before trying again.",
    { action: "reroute", runId },
    { action: "revise", runId },
    { action: "replan", runId },
    { action: "cancel", runId },
  );
}
