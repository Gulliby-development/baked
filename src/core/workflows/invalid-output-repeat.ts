import { ROUTING_ARTIFACT } from "../llm/model-routing.js";
import { canonical, hashBytes } from "../specs/hash.js";
import { type RecoveryAdvice, recoveryAdvice } from "./remedies.js";
import type { WorkflowStore } from "./store.js";

export const INVALID_OUTPUT_NOTE =
  "The previous attempt of this stage was rejected as invalid output with the diagnostic below. Correct what it names in this attempt.";
/**
 * The repeat key of the last invalid-output note: the diagnostic's hash and the run inputs a person
 * can change without touching the prompt (`invalidOutputInputs`). A resume whose key equals it
 * repeats the attempt (#1348, #2191).
 */
export const INVALID_OUTPUT_KEY = "invalid-output/repeat-key.json";

/**
 * The run inputs besides the prompt that a person can change after an invalid output, for the
 * repeat key: the routing revision (a reroute). A new way to change a run's input without the
 * prompt adds its revision here (AGENTS.md).
 */
export function invalidOutputInputs(store: WorkflowStore, runId: string): { routing: number } {
  return { routing: store.latestArtifact(runId, ROUTING_ARTIFACT)?.revision ?? 0 };
}

/**
 * What a plain resume after the run's latest stop would note, and whether it would repeat the last
 * resume: the prompt already holds this diagnostic's note and the recorded key equals it, so the
 * attempt after that resume stopped the same way. Null when the run recorded no diagnostic. It
 * writes nothing, so the run views can ask before a person presses retry (#2201); the resume
 * itself (`noteInvalidOutput`) records the note and the key.
 */
export function invalidOutputRepeat(
  store: WorkflowStore,
  runId: string,
): { note: string; key: string; repeats: boolean } | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return null;
  const diagnostic = store.readArtifact(runId, latest.id).trim().slice(0, 2000);
  if (!diagnostic) return null;
  const note = `\n${INVALID_OUTPUT_NOTE}\n${canonical({ diagnostic })}`;
  const inputs = invalidOutputInputs(store, runId);
  const key = canonical({ diagnostic: hashBytes(diagnostic), inputs });
  if (!store.state(runId).prompt.includes(note)) return { note, key, repeats: false };
  const recorded = store.latestArtifact(runId, INVALID_OUTPUT_KEY);
  // A note from before the key was recorded was given with the run's first routing.
  const previous = recorded
    ? store.readArtifact(runId, recorded.id)
    : canonical({
        diagnostic: hashBytes(diagnostic),
        inputs: { ...inputs, routing: Math.min(inputs.routing, 1) },
      });
  return { note, key, repeats: previous === key };
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
