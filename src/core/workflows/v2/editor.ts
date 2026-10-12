/**
 * The workflow editor window (docs/workflows/v2-design.md, section 7) as pure
 * state transitions. The terminal UI renders an `EditorState` and dispatches the functions below;
 * every rule (validation, picker restrictions, effective modes, the estimate, the save review and
 * the auto approval confirmation) lives here, so the window holds no logic of its own. Reading and
 * writing files is limited to `readEditorSource` and `writeDefinitionFile`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { builtinProfiles } from "../../agents/profiles/builtin.js";
import { ProfileRegistry } from "../../agents/profiles/registry.js";
import { writeViaTemp } from "../atomic-write.js";
import { defaultWorkflowPolicy } from "../defaults.js";
import {
  DEFAULT_STAGE_RANGES,
  type PastRun,
  pricesFrom,
  rangeText,
  type TokenRange,
} from "../estimate.js";
import { type RunPolicy, SafeId } from "../schemas.js";
import {
  effectiveMode,
  type Gate,
  type GateBinding,
  type Outcome,
  PRESETS,
  STAGE_OUTCOMES,
  type Stage,
  type Transition,
  validateWorkflowV2,
  type WorkflowV2,
  WorkflowV2Schema,
} from "./definition.js";
import { asV2, loadDefinition } from "./definitions.js";
import { type GateSource, gateDirectories, loadGateLibrary, readConfirmations } from "./library.js";
import {
  autoApprovalHash,
  bindingsOf,
  describeAutoApproval,
  KIND_OUTPUT,
  stageKind,
} from "./runtime.js";

/** A transition holds at most this many gates (the schema's bound). */
export const MAX_TRANSITION_GATES = 12;
/** How many leading characters of the limits hash the person types to confirm auto approval. */
export const CONFIRM_PREFIX = 12;
/** The limits an approval stage gets when the editor switches it to automatic, from section 5.2. */
export const DEFAULT_AUTO_LIMITS: NonNullable<WorkflowV2["autoApproval"]> = {
  enabled: true,
  maxTasks: 3,
  maxFiles: 5,
  allowedPaths: ["src/**", "tests/**", "docs/**"],
  allowDelete: false,
  allowNewDependencies: false,
  maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens,
};

export interface LibraryGateView {
  gate: Gate;
  source: GateSource;
  /** False for a project gate whose current definition nobody in this workspace confirmed yet. */
  confirmed: boolean;
}
export interface ProfileChoice {
  id: string;
  output: string;
}
/** Everything the editor reads from disk to open one definition. */
export interface EditorSource {
  id: string;
  definition: WorkflowV2;
  /** The text of `baked/workflows/ID.json` when it holds this definition, else null. */
  savedText: string | null;
  /** Why the definition cannot be changed in place (a built-in, or a schema 1 file); null when it can. */
  readOnly: string | null;
  library: LibraryGateView[];
  profiles: ProfileChoice[];
  /** Definition IDs already in use, so a duplicate gets a free one. */
  takenIds: string[];
}

export type Pane = "stages" | "transitions" | "gates";
export const PANES: readonly Pane[] = ["stages", "transitions", "gates"];
/** Where a gate list lives: the stage gates of a check or review stage, or a transition. */
export type GateTarget = { kind: "stage"; stageId: string } | { kind: "transition"; id: string };

export interface EditorState {
  id: string;
  definition: WorkflowV2;
  savedText: string | null;
  readOnly: string | null;
  library: ReadonlyMap<string, LibraryGateView>;
  profiles: ProfileChoice[];
  takenIds: string[];
  pane: Pane;
  stage: number;
  target: number;
  gate: number;
  dirty: boolean;
  /** Past runs of the project, once the worker returned them; null means no estimate. */
  history: PastRun[] | null;
}
export interface EditResult {
  state: EditorState;
  /** Set when the edit was refused; the state is then unchanged. */
  error?: string;
}

export const definitionPath = (workspace: string, id: string): string =>
  join(workspace, "baked", "workflows", `${id}.json`);
export const definitionText = (definition: WorkflowV2): string =>
  `${JSON.stringify(definition, null, 2)}\n`;

