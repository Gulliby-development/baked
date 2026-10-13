import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { PastRun } from "../src/core/workflows/estimate.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import {
  addGate,
  addTransition,
  bindingsAt,
  changeStageField,
  confirmsAutoApproval,
  duplicateAsCustom,
  type EditorState,
  effectiveGates,
  estimateDefinition,
  type GateTarget,
  insertWaitStage,
  markSaved,
  moveCursor,
  moveGate,
  openEditor,
  pickerOptions,
  prepareSave,
  readEditorSource,
  removeGate,
  removeTransition,
  removeWaitStage,
  stageFields,
  switchPane,
  targetsOf,
  toggleMode,
  validateEditor,
  writeDefinitionFile,
  setLoopRounds,
} from "../src/core/workflows/v2/editor.js";
import { WorkflowV2Schema } from "../src/core/workflows/v2/definition.js";
import { autoApprovalHash } from "../src/core/workflows/v2/runtime.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const check = (id: string, scope: "task" | "feature") => ({
  id,
  executable: "bun",
  args: ["test"],
  cwd: ".",
  timeoutMs: 60000,
  required: true,
  scope,
  envNames: [],
  writes: [],
});
const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  checks: [
    check("typecheck", "feature"),
    check("lint", "feature"),
    check("tests", "feature"),
    check("task-tests", "task"),
  ],
};
const humanGate = {
  schemaVersion: 1,
  id: "manual-signoff",
  description: "A person signs off the result.",
  required: true,
  scope: "transition",
  timeoutMs: 3600000,
  retries: { max: 0, retryOn: [] },
  evidence: { kind: "decision", keepOutputLines: 0, artifactPaths: [] },
  type: "human",
  human: { prompt: "Sign off the result.", answer: "approve", bindsDigest: true },
};

