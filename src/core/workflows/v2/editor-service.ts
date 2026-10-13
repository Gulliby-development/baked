/**
 * The workflow definition editor for front ends that keep no editor state of their own (the
 * desktop app through `POST /v1/workflow/editor*`). Each request names the definition it was
 * opened from and carries the working copy; the edit runs through the same functions as the
 * terminal editor (src/core/workflows/v2/editor.ts) and the answer is a view to render.
 */
import type { PastRun } from "../estimate.js";
import type { RunPolicy } from "../schemas.js";
import { effectiveMode, type Outcome, type Stage, type WorkflowV2 } from "./definition.js";
import {
  addGate,
  addTransition,
  bindingsAt,
  changeStageField,
  confirmsAutoApproval,
  definitionText,
  duplicateAsCustom,
  type EditorState,
  type EditResult,
  estimateDefinition,
  type GateTarget,
  gateSummary,
  type InsertableStage,
  insertStage,
  insertWaitStage,
  moveGate,
  openEditor,
  type ProblemGroup,
  pickerOptions,
  prepareSave,
  readEditorSource,
  removeGate,
  removeStage,
  removeTransition,
  removeWaitStage,
  type SaveReview,
  type StageField,
  setLoopRounds,
  stageFields,
  targetName,
  targetsOf,
  toggleMode,
  transitionChoices,
  transitionOf,
  validateEditor,
  writeDefinitionFile,
} from "./editor.js";

export type EditorOp =
  | { op: "addGate"; target: GateTarget; gateId: string }
  | { op: "removeGate"; target: GateTarget; index: number }
  | { op: "moveGate"; target: GateTarget; index: number; delta: -1 | 1 }
  | { op: "toggleMode"; target: GateTarget; index: number }
  | { op: "addTransition"; from: string; to: string; on: Outcome; loop: number | null }
  | { op: "removeTransition"; id: string }
  | { op: "addWaitStage"; after: string }
  | { op: "removeWaitStage"; stageId: string }
  | { op: "addStage"; stageType: InsertableStage; transition: string }
  | { op: "removeStage"; stageId: string }
  | { op: "changeField"; stageId: string; key: string; delta: -1 | 1 }
  | { op: "setLoop"; id: string; rounds: number }
  | { op: "duplicate" };

export interface EditorRequest {
  /** The definition ID the editor was opened with. */
  from: string;
  /** The working copy is an unsaved custom copy of `from` ("Duplicate as custom"). */
  copy?: boolean;
  /** The working copy as the last view returned it; absent on open. */
  definition?: WorkflowV2;
}

export interface BindingView {
  gateId: string;
  /** The mode a run applies. */
  mode: "required" | "advisory" | "unknown";
  /** This workflow overrides the library default. */
  override: boolean;
  summary: string | null;
}
export interface TargetView {
  target: GateTarget;
  name: string;
  /** For a transition: where it goes, on which outcome, and its loop bound. */
  transition: { to: string; on: Outcome; loop: number | null } | null;
  bindings: BindingView[];
  /** Library gates for the picker, bindable ones first, each with why it cannot be bound. */
  options: { gateId: string; summary: string; disabled: string | null }[];
}
export interface StageView {
  id: string;
  type: Stage["type"];
  produces: string;
  fields: StageField[];
  targets: TargetView[];
  /** Choices of the new-transition form from this stage. */
  transitionChoices: { to: string[]; on: Outcome[]; loop: (number | null)[] };
}
export interface EditorView {
  id: string;
  from: string;
  copy: boolean;
  definition: WorkflowV2;
  /** Why it cannot be changed in place; duplicate it to edit. Null when it can. */
  readOnly: string | null;
  /** The working copy differs from the file. */
  dirty: boolean;
  stages: StageView[];
  problems: ProblemGroup[];
  estimate: string;
}