/**
 * Reads what the editor needs for one definition ID. A project file of schema 2 opens for editing;
 * `sdd`, the shipped presets and schema 1 files open read only, ready to be duplicated. Throws for
 * an unknown ID or a file that does not parse.
 */
/** The gate library as the editor lists it, with whether each project gate is confirmed here. */
export function libraryViews(
  workspace: string,
  policy: RunPolicy,
  directories = gateDirectories(workspace),
): LibraryGateView[] {
  const library = loadGateLibrary(workspace, policy, directories);
  const confirmations = readConfirmations(workspace);
  return [...library.entries.values()].map((entry) => ({
    gate: entry.gate,
    source: entry.source,
    confirmed: entry.source !== "project" || confirmations[entry.gate.id] === entry.hash,
  }));
}

export function readEditorSource(
  workspace: string,
  id: string,
  policy: RunPolicy,
  options: {
    gateDirectories?: { user: string; project: string };
    profileDirectory?: string;
  } = {},
): EditorSource {
  const loaded = loadDefinition(workspace, SafeId.parse(id), policy);
  const readOnly =
    loaded.path === null
      ? "Built-in workflows are read only. Press C to duplicate this one as a custom workflow."
      : loaded.schemaVersion === 1
        ? "This file uses schema 1. Press C to duplicate it as a schema 2 workflow."
        : null;
  let profiles: ProfileChoice[];
  try {
    profiles = new ProfileRegistry(workspace, { active: "none" }, options.profileDirectory)
      .list()
      .map((p) => ({ id: p.profile.id, output: p.profile.output }));
  } catch {
    // A broken profile file elsewhere must not keep the editor closed; the built-ins still apply.
    profiles = builtinProfiles.map((p) => ({ id: p.id, output: p.output }));
  }
  const directory = join(workspace, "baked", "workflows");
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
    : [];
  return {
    id: loaded.id,
    definition: asV2(loaded, policy),
    savedText: loaded.path && loaded.schemaVersion === 2 ? readFileSync(loaded.path, "utf8") : null,
    readOnly,
    library: libraryViews(workspace, policy, options.gateDirectories),
    profiles,
    takenIds: [...new Set(["sdd", ...PRESETS, ...files])],
  };
}

export function openEditor(source: EditorSource): EditorState {
  return {
    id: source.id,
    definition: source.definition,
    savedText: source.savedText,
    readOnly: source.readOnly,
    library: new Map(source.library.map((g) => [g.gate.id, g])),
    profiles: source.profiles,
    takenIds: source.takenIds,
    pane: "stages",
    stage: 0,
    target: 0,
    gate: 0,
    dirty: false,
    history: null,
  };
}

/** The editor after the gate library changed on disk, for example after a new gate was saved. */
export const withLibrary = (state: EditorState, library: LibraryGateView[]): EditorState => ({
  ...state,
  library: new Map(library.map((g) => [g.gate.id, g])),
});

export const withHistory = (state: EditorState, history: PastRun[] | null): EditorState => ({
  ...state,
  history,
});

// --- Selection -------------------------------------------------------------------------------

export function selectedStage(state: EditorState): Stage | undefined {
  return state.definition.stages[state.stage];
}

/** The gate lists of a stage: its own gates (check and review stages), then its outgoing transitions. */
export function targetsOf(definition: WorkflowV2, stageId: string): GateTarget[] {
  const stage = definition.stages.find((s) => s.id === stageId);
  const own: GateTarget[] =
    stage && (stage.type === "check" || stage.type === "review")
      ? [{ kind: "stage", stageId: stage.id }]
      : [];
  return [
    ...own,
    ...definition.transitions
      .filter((t) => t.from === stageId)
      .map((t): GateTarget => ({ kind: "transition", id: t.id })),
  ];
}
export function selectedTarget(state: EditorState): GateTarget | undefined {
  const stage = selectedStage(state);
  return stage ? targetsOf(state.definition, stage.id)[state.target] : undefined;
}
export function transitionOf(definition: WorkflowV2, target: GateTarget): Transition | undefined {
  return target.kind === "transition"
    ? definition.transitions.find((t) => t.id === target.id)
    : undefined;
}
export function bindingsAt(definition: WorkflowV2, target: GateTarget): GateBinding[] {
  if (target.kind === "transition") return transitionOf(definition, target)?.gates ?? [];
  const stage = definition.stages.find((s) => s.id === target.stageId);
  return stage && (stage.type === "check" || stage.type === "review") ? stage.gates : [];
}
export const targetName = (target: GateTarget): string =>
  target.kind === "stage" ? `stage ${target.stageId}` : target.id;

