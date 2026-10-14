import type { RunPolicy } from "../schemas.js";
import type { WorkflowV2 } from "./definition.js";
import {
  addGate,
  bindingsAt,
  bindRestriction,
  duplicateAsCustom,
  type GateTarget,
  openEditor,
  readEditorSource,
  targetsOf,
  transitionOf,
  validateEditor,
  writeDefinitionFile,
} from "./editor.js";

/**
 * Where a gate can go in a workflow, in words, and binding it there (#372). Every front end (the
 * desktop gate setup, `baked workflow gate bind`, the TUI editor) uses these and the editor's own
 * rules, so a place offered is a place the validator accepts.
 */

export interface GatePlace {
  /** `stage:ID` or `transition:ID`. */
  key: string;
  target: GateTarget;
  /** Where it runs, in plain words. */
  label: string;
  /** The gate is already bound here. */
  bound: boolean;
  /** Why the gate cannot go here; null when it can. */
  disabled: string | null;
}

export interface GatePlaces {
  workflowId: string;
  /** A built-in or schema 1 workflow is copied as a custom one when a gate is bound to it. */
  copyTo: string | null;
  /**
   * Set when a check stage of the workflow has no checks: a binding anywhere but in that stage is
   * refused until a check is added, so the front end says so before a place is picked.
   */
  needsChecks: string | null;
  places: GatePlace[];
}

export const placeKey = (target: GateTarget): string =>
  target.kind === "stage" ? `stage:${target.stageId}` : `transition:${target.id}`;

function placeLabel(source: ReturnType<typeof openEditor>, target: GateTarget): string {
  if (target.kind === "stage") return `In the ${target.stageId} stage`;
  const t = transitionOf(source.definition, target);
  if (!t) return target.id;
  const to = t.to === "done" ? "the run finishes" : `${t.to} starts`;
  return `After ${t.from} (${t.on}), before ${to}`;
}

/** Check stages without a gate; a workflow saved with one fails validation (#1103). */
function emptyCheckStages(definition: WorkflowV2): string[] {
  return definition.stages.filter((s) => s.type === "check" && !s.gates.length).map((s) => s.id);
}

const NO_CHECKS_YET = (stageId: string) => `the ${stageId} stage has no checks yet`;

/** Every place of the workflow a gate list lives, with whether `gateId` can go there. */
export function gatePlaces(
  workspace: string,
  workflowId: string,
  gateId: string,
  policy: RunPolicy,
): GatePlaces {
  const state = openEditor(readEditorSource(workspace, workflowId, policy));
  const view = state.library.get(gateId);
  if (!view) throw new Error(`No gate ${gateId}`);
  const targets = state.definition.stages.flatMap((s) => targetsOf(state.definition, s.id));
  const empty = emptyCheckStages(state.definition);
  // Binding into an empty check stage fills it; anywhere else leaves it empty and bindGate refuses.
  const leftEmpty = (target: GateTarget) =>
    empty.find((id) => target.kind !== "stage" || target.stageId !== id) ?? null;
  const places = targets.map((target) => {
    const bound = bindingsAt(state.definition, target).some((b) => b.gateId === gateId);
    const restriction = bound ? null : bindRestriction(state.definition, target, view.gate);
    const unfilled = bound || restriction ? null : leftEmpty(target);
    return {
      key: placeKey(target),
      target,
      label: placeLabel(state, target),
      bound,
      disabled: restriction ?? (unfilled ? NO_CHECKS_YET(unfilled) : null),
    };
  });
  const first = empty[0];
  const fills = places.some((p) => !p.disabled && !p.bound);
  return {
    workflowId: state.id,
    copyTo: state.readOnly ? duplicateAsCustom(state).id : null,
    needsChecks: first
      ? `The ${first} stage of ${state.id} has no checks yet. Add a check first (New check in Gates and checks, or checks in the workflow policy)${fills ? `, or put this gate in the ${first} stage` : ""}.`
      : null,
    places,
  };
}

/**
 * Binds a library gate at one place and saves the workflow. A read-only workflow (`sdd`, a preset,
 * a schema 1 file) is first copied as `<id>-custom`, the editor's "Duplicate as custom".
 */
export function bindGate(
  workspace: string,
  workflowId: string,
  gateId: string,
  key: string,
  policy: RunPolicy,
): { workflowId: string; path: string; copiedFrom: string | null } {
  let state = openEditor(readEditorSource(workspace, workflowId, policy));
  const copiedFrom = state.readOnly ? state.id : null;
  if (state.readOnly) state = duplicateAsCustom(state);
  const target = state.definition.stages
    .flatMap((s) => targetsOf(state.definition, s.id))
    .find((t) => placeKey(t) === key);
  if (!target) throw new Error(`${state.id} has no place ${key}`);
  const result = addGate(state, target, gateId);
  if (result.error) throw new Error(result.error);
  // Problems the workflow already had (a check stage without checks, say) are not this binding's.
  const flat = (s: typeof state) =>
    validateEditor(s).flatMap((g) => g.messages.map((m) => `${g.owner}: ${m}`));
  const before = new Set(flat(state));
  const problems = flat(result.state).filter((p) => !before.has(p));
  if (problems.length) throw new Error(problems.join("; "));
  const [empty] = emptyCheckStages(result.state.definition);
  if (empty)
    throw new Error(
      `The ${empty} stage has no checks yet; add one (workflow policy checks) before binding gates to ${result.state.id}`,
    );
  writeDefinitionFile(workspace, result.state.definition);
  return {
    workflowId: result.state.id,
    path: `baked/workflows/${result.state.id}.json`,
    copiedFrom,
  };
}
