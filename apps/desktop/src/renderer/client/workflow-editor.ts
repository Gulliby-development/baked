/**
 * The workflow definition editor of the project's backend (`POST /v1/workflow/editor*`,
 * `workflow-editor` capability). The backend keeps no editor state: each call sends the
 * definition it was opened from and the working copy, and gets back the view to render, built by
 * the same code as the terminal editor (src/core/workflows/v2/editor-service.ts).
 */
import { call } from "./api.js";
import { offers, WORKFLOW_EDITOR_CAPABILITY } from "./capabilities.js";

export type GateTarget = { kind: "stage"; stageId: string } | { kind: "transition"; id: string };
export type Outcome = "passed" | "failed" | "changes_requested";
export type StageType =
  | "agent"
  | "tasks"
  | "check"
  | "wait"
  | "approval"
  | "review"
  | "reflection"
  | "learn";

/** The working copy: a schema 2 definition. The editor only sends it back. */
export interface WorkingCopy {
  id: string;
  stages: { id: string; type: string }[];
  transitions: { id: string; from: string; to: string; gates: { gateId: string }[] }[];
  [key: string]: unknown;
}

export interface StageField {
  key: string;
  label: string;
  value: string;
  /** What changing it does. */
  hint: string;
}

export interface BindingView {
  gateId: string;
  mode: "required" | "advisory" | "unknown";
  /** This workflow overrides the gate's default mode. */
  override: boolean;
  summary: string | null;
}

export interface TargetView {
  target: GateTarget;
  name: string;
  transition: { to: string; on: Outcome; loop: number | null } | null;
  bindings: BindingView[];
  options: { gateId: string; summary: string; disabled: string | null }[];
}

export interface StageView {
  id: string;
  type: StageType;
  produces: string;
  fields: StageField[];
  targets: TargetView[];
  transitionChoices: { to: string[]; on: Outcome[]; loop: (number | null)[] };
}

export interface ProblemGroup {
  /** "stage ID", "transition ID" or "definition". */
  owner: string;
  messages: string[];
}

export interface EditorView {
  id: string;
  from: string;
  copy: boolean;
  definition: WorkingCopy;
  readOnly: string | null;
  dirty: boolean;
  stages: StageView[];
  problems: ProblemGroup[];
  estimate: string;
}

export type EditorOp =
  | { op: "addGate"; target: GateTarget; gateId: string }
  | { op: "removeGate"; target: GateTarget; index: number }
  | { op: "moveGate"; target: GateTarget; index: number; delta: -1 | 1 }
  | { op: "toggleMode"; target: GateTarget; index: number }
  | { op: "addTransition"; from: string; to: string; on: Outcome; loop: number | null }
  | { op: "removeTransition"; id: string }
  | { op: "addWaitStage"; after: string }
  | { op: "removeWaitStage"; stageId: string }
  | { op: "changeField"; stageId: string; key: string; delta: -1 | 1 }
  | { op: "duplicate" };

export type SaveReview =
  | { kind: "read-only"; message: string }
  | { kind: "problems"; groups: ProblemGroup[] }
  | { kind: "unchanged" }
  | {
      kind: "review";
      path: string;
      text: string;
      diff: string[];
      gates: string[];
      autoApproval: { hash: string; prefix: string; limits: string } | null;
    };

export type SaveOutcome =
  | { saved: true; path: string; view: EditorView }
  | { saved: false; review: SaveReview; confirmationNeeded: boolean; view: EditorView };

const working = (view: EditorView) => ({
  from: view.from,
  ...(view.copy ? { copy: true } : {}),
  definition: view.definition,
});

export const workflowEditor = {
  /** Whether the backend has the editor; null when its health cannot be read. */
  offered: async (key: string): Promise<boolean | null> => {
    try {
      const health = await call<{ capabilities?: string[] }>(key, "GET", "/v1/health");
      return offers(health.capabilities ?? null, WORKFLOW_EDITOR_CAPABILITY);
    } catch {
      return null;
    }
  },
  open: (key: string, id: string) =>
    call<{ view: EditorView }>(key, "POST", "/v1/workflow/editor", { from: id }),
  /** Applies one edit; a refused edit comes back as `error` with the view unchanged. */
  edit: (key: string, view: EditorView, op: EditorOp) =>
    call<{ view: EditorView; error?: string }>(key, "POST", "/v1/workflow/editor", {
      ...working(view),
      op,
    }),
  review: async (key: string, view: EditorView) =>
    (await call<{ review: SaveReview }>(key, "POST", "/v1/workflow/editor/review", working(view)))
      .review,
  /** Writes `baked/workflows/ID.json`; new auto approval limits need `confirm`, the hash prefix. */
  save: (key: string, view: EditorView, confirm?: string) =>
    call<SaveOutcome>(key, "POST", "/v1/workflow/editor/save", {
      ...working(view),
      ...(confirm ? { confirm } : {}),
    }),
};