function clampSelection(state: EditorState): EditorState {
  const stages = state.definition.stages.length;
  const stage = Math.max(0, Math.min(state.stage, stages - 1));
  const stageId = state.definition.stages[stage]?.id;
  const targets = stageId ? targetsOf(state.definition, stageId) : [];
  const target = Math.max(0, Math.min(state.target, targets.length - 1));
  const current = targets[target];
  const gates = current ? bindingsAt(state.definition, current).length : 0;
  const gate = Math.max(0, Math.min(state.gate, gates - 1));
  return { ...state, stage, target, gate };
}

/** Moves the cursor of the active pane; a new stage or transition resets the panes to its right. */
export function moveCursor(state: EditorState, delta: number): EditorState {
  const wrap = (value: number, size: number): number =>
    size === 0 ? 0 : (((value + delta) % size) + size) % size;
  if (state.pane === "stages")
    return clampSelection({
      ...state,
      stage: wrap(state.stage, state.definition.stages.length),
      target: 0,
      gate: 0,
    });
  const stage = selectedStage(state);
  const targets = stage ? targetsOf(state.definition, stage.id) : [];
  if (state.pane === "transitions")
    return clampSelection({ ...state, target: wrap(state.target, targets.length), gate: 0 });
  const target = targets[state.target];
  const size = target ? bindingsAt(state.definition, target).length : 0;
  return clampSelection({ ...state, gate: wrap(state.gate, size) });
}
export function switchPane(state: EditorState, delta: number): EditorState {
  const index = (PANES.indexOf(state.pane) + delta + PANES.length) % PANES.length;
  return { ...state, pane: PANES[index] ?? "stages" };
}

// --- Validation ------------------------------------------------------------------------------

export interface ProblemGroup {
  /** "stage ID", "transition ID" or "definition". */
  owner: string;
  messages: string[];
}

/**
 * Problems of the working copy: the schema first (an edit can, for example, empty the gate list of
 * a check stage), then the same validator a run start uses. Each message is attached to the stage
 * or transition it names, so the window can list them where they belong.
 */
export function validateEditor(state: EditorState): ProblemGroup[] {
  const definition = state.definition;
  const gates = new Map([...state.library].map(([id, view]) => [id, view.gate]));
  const messages: { owner: string | null; message: string }[] = [];
  const parsed = WorkflowV2Schema.safeParse(definition);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const [collection, index] = issue.path;
      const owner =
        collection === "stages" && typeof index === "number"
          ? `stage ${definition.stages[index]?.id ?? index}`
          : collection === "transitions" && typeof index === "number"
            ? `transition ${definition.transitions[index]?.id ?? index}`
            : null;
      const field = issue.path.slice(2).join(".");
      const message =
        issue.code === "too_small" && issue.path.at(-1) === "gates"
          ? "needs at least one gate"
          : `${field ? `${field}: ` : ""}${issue.message}`;
      messages.push({ owner, message });
    }
  for (const message of validateWorkflowV2(definition, gates))
    messages.push({ owner: ownerOf(definition, message), message });
  const groups = new Map<string, string[]>();
  for (const { owner, message } of messages) {
    const key = owner ?? "definition";
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  return [...groups].map(([owner, list]) => ({ owner, messages: [...new Set(list)] }));
}
export const problemCount = (groups: readonly ProblemGroup[]): number =>
  groups.reduce((sum, g) => sum + g.messages.length, 0);

