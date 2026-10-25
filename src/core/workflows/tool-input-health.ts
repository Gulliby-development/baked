import type { RouteEffort } from "../llm/model-routing.js";
import { canonical, hashJson } from "../specs/hash.js";
import { type LadderRung, nextRung } from "./stall-ladder.js";
import type { WorkflowStore } from "./store.js";

/**
 * Invalid and decoded tool inputs per model (#2149). The executor keeps every submission the
 * result schema refused as `attempts/<id>/invalid-N.json` (#1871) and every call whose fields
 * arrived as JSON text as `coerced-N.json` (#2141); a model that keeps sending malformed
 * submissions otherwise shows up only as lost rounds.
 */
export interface ToolInputCounts {
  model: string;
  /** Submissions the result schema refused. */
  invalid: number;
  /** Tool calls whose fields were decoded from JSON text before validation. */
  coerced: number;
}

/** Invalid inputs of one model in a run at which the shadow ladder records the rung it would take. */
export const TOOL_INPUT_THRESHOLD = 3;
/** One shadow record per model: `recovery/tool-inputs/<hash>.json`. */
export const TOOL_INPUT_SIGNAL_DIR = "recovery/tool-inputs/";

/**
 * What the recovery ladder would do when a model's invalid inputs reach the threshold. Shadow
 * only: the run is placed as before, and the record is the data for promoting the signal.
 */
export interface ToolInputSignal extends ToolInputCounts {
  mode: "shadow";
  threshold: number;
  /** The attempt whose invalid input reached the threshold. */
  attemptId: string;
  /**
   * The ladder's first rung that changes something for the model (`nextRung`). The executor
   * does not know the route's later models, so `next-model` stands for "another model".
   */
  rung: LadderRung;
}

const ATTEMPT_FILE = /^attempts\/([^/]+)\/(invalid|coerced)-\d+\.json$/;

/** Invalid and decoded inputs per model of the run, most invalid first; models with none are left out. */
export function toolInputCounts(
  store: Pick<WorkflowStore, "attempts" | "latestArtifacts">,
  runId: string,
  attemptIds?: ReadonlySet<string>,
): ToolInputCounts[] {
  const models = new Map(store.attempts(runId).map((a) => [a.id, a.model_id ?? "(host)"]));
  const counts = new Map<string, ToolInputCounts>();
  for (const row of [
    ...store.latestArtifacts(runId, "attempts/%/invalid-%.json"),
    ...store.latestArtifacts(runId, "attempts/%/coerced-%.json"),
  ]) {
    const match = ATTEMPT_FILE.exec(row.logical_path);
    if (!match?.[1] || (attemptIds && !attemptIds.has(match[1]))) continue;
    const model = models.get(match[1]);
    if (!model) continue;
    const entry = counts.get(model) ?? { model, invalid: 0, coerced: 0 };
    if (match[2] === "invalid") entry.invalid++;
    else entry.coerced++;
    counts.set(model, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.invalid - a.invalid || b.coerced - a.coerced || a.model.localeCompare(b.model),
  );
}

/** The models' counts as the usage summary prints them: "codex/a 3 invalid, 1 decoded". */
export function toolInputsLine(counts: readonly ToolInputCounts[]): string | null {
  return counts.length
    ? counts.map((c) => `${c.model} ${c.invalid} invalid, ${c.coerced} decoded`).join("; ")
    : null;
}

export function toolInputSignalPath(model: string): string {
  return `${TOOL_INPUT_SIGNAL_DIR}${hashJson({ model })}.json`;
}

/**
 * Records, once per model and run, the rung the ladder would take when the model's invalid
 * inputs reach `TOOL_INPUT_THRESHOLD`. Returns the record it wrote, or null.
 */
export function recordToolInputSignal(
  store: Pick<WorkflowStore, "attempts" | "latestArtifacts" | "latestArtifact" | "artifact">,
  runId: string,
  attemptId: string,
  model: string,
  effort: RouteEffort | undefined,
  threshold = TOOL_INPUT_THRESHOLD,
): ToolInputSignal | null {
  const path = toolInputSignalPath(model);
  if (store.latestArtifact(runId, path)) return null;
  const counts = toolInputCounts(store, runId).find((c) => c.model === model);
  if (!counts || counts.invalid < threshold) return null;
  const rung =
    nextRung(undefined, { model, models: [model], fallbackIndex: 0, effort })?.rung ?? "next-model";
  const signal: ToolInputSignal = { mode: "shadow", ...counts, threshold, attemptId, rung };
  store.artifact(runId, "recovery", path, canonical(signal));
  return signal;
}