/** Rebuilds the editor state a request describes. Throws for an unknown definition ID. */
export function editorState(
  workspace: string,
  policy: RunPolicy,
  request: EditorRequest,
  options: Parameters<typeof readEditorSource>[3] = {},
): EditorState {
  let state = openEditor(readEditorSource(workspace, request.from, policy, options));
  if (request.copy) state = duplicateAsCustom(state);
  if (request.definition)
    state = {
      ...state,
      id: request.copy ? request.definition.id : state.id,
      definition: request.definition,
    };
  return { ...state, dirty: definitionText(state.definition) !== state.savedText };
}

function binding(state: EditorState, target: GateTarget): BindingView[] {
  return bindingsAt(state.definition, target).map((b) => {
    const view = state.library.get(b.gateId);
    return {
      gateId: b.gateId,
      mode: view ? effectiveMode(b, view.gate) : "unknown",
      override: b.mode !== undefined,
      summary: view ? gateSummary(view) : null,
    };
  });
}

export function editorView(
  state: EditorState,
  request: EditorRequest,
  history: PastRun[] | null,
): EditorView {
  const definition = state.definition;
  return {
    id: state.id,
    from: request.from,
    copy: request.copy === true || state.id !== request.from,
    definition,
    readOnly: state.readOnly,
    dirty: state.dirty,
    stages: definition.stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      produces: stage.produces,
      fields: stageFields(state, stage.id),
      targets: targetsOf(definition, stage.id).map((target) => {
        const transition = transitionOf(definition, target);
        return {
          target,
          name: targetName(target),
          transition: transition
            ? {
                to: transition.to,
                on: transition.on,
                loop: transition.loop?.maxIterations ?? null,
              }
            : null,
          bindings: binding(state, target),
          options: pickerOptions(state, target, "").map((o) => ({
            gateId: o.gate.id,
            summary: o.summary,
            disabled: o.disabled,
          })),
        };
      }),
      transitionChoices: transitionChoices(definition, stage.id),
    })),
    problems: validateEditor(state),
    estimate: estimateDefinition(definition, history).label,
  };
}

export function applyEditorOp(state: EditorState, op: EditorOp): EditResult {
  switch (op.op) {
    case "addGate":
      return addGate(state, op.target, op.gateId);
    case "removeGate":
      return removeGate(state, op.target, op.index);
    case "moveGate":
      return moveGate(state, op.target, op.index, op.delta);
    case "toggleMode":
      return toggleMode(state, op.target, op.index);
    case "addTransition":
      return addTransition(state, op.from, { to: op.to, on: op.on, loop: op.loop });
    case "removeTransition":
      return removeTransition(state, op.id);
    case "addWaitStage":
      return insertWaitStage(state, op.after);
    case "addStage":
      return insertStage(state, op.transition, op.stageType);
    case "removeStage":
      return removeStage(state, op.stageId);
    case "removeWaitStage":
      return removeWaitStage(state, op.stageId);
    case "changeField":
      return changeStageField(state, op.stageId, op.key, op.delta);
    case "setLoop":
      return setLoopRounds(state, op.id, op.rounds);
    case "duplicate":
      return { state: duplicateAsCustom(state) };
  }
}

/** What Save shows before it writes: the problems, "unchanged", or the diff and gates to confirm. */
export const reviewEditor = (state: EditorState, workspace: string): SaveReview =>
  prepareSave(state, workspace);

export type SaveOutcome =
  | { saved: true; path: string }
  | { saved: false; review: SaveReview; confirmationNeeded: boolean };

/**
 * Writes the working copy when `prepareSave` allows it: valid, changed, and with any new auto
 * approval limits confirmed by the typed hash prefix. Otherwise returns the review to show.
 */
export function saveEditor(
  state: EditorState,
  workspace: string,
  confirm: string | undefined,
): SaveOutcome {
  const review = prepareSave(state, workspace);
  if (review.kind !== "review") return { saved: false, review, confirmationNeeded: false };
  if (review.autoApproval && !confirmsAutoApproval(confirm ?? "", review.autoApproval.hash))
    return { saved: false, review, confirmationNeeded: true };
  return { saved: true, path: writeDefinitionFile(workspace, state.definition) };
}