/** The transition or stage a validator message names first, as "transition ID" or "stage ID". */
function ownerOf(definition: WorkflowV2, message: string): string | null {
  const words = message.split(/[\s:,]+/);
  const transitions = new Set(definition.transitions.map((t) => t.id));
  const stages = new Set(definition.stages.map((s) => s.id));
  for (const word of words) if (transitions.has(word)) return `transition ${word}`;
  for (const word of words) if (stages.has(word)) return `stage ${word}`;
  return null;
}

// --- Gate picker -----------------------------------------------------------------------------

export interface PickerOption {
  gate: Gate;
  source: GateSource;
  /** Type, default mode, scope, timeout and source on one line. */
  summary: string;
  /** Why the gate cannot be bound here; null when it can. */
  disabled: string | null;
}

export function gateSummary(view: LibraryGateView): string {
  const gate = view.gate;
  const type =
    gate.type === "ai-review"
      ? "AI review"
      : gate.type === "ai-acceptance"
        ? "AI walk-through"
        : gate.type;
  const source =
    view.source === "project" && !view.confirmed ? "project, unconfirmed" : view.source;
  return `${type} · ${gate.required ? "required" : "advisory"} · ${gate.scope} · ${Math.round(gate.timeoutMs / 1000)}s · ${source}`;
}

/** Why `gate` cannot be bound to `target`, by the same rules the validator applies; null when it can. */
export function bindRestriction(
  definition: WorkflowV2,
  target: GateTarget,
  gate: Gate,
): string | null {
  const bound = bindingsAt(definition, target);
  if (bound.some((b) => b.gateId === gate.id)) return "already bound here";
  if (target.kind === "stage") {
    const stage = definition.stages.find((s) => s.id === target.stageId);
    if (stage?.type === "check" && gate.type !== "command")
      return "a check stage runs command gates only";
    if (stage?.type === "review" && gate.type !== "ai-review")
      return "a review stage runs AI review gates only";
    if (gate.scope === "task") return "a task gate runs after each task, not in a stage";
    return null;
  }
  const transition = transitionOf(definition, target);
  const from = definition.stages.find((s) => s.id === transition?.from);
  if (gate.type === "ai-review") return "AI review gates belong to a review stage";
  if (gate.scope === "task" && from?.type !== "tasks")
    return `a task gate only follows a tasks stage; ${from?.id ?? "this stage"} is ${from?.type ?? "unknown"}`;
  if (bound.length >= MAX_TRANSITION_GATES)
    return `a transition holds at most ${MAX_TRANSITION_GATES} gates`;
  return null;
}

/** Library gates matching `query` (ID, type or description), bindable ones first. */
export function pickerOptions(
  state: EditorState,
  target: GateTarget,
  query: string,
): PickerOption[] {
  const needle = query.trim().toLowerCase();
  return [...state.library.values()]
    .filter(
      (view) =>
        !needle ||
        `${view.gate.id} ${view.gate.type} ${view.gate.description}`.toLowerCase().includes(needle),
    )
    .map((view) => ({
      gate: view.gate,
      source: view.source,
      summary: gateSummary(view),
      disabled: bindRestriction(state.definition, target, view.gate),
    }))
    .sort(
      (a, b) =>
        Number(a.disabled !== null) - Number(b.disabled !== null) ||
        a.gate.id.localeCompare(b.gate.id),
    );
}

// --- Edits -----------------------------------------------------------------------------------

function edit(
  state: EditorState,
  change: (definition: WorkflowV2) => WorkflowV2 | string,
): EditResult {
  if (state.readOnly) return { state, error: state.readOnly };
  const next = change(state.definition);
  if (typeof next === "string") return { state, error: next };
  return { state: clampSelection({ ...state, definition: next, dirty: true }) };
}
function setBindings(definition: WorkflowV2, target: GateTarget, gates: GateBinding[]): WorkflowV2 {
  if (target.kind === "transition")
    return {
      ...definition,
      transitions: definition.transitions.map((t) => (t.id === target.id ? { ...t, gates } : t)),
    };
  return {
    ...definition,
    stages: definition.stages.map((s) =>
      s.id === target.stageId && (s.type === "check" || s.type === "review") ? { ...s, gates } : s,
    ),
  };
}