/** A workspace with a project gate, and user directories that are empty temp folders, never the home. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "baked-editor-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(join(workspace, "baked", "gates"), { recursive: true });
  writeFileSync(
    join(workspace, "baked", "gates", "manual-signoff.json"),
    JSON.stringify(humanGate, null, 2),
  );
  const options = {
    gateDirectories: { user: join(root, "user-gates"), project: join(workspace, "baked", "gates") },
    profileDirectory: join(root, "user-agents"),
  };
  const open = (id: string): EditorState =>
    openEditor(readEditorSource(workspace, id, policy, options));
  return { workspace, open };
}
const transition = (id: string): GateTarget => ({ kind: "transition", id });
const stageTarget = (stageId: string): GateTarget => ({ kind: "stage", stageId });
const ok = (result: { state: EditorState; error?: string }): EditorState => {
  expect(result.error).toBeUndefined();
  return result.state;
};

describe("workflow editor", () => {
  test("built-in presets are read only until duplicated as a custom workflow", () => {
    const { workspace, open } = setup();
    const preset = open("standard");
    expect(preset.readOnly).toContain("read only");
    const refused = addGate(preset, transition("plan-analyze"), "manual-signoff");
    expect(refused.error).toContain("read only");
    expect(refused.state).toBe(preset);
    expect(prepareSave(preset, workspace).kind).toBe("read-only");

    const copy = duplicateAsCustom(preset);
    expect(copy.id).toBe("standard-custom");
    expect(copy.readOnly).toBeNull();
    expect(copy.definition).toMatchObject({ id: "standard-custom", preset: "custom", version: "1.0.0", autoApproval: null });
    // The copy keeps the project's checks the preset was instantiated with.
    expect(bindingsAt(copy.definition, stageTarget("checks")).map((b) => b.gateId)).toEqual(["typecheck", "lint", "tests"]);
    expect(validateEditor(copy)).toEqual([]);
    // A second copy of the same preset gets a free ID.
    expect(duplicateAsCustom({ ...preset, takenIds: [...preset.takenIds, "standard-custom"] }).id).toBe("standard-custom-2");
  });

  test("validation messages are grouped by the stage or transition they belong to", () => {
    const { open } = setup();
    let state = duplicateAsCustom(open("standard"));
    for (let i = 0; i < 3; i++) state = ok(removeGate(state, stageTarget("checks"), 0));
    state = ok(removeTransition(state, "review-done"));
    state = ok(addTransition(state, "plan", { to: "done", on: "passed", loop: null }));
    const groups = validateEditor(state);
    const owners = groups.map((g) => g.owner);
    expect(owners).toContain("stage checks");
    expect(groups.find((g) => g.owner === "stage checks")?.messages).toContain("needs at least one gate");
    expect(groups.find((g) => g.owner === "stage plan")?.messages).toContain("plan: two unconditional passed transitions");
    expect(groups.find((g) => g.owner === "stage review")?.messages).toContain("review: no passed transition");
  });

  test("the picker searches the library and disables gates that cannot be bound, with the reason", () => {
    const { open } = setup();
    const state = duplicateAsCustom(open("standard"));
    const onPlan = pickerOptions(state, transition("plan-analyze"), "");
    const reason = (id: string) => onPlan.find((o) => o.gate.id === id)?.disabled;
    expect(reason("task-tests")).toContain("a task gate only follows a tasks stage");
    expect(reason("correctness-review")).toBe("AI review gates belong to a review stage");
    expect(reason("typecheck")).toBeNull();
    expect(reason("manual-signoff")).toBeNull();
    // Bindable gates come first.
    expect(onPlan.findIndex((o) => o.disabled)).toBeGreaterThan(onPlan.findLastIndex((o) => !o.disabled));
    const signoff = onPlan.find((o) => o.gate.id === "manual-signoff");
    expect(signoff?.summary).toBe("human · required · transition · 3600s · project, unconfirmed");

    const inCheck = pickerOptions(state, stageTarget("checks"), "");
    expect(inCheck.find((o) => o.gate.id === "typecheck")?.disabled).toBe("already bound here");
    expect(inCheck.find((o) => o.gate.id === "manual-signoff")?.disabled).toBe("a check stage runs command gates only");
    expect(inCheck.find((o) => o.gate.id === "task-tests")?.disabled).toBe("a task gate runs after each task, not in a stage");
    const inReview = pickerOptions(state, stageTarget("review"), "");
    expect(inReview.find((o) => o.gate.id === "lint")?.disabled).toBe("a review stage runs AI review gates only");
    expect(inReview.find((o) => o.gate.id === "security-review")?.disabled).toBeNull();
    // After a tasks stage a task gate is allowed.
    expect(pickerOptions(state, transition("approve-implement"), "task").map((o) => o.gate.id)).toEqual(["task-tests"]);
    expect(pickerOptions(state, transition("implement-checks"), "task")[0]?.disabled).toBe("already bound here");
    expect(pickerOptions(state, transition("plan-analyze"), "sign").map((o) => o.gate.id)).toEqual(["manual-signoff"]);

    // Binding a disabled gate is refused; an allowed one is appended and selected.
    expect(addGate(state, transition("plan-analyze"), "correctness-review").error).toContain("review stage");
    const bound = ok(addGate(state, transition("plan-analyze"), "manual-signoff"));
    expect(bindingsAt(bound.definition, transition("plan-analyze"))).toEqual([{ gateId: "manual-signoff" }]);
    expect(bound.pane).toBe("gates");
    expect(validateEditor(bound)).toEqual([]);
  });

  test("J and K reorder the gates of a list and the cursor follows", () => {
    const { open } = setup();
    let state = duplicateAsCustom(open("standard"));
    state = ok(moveGate(state, stageTarget("checks"), 0, 1));
    expect(bindingsAt(state.definition, stageTarget("checks")).map((b) => b.gateId)).toEqual(["lint", "typecheck", "tests"]);
    expect(state.gate).toBe(1);
    state = ok(moveGate(state, stageTarget("checks"), 1, 1));
    expect(bindingsAt(state.definition, stageTarget("checks")).map((b) => b.gateId)).toEqual(["lint", "tests", "typecheck"]);
    expect(moveGate(state, stageTarget("checks"), 2, 1).error).toBe("Already last");
    expect(moveGate(state, stageTarget("checks"), 0, -1).error).toBe("Already first");
  });

  test("M toggles required and advisory for this workflow only and shows the effective mode", () => {
    const { open } = setup();
    let state = duplicateAsCustom(open("standard"));
    state = ok(toggleMode(state, stageTarget("checks"), 0));
    expect(bindingsAt(state.definition, stageTarget("checks"))[0]).toEqual({ gateId: "typecheck", mode: "advisory" });
    expect(effectiveGates(state)).toContain("stage checks: typecheck advisory (set by this workflow)");
    // Back to the library default: the override disappears instead of restating the default.
    state = ok(toggleMode(state, stageTarget("checks"), 0));
    expect(bindingsAt(state.definition, stageTarget("checks"))[0]).toEqual({ gateId: "typecheck" });
    expect(effectiveGates(state)).toContain("stage checks: typecheck required");
    expect(effectiveGates(state)).toContain("implement-checks: task-tests required");
  });

  test("save refuses with the problems, otherwise shows the diff and writes the file through a rename", () => {
    const { workspace, open } = setup();
    let state = duplicateAsCustom(open("standard"));
    const broken = ok(removeTransition(state, "review-done"));
    const refused = prepareSave(broken, workspace);
    expect(refused.kind).toBe("problems");
    if (refused.kind === "problems") expect(refused.groups.map((g) => g.owner)).toContain("stage review");

    const first = prepareSave(state, workspace);
    if (first.kind !== "review") throw new Error(first.kind);
    expect(first.autoApproval).toBeNull();
    expect(first.path).toBe(join(workspace, "baked", "workflows", "standard-custom.json"));
    expect(first.diff.every((line) => line.startsWith("+"))).toBe(true);
    expect(first.gates).toContain("stage review: correctness-review required");
    expect(writeDefinitionFile(workspace, state.definition)).toBe(first.path);
    expect(readdirSync(join(workspace, "baked", "workflows"))).toEqual(["standard-custom.json"]);
    state = markSaved(state, first.text);
    expect(prepareSave(state, workspace).kind).toBe("unchanged");

    state = ok(toggleMode(state, stageTarget("checks"), 1));
    const second = prepareSave(state, workspace);
    if (second.kind !== "review") throw new Error(second.kind);
    expect(second.diff).toContain('-           "gateId": "lint"');
    expect(second.diff).toContain('+           "gateId": "lint",');
    expect(second.diff).toContain('+           "mode": "advisory"');
    expect(second.diff.length).toBeLessThan(12);
    writeDefinitionFile(workspace, state.definition);

    // The saved file reopens editable, with the change.
    const reopened = open("standard-custom");
    expect(reopened.readOnly).toBeNull();
    expect(reopened.savedText).toBe(readFileSync(first.path, "utf8"));
    expect(bindingsAt(reopened.definition, stageTarget("checks"))[1]).toEqual({ gateId: "lint", mode: "advisory" });
    expect(prepareSave(reopened, workspace).kind).toBe("unchanged");
  });

  test("auto approval asks for a typed confirmation of its limits on the first save only", () => {
    const { workspace, open } = setup();
    let state = duplicateAsCustom(open("quick-fix"));
    expect(stageFields(state, "approve").map((f) => `${f.key}=${f.value}`)).toEqual(["decision=human", "covers:implement=yes"]);
    state = ok(changeStageField(state, "approve", "decision", 1));
    expect(state.definition.autoApproval).toMatchObject({ enabled: true, maxTasks: 3, allowNewDependencies: false });
    const review = prepareSave(state, workspace);
    if (review.kind !== "review") throw new Error(review.kind);
    const hash = autoApprovalHash(state.definition.autoApproval!);
    expect(review.autoApproval).toMatchObject({ hash, prefix: hash.slice(0, 12) });
    expect(review.autoApproval?.limits).toContain("at most 3 tasks");
    expect(confirmsAutoApproval("", hash)).toBe(false);
    expect(confirmsAutoApproval(hash.slice(0, 8), hash)).toBe(false);
    expect(confirmsAutoApproval("0".repeat(12), hash)).toBe(false);
    expect(confirmsAutoApproval(hash.slice(0, 12).toUpperCase(), hash)).toBe(true);
    expect(confirmsAutoApproval(hash, hash)).toBe(true);
    writeDefinitionFile(workspace, state.definition);
    state = markSaved(state, review.text);

    // Later saves with the same limits do not ask again.
    state = ok(toggleMode(state, stageTarget("checks"), 0));
    const later = prepareSave(state, workspace);
    if (later.kind !== "review") throw new Error(later.kind);
    expect(later.autoApproval).toBeNull();
    // Turning the last automatic approval off drops the limits.
    state = ok(changeStageField(state, "approve", "decision", 1));
    expect(state.definition.autoApproval).toBeNull();
  });

  test("N adds a transition carrying the source contract; E edits profile, covers and loop bounds", () => {
    const { open } = setup();
    const source = duplicateAsCustom(open("standard"));
    let state: EditorState = { ...source, profiles: [...source.profiles, { id: "deep-researcher", output: "research" }] };
    state = ok(addTransition(state, "review", { to: "checks", on: "changes_requested", loop: 3 }));
    const added = state.definition.transitions.at(-1);
    expect(added).toEqual({ id: "review-checks", from: "review", to: "checks", on: "changes_requested", carries: "review", gates: [], loop: { maxIterations: 3 } });
    expect(state.pane).toBe("transitions");
    expect(targetsOf(state.definition, "review")[state.target]).toEqual(transition("review-checks"));
    expect(validateEditor(state).flatMap((g) => g.messages)).toContain("review: two unconditional changes_requested transitions");
    expect(addTransition(state, "plan", { to: "done", on: "failed", loop: null }).error).toBe("A agent stage cannot end failed");
    state = ok(removeTransition(state, "review-checks"));

    expect(ok(changeStageField(state, "plan", "profile", 1)).definition.stages.find((s) => s.id === "plan")).toMatchObject({ profileId: "quick-planner" });
    state = ok(changeStageField(state, "research", "profile", 1));
    expect(state.definition.stages[0]).toMatchObject({ profileId: "deep-researcher" });
    state = ok(changeStageField(state, "checks", "loop:checks-repair", 1));
    expect(state.definition.transitions.find((t) => t.id === "checks-repair")?.loop).toEqual({ maxIterations: 3 });
    expect(stageFields(state, "checks").map((f) => f.key)).toEqual(["loop:checks-repair"]);
    state = ok(changeStageField(state, "approve", "covers:implement", 1));
    expect(validateEditor(state).flatMap((g) => g.messages)).toContain("implement has no approval stage");
  });

  test("a loop runs 1 to 50 rounds, set directly or stepped without wrapping", () => {
    const { open } = setup();
    let state = ok(setLoopRounds(duplicateAsCustom(open("standard")), "checks-repair", 12));
    expect(state.definition.transitions.find((t) => t.id === "checks-repair")?.loop).toEqual({ maxIterations: 12 });
    expect(stageFields(state, "checks")[0]?.hint).toBe("1 to 50 rounds, 5 or fewer recommended");
    expect(WorkflowV2Schema.safeParse(state.definition).success).toBe(true);
    state = ok(setLoopRounds(state, "checks-repair", 50));
    expect(changeStageField(state, "checks", "loop:checks-repair", 1).error).toBe("A loop runs 1 to 50 rounds");
    expect(setLoopRounds(state, "checks-repair", 0).error).toBe("A loop runs 1 to 50 rounds");
    expect(setLoopRounds(state, "checks-review", 3).error).toBe("checks-review is not a loop");
  });

  test("W inserts a wait stage on a passed edge; E changes its interval and timeout; D removes it", () => {
    const { open } = setup();
    const source = duplicateAsCustom(open("standard"));
    let state = ok(insertWaitStage(source, "review"));
    const wait = state.definition.stages.find((s) => s.type === "wait");
    expect(wait).toMatchObject({ id: "wait", gates: [], intervalSeconds: 30, timeoutMinutes: 30 });
    expect(state.definition.stages.map((s) => s.id).indexOf("wait")).toBe(state.definition.stages.map((s) => s.id).indexOf("review") + 1);
    expect(state.definition.transitions.find((t) => t.id === "review-done")?.to).toBe("wait");
    expect(state.definition.transitions.find((t) => t.id === "wait-passed")).toMatchObject({ from: "wait", to: "done", on: "passed", carries: "gates" });
    expect(state.definition.limits.maxStageVisits).toBeGreaterThanOrEqual(state.definition.stages.length);
    expect(validateEditor(state).flatMap((g) => g.messages)).toContain("needs at least one gate");
    expect(targetsOf(state.definition, "wait")[0]).toEqual(stageTarget("wait"));
    expect(addGate(state, stageTarget("wait"), "correctness-review").error).toContain("a wait stage polls command gates only");
    state = ok(addGate(state, stageTarget("wait"), "tests"));
    expect(validateEditor(state)).toEqual([]);
    expect(stageFields(state, "wait").map((f) => `${f.key}=${f.value}`)).toEqual(["interval=30s", "timeout=30 min"]);
    state = ok(changeStageField(state, "wait", "interval", 1));
    state = ok(changeStageField(state, "wait", "timeout", -1));
    expect(state.definition.stages.find((s) => s.id === "wait")).toMatchObject({ intervalSeconds: 60, timeoutMinutes: 15 });
    expect(removeWaitStage(state, "review").error).toBe("Only a wait stage can be removed here");
    state = ok(removeWaitStage(state, "wait"));
    expect(state.definition.stages.some((s) => s.type === "wait")).toBe(false);
    expect(state.definition.transitions).toEqual(source.definition.transitions);
  });

  test("the cursor moves per pane and a new stage resets the panes to its right", () => {
    const { open } = setup();
    let state = duplicateAsCustom(open("standard"));
    state = moveCursor(state, -1);
    expect(state.definition.stages[state.stage]?.id).toBe("review");
    state = switchPane(state, 1);
    expect(state.pane).toBe("transitions");
    // A review stage lists its own gates first, then its transitions.
    expect(targetsOf(state.definition, "review")).toEqual([stageTarget("review"), transition("review-done"), transition("review-repair")]);
    state = moveCursor(state, 1);
    expect(state.target).toBe(1);
    state = switchPane(switchPane(state, 1), 1);
    expect(state.pane).toBe("stages");
    state = moveCursor(state, 1);
    expect(state).toMatchObject({ stage: 0, target: 0, gate: 0 });
  });

  test("the estimate prices only runs of the same workflow and otherwise says there is none", () => {
    const { open } = setup();
    const state = duplicateAsCustom(open("quick-fix"));
    const run = (workflowId: string): PastRun => ({ runId: workflowId, workflowId, status: "completed", tokens: 100000, calls: 10, activeMs: 1000, taskCount: 2, stageTokens: { plan: 30000 }, taskTokens: 40000 });
    expect(estimateDefinition(state.definition, null).label).toBe("Estimate: not available");
    expect(estimateDefinition(state.definition, [run("sdd")]).label).toBe("Estimate: none yet (no earlier run of this workflow)");
    const own = estimateDefinition(state.definition, [run("quick-fix-custom"), run("sdd")]);
    expect(own.runs).toBe(1);
    // plan 21k–42k and 14k–28k per task, both widened from one sample, times 1 to 3 tasks.
    expect(own.tokens).toEqual({ low: 21000 + 14000 * 1, high: 42000 + 28000 * 3 });
    expect(own.label).toBe("Estimate: 35k–126k tokens (from 1 run)");
  });

  test("schema 1 project files open read only and duplicate as schema 2", () => {
    const { workspace, open } = setup();
    mkdirSync(join(workspace, "baked", "workflows"), { recursive: true });
    writeFileSync(join(workspace, "baked", "workflows", "legacy.json"), JSON.stringify({ ...sddWorkflow, id: "legacy" }));
    const legacy = open("legacy");
    expect(legacy.readOnly).toContain("schema 1");
    const copy = duplicateAsCustom(legacy);
    expect(copy.definition.schemaVersion).toBe(2);
    expect(copy.id).toBe("legacy-custom");
    expect(() => open("missing")).toThrow("Unknown workflow missing");
  });
});