export function addGate(state: EditorState, target: GateTarget, gateId: string): EditResult {
  const view = state.library.get(gateId);
  if (!view) return { state, error: `Unknown gate ${gateId}` };
  const reason = bindRestriction(state.definition, target, view.gate);
  if (reason) return { state, error: `${gateId}: ${reason}` };
  const result = edit(state, (d) => setBindings(d, target, [...bindingsAt(d, target), { gateId }]));
  if (result.error) return result;
  return {
    state: {
      ...result.state,
      pane: "gates",
      gate: bindingsAt(result.state.definition, target).length - 1,
    },
  };
}
export function removeGate(state: EditorState, target: GateTarget, index: number): EditResult {
  const bound = bindingsAt(state.definition, target);
  if (!bound[index]) return { state, error: "No gate selected" };
  return edit(state, (d) =>
    setBindings(
      d,
      target,
      bound.filter((_, i) => i !== index),
    ),
  );
}
/** Moves a binding up (-1) or down (+1); the cursor follows it. */
export function moveGate(
  state: EditorState,
  target: GateTarget,
  index: number,
  delta: -1 | 1,
): EditResult {
  const bound = [...bindingsAt(state.definition, target)];
  const to = index + delta;
  const moving = bound[index];
  const other = bound[to];
  if (!moving || !other) return { state, error: delta < 0 ? "Already first" : "Already last" };
  bound[to] = moving;
  bound[index] = other;
  const result = edit(state, (d) => setBindings(d, target, bound));
  return result.error ? result : { state: { ...result.state, gate: to } };
}
/**
 * Flips the effective mode of a binding for this workflow only. The override is stored only when it
 * differs from the library default, so the file states every deviation and nothing else.
 */
export function toggleMode(state: EditorState, target: GateTarget, index: number): EditResult {
  const bound = bindingsAt(state.definition, target);
  const binding = bound[index];
  if (!binding) return { state, error: "No gate selected" };
  const gate = state.library.get(binding.gateId)?.gate;
  if (!gate) return { state, error: `Unknown gate ${binding.gateId}` };
  if (gate.type === "ai-acceptance")
    return {
      state,
      error: `${gate.id}: an AI walk-through stays advisory until its test is promoted`,
    };
  const next = effectiveMode(binding, gate) === "required" ? "advisory" : "required";
  const fallback = gate.required ? "required" : "advisory";
  const updated: GateBinding =
    next === fallback ? { gateId: binding.gateId } : { gateId: binding.gateId, mode: next };
  return edit(state, (d) =>
    setBindings(
      d,
      target,
      bound.map((b, i) => (i === index ? updated : b)),
    ),
  );
}

export interface TransitionDraft {
  to: string;
  on: Outcome;
  /** Loop bound for a back edge, or null. */
  loop: number | null;
}
/** The choices of the new-transition form for a stage. */
export function transitionChoices(
  definition: WorkflowV2,
  from: string,
): { to: string[]; on: Outcome[]; loop: (number | null)[] } {
  const stage = definition.stages.find((s) => s.id === from);
  return {
    to: [...definition.stages.map((s) => s.id).filter((id) => id !== from), "done"],
    on: stage ? [...STAGE_OUTCOMES[stage.type]] : ["passed"],
    loop: [null, 1, 2, 3, 4, 5],
  };
}
export function defaultTransitionDraft(definition: WorkflowV2, from: string): TransitionDraft {
  const choices = transitionChoices(definition, from);
  const used = new Set(definition.transitions.filter((t) => t.from === from).map((t) => t.on));
  return {
    to: choices.to[0] ?? "done",
    on: choices.on.find((o) => !used.has(o)) ?? choices.on[0] ?? "passed",
    loop: null,
  };
}
export function addTransition(
  state: EditorState,
  from: string,
  draft: TransitionDraft,
): EditResult {
  const stage = state.definition.stages.find((s) => s.id === from);
  if (!stage) return { state, error: `Unknown stage ${from}` };
  if (!STAGE_OUTCOMES[stage.type].includes(draft.on))
    return { state, error: `A ${stage.type} stage cannot end ${draft.on}` };
  const base = `${from}-${draft.to}`.slice(0, 90);
  const taken = new Set(state.definition.transitions.map((t) => t.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const transition: Transition = {
    id,
    from,
    to: draft.to,
    on: draft.on,
    carries: stage.produces,
    gates: [],
    ...(draft.loop ? { loop: { maxIterations: draft.loop } } : {}),
  };
  const result = edit(state, (d) => ({ ...d, transitions: [...d.transitions, transition] }));
  if (result.error) return result;
  const index = targetsOf(result.state.definition, from).findIndex(
    (t) => t.kind === "transition" && t.id === id,
  );
  return { state: { ...result.state, pane: "transitions", target: index, gate: 0 } };
}
export function removeTransition(state: EditorState, id: string): EditResult {
  if (!state.definition.transitions.some((t) => t.id === id))
    return { state, error: `Unknown transition ${id}` };
  return edit(state, (d) => ({ ...d, transitions: d.transitions.filter((t) => t.id !== id) }));
}

// --- Stage options ---------------------------------------------------------------------------

export interface StageField {
  key: string;
  label: string;
  value: string;
  /** What ←/→ does, for the hint. */
  hint: string;
}

/**
 * The options E edits for a stage: the profile of an agent or reflection stage (only profiles that
 * return the stage's contract), the decision and `covers` of an approval stage, and the bound of
 * each loop edge leaving the stage.
 */
export function stageFields(state: EditorState, stageId: string): StageField[] {
  const definition = state.definition;
  const stage = definition.stages.find((s) => s.id === stageId);
  if (!stage) return [];
  const fields: StageField[] = [];
  if (stage.type === "agent" || stage.type === "reflection")
    fields.push({
      key: "profile",
      label: "Profile",
      value: stage.profileId,
      hint: `profiles returning ${requiredOutput(stage) ?? "this contract"}`,
    });
  if (stage.type === "approval") {
    fields.push({
      key: "decision",
      label: "Decision",
      value: stage.decision,
      hint: "human, or auto within limits",
    });
    for (const writer of definition.stages.filter((s) => s.type === "tasks"))
      fields.push({
        key: `covers:${writer.id}`,
        label: `Covers ${writer.id}`,
        value: stage.covers.includes(writer.id) ? "yes" : "no",
        hint: "this approval authorizes that stage",
      });
  }
  for (const t of definition.transitions.filter((t) => t.from === stageId && t.loop))
    fields.push({
      key: `loop:${t.id}`,
      label: `Loop ${t.id}`,
      value: String(t.loop?.maxIterations ?? 1),
      hint: "1 to 5 rounds",
    });
  return fields;
}
const requiredOutput = (stage: Stage): string | undefined => {
  const kind = stageKind(stage);
  return kind ? KIND_OUTPUT[kind] : undefined;
};
const cycle = <T>(list: readonly T[], value: T, delta: number): T => {
  const index = list.indexOf(value);
  return (
    list[(((index < 0 ? 0 : index + delta) % list.length) + list.length) % list.length] ?? value
  );
};

/** Changes one stage option by a step (←/→). */
export function changeStageField(
  state: EditorState,
  stageId: string,
  key: string,
  delta: -1 | 1,
): EditResult {
  const stage = state.definition.stages.find((s) => s.id === stageId);
  if (!stage) return { state, error: `Unknown stage ${stageId}` };
  if (key === "profile" && (stage.type === "agent" || stage.type === "reflection")) {
    const output = requiredOutput(stage);
    const ids = state.profiles.filter((p) => p.output === output).map((p) => p.id);
    const choices = ids.includes(stage.profileId) ? ids : [stage.profileId, ...ids];
    if (choices.length < 2) return { state, error: `No other profile returns ${output}` };
    const profileId = cycle(choices, stage.profileId, delta);
    return edit(state, (d) => ({
      ...d,
      stages: d.stages.map((s) => (s.id === stageId ? ({ ...s, profileId } as Stage) : s)),
    }));
  }
  if (key === "decision" && stage.type === "approval") {
    const decision = stage.decision === "human" ? "auto" : "human";
    return edit(state, (d) => {
      const stages = d.stages.map((s) => (s.id === stageId ? ({ ...s, decision } as Stage) : s));
      const anyAuto = stages.some((s) => s.type === "approval" && s.decision === "auto");
      // Limits exist only while some approval is automatic; turning the last one off drops them.
      return {
        ...d,
        stages,
        autoApproval: anyAuto ? (d.autoApproval ?? DEFAULT_AUTO_LIMITS) : null,
      };
    });
  }
  if (key.startsWith("covers:") && stage.type === "approval") {
    const writer = key.slice("covers:".length);
    const covers = stage.covers.includes(writer)
      ? stage.covers.filter((c) => c !== writer)
      : [...stage.covers, writer];
    return edit(state, (d) => ({
      ...d,
      stages: d.stages.map((s) => (s.id === stageId ? ({ ...s, covers } as Stage) : s)),
    }));
  }
  if (key.startsWith("loop:")) {
    const id = key.slice("loop:".length);
    const transition = state.definition.transitions.find((t) => t.id === id && t.from === stageId);
    if (!transition?.loop) return { state, error: `${id} is not a loop` };
    const maxIterations = cycle([1, 2, 3, 4, 5], transition.loop.maxIterations, delta);
    return edit(state, (d) => ({
      ...d,
      transitions: d.transitions.map((t) => (t.id === id ? { ...t, loop: { maxIterations } } : t)),
    }));
  }
  return { state, error: `${stageId} has no option ${key}` };
}

// --- Copy, estimate and save -----------------------------------------------------------------

/** A free custom ID for a copy of `id`. */
export function copyId(id: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const base = `${id}-custom`.slice(0, 90);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}
/** A custom copy of a definition. It never carries auto approval: that is a separate, confirmed act. */
export function copyAsCustom(source: WorkflowV2, id: string): WorkflowV2 {
  return {
    ...source,
    id,
    version: "1.0.0",
    preset: "custom",
    autoApproval: null,
    stages: source.stages.map((s) => (s.type === "approval" ? { ...s, decision: "human" } : s)),
  };
}
/** "Duplicate as custom": an editable, unsaved copy of a read-only definition. */
export function duplicateAsCustom(state: EditorState): EditorState {
  const id = copyId(state.id, state.takenIds);
  return {
    ...state,
    id,
    definition: copyAsCustom(state.definition, id),
    savedText: null,
    readOnly: null,
    takenIds: [...state.takenIds, id],
    dirty: true,
    history: state.history,
  };
}

export interface DefinitionEstimate {
  tokens: TokenRange | null;
  runs: number;
  label: string;
}
/**
 * The spend of the whole definition from the earlier runs of the same workflow ID: each model stage
 * priced by its own ID (generic ranges for a stage those runs never reached), tasks as the task
 * price times the task count, check and approval stages at zero. Without such runs there is no
 * estimate, rather than a number borrowed from another workflow.
 */
export function estimateDefinition(
  definition: WorkflowV2,
  history: readonly PastRun[] | null,
): DefinitionEstimate {
  if (history === null) return { tokens: null, runs: 0, label: "Estimate: not available" };
  const own = history.filter((r) => r.workflowId === definition.id);
  if (!own.length)
    return { tokens: null, runs: 0, label: "Estimate: none yet (no earlier run of this workflow)" };
  const prices = pricesFrom(own);
  let low = 0;
  let high = 0;
  for (const stage of definition.stages) {
    if (stage.type === "check" || stage.type === "approval") continue;
    if (stage.type === "tasks") {
      low += prices.task.low * prices.taskCount.low;
      high += prices.task.high * prices.taskCount.high;
      continue;
    }
    const kind = stageKind(stage);
    const range = prices.stages[stage.id] ?? (kind ? DEFAULT_STAGE_RANGES[kind] : undefined);
    low += range?.low ?? 0;
    high += range?.high ?? 0;
  }
  const tokens = { low, high };
  return {
    tokens,
    runs: own.length,
    label: `Estimate: ${rangeText(tokens)} tokens (from ${own.length} run${own.length === 1 ? "" : "s"})`,
  };
}

export interface DiffLine {
  kind: "add" | "remove" | "same";
  text: string;
}
/** A line diff (longest common subsequence) of two texts. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after.replace(/\n$/, "").split("\n");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if (
      j < b.length &&
      (i >= a.length || (table[i * cols + j + 1] ?? 0) >= (table[(i + 1) * cols + j] ?? 0))
    ) {
      out.push({ kind: "add", text: b[j] ?? "" });
      j++;
    } else {
      out.push({ kind: "remove", text: a[i] ?? "" });
      i++;
    }
  }
  return out;
}
/** Changed lines with `context` unchanged lines around them; "…" marks skipped runs. */
export function compactDiff(lines: readonly DiffLine[], context = 1): string[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = index - context; k <= index + context; k++) keep.add(k);
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {
      skipped = true;
      return;
    }
    if (skipped && out.length) out.push("…");
    skipped = false;
    out.push(`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} ${line.text}`);
  });
  return out;
}

/** Every binding with its place and the mode a run will apply. */
export function effectiveGates(state: EditorState): string[] {
  return bindingsOf(state.definition).map(({ binding, stageId, transitionId }) => {
    const gate = state.library.get(binding.gateId)?.gate;
    const mode = gate ? effectiveMode(binding, gate) : "unknown";
    const override = binding.mode ? " (set by this workflow)" : "";
    return `${stageId ? `stage ${stageId}` : transitionId}: ${binding.gateId} ${mode}${override}`;
  });
}

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
      /** Set when the save turns auto approval on or changes its limits: a typed confirmation is needed. */
      autoApproval: { hash: string; prefix: string; limits: string } | null;
    };

/**
 * What Ctrl+S does: refuse with the problems by stage and transition, or show the diff against the
 * saved file and the effective gates. Auto approval needs a typed confirmation the first time a
 * definition with those limits is written: when no file exists yet or the file holds other limits.
 */
export function prepareSave(state: EditorState, workspace: string): SaveReview {
  if (state.readOnly) return { kind: "read-only", message: state.readOnly };
  const groups = validateEditor(state);
  if (groups.length) return { kind: "problems", groups };
  const text = definitionText(state.definition);
  if (text === state.savedText) return { kind: "unchanged" };
  let savedLimits: string | null = null;
  try {
    const saved = state.savedText ? WorkflowV2Schema.parse(JSON.parse(state.savedText)) : null;
    savedLimits = saved?.autoApproval ? autoApprovalHash(saved.autoApproval) : null;
  } catch {
    savedLimits = null;
  }
  const limits = state.definition.autoApproval;
  const hash = limits ? autoApprovalHash(limits) : null;
  return {
    kind: "review",
    path: definitionPath(workspace, state.id),
    text,
    diff: compactDiff(lineDiff(state.savedText ?? "", text)),
    gates: effectiveGates(state),
    autoApproval:
      limits && hash && hash !== savedLimits
        ? { hash, prefix: hash.slice(0, CONFIRM_PREFIX), limits: describeAutoApproval(limits) }
        : null,
  };
}
/** True when the typed text confirms the limits: the full hash or its first CONFIRM_PREFIX characters. */
export function confirmsAutoApproval(typed: string, hash: string): boolean {
  const value = typed.trim().toLowerCase();
  return value.length >= CONFIRM_PREFIX && hash.startsWith(value);
}

/** Writes `baked/workflows/ID.json` through a temp file and a rename. */
export function writeDefinitionFile(workspace: string, definition: WorkflowV2): string {
  const parsed = WorkflowV2Schema.parse(definition);
  const target = definitionPath(workspace, SafeId.parse(parsed.id));
  mkdirSync(dirname(target), { recursive: true });
  writeViaTemp(target, definitionText(parsed), { flag: "w", flush: true });
  return target;
}
/** The state after a successful write: the file now holds the working copy. */
export const markSaved = (state: EditorState, text: string): EditorState => ({
  ...state,
  savedText: text,
  dirty: false,
});
