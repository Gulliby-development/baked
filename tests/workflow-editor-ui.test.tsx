import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { type WorkflowEditorApi, WorkflowEditorPopup } from "../src/components/workflow/WorkflowEditor.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { libraryViews, readEditorSource, writeDefinitionFile } from "../src/core/workflows/v2/editor.js";
import { draftGate, saveGateDraft } from "../src/core/workflows/v2/gate-draft.js";
import { loadGateLibrary } from "../src/core/workflows/v2/library.js";

type View = Awaited<ReturnType<typeof testRender>>;
const SIZES = [
  [120, 40],
  [80, 24],
  [50, 20],
] as const;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const check = (id: string, scope: "task" | "feature") => ({ id, executable: "bun", args: ["test"], cwd: ".", timeoutMs: 60000, required: true, scope, envNames: [], writes: [] });
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check("typecheck", "feature"), check("lint", "feature"), check("tests", "feature"), check("task-tests", "task")] };

/** A temp workspace with a project gate; user gate and profile folders are temp folders, never the home. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "baked-editor-ui-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(join(workspace, "baked", "gates"), { recursive: true });
  writeFileSync(join(workspace, "baked", "gates", "manual-signoff.json"), JSON.stringify({
    schemaVersion: 1, id: "manual-signoff", description: "A person signs off the result.", required: true, scope: "transition", timeoutMs: 3600000,
    retries: { max: 0, retryOn: [] }, evidence: { kind: "decision", keepOutputLines: 0, artifactPaths: [] },
    type: "human", human: { prompt: "Sign off.", answer: "approve", bindsDigest: true },
  }));
  const state = { backs: 0 };
  const api: WorkflowEditorApi = {
    open: (id) => readEditorSource(workspace, id, policy, { gateDirectories: { user: join(root, "user-gates"), project: join(workspace, "baked", "gates") }, profileDirectory: join(root, "agents") }),
    save: (definition) => writeDefinitionFile(workspace, definition),
    history: async () => [{ runId: "r1", workflowId: "standard-custom", status: "completed", tokens: 90000, calls: 9, activeMs: 1000, taskCount: 2, stageTokens: { research: 40000 }, taskTokens: 30000 }],
  };
  return { workspace, api, state };
}
async function mount(api: WorkflowEditorApi, id: string, workspace: string, size: { width: number; height: number }, onBack: () => void): Promise<View> {
  let view!: View;
  await act(async () => {
    view = await testRender(<WorkflowEditorPopup workspace={workspace} workflowId={id} api={api} width={Math.min(120, size.width)} height={Math.min(40, size.height)} onBack={onBack} />, size);
  });
  return view;
}
/** Renders, checks that the popup lies inside the terminal, and returns the frame. */
async function frame(view: View, width: number, height: number, name: string): Promise<string> {
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  const popup = view.renderer.root.findDescendantById("baked-popup");
  expect(popup, name).toBeTruthy();
  if (popup) {
    expect(popup.x >= 0 && popup.y >= 0, `${name}: origin`).toBe(true);
    expect(popup.x + popup.width <= width && popup.y + popup.height <= height, `${name}: inside ${width}x${height}`).toBe(true);
  }
  const text = view.captureCharFrame();
  expect(text, name).toContain("Workflow");
  expect(text.toLowerCase(), `${name}: exit hint`).toContain("esc");
  return text;
}
const press = async (view: View, key: string) => {
  await act(async () => {
    if (key === "up" || key === "down" || key === "left" || key === "right") view.mockInput.pressArrow(key);
    else if (key === "return") view.mockInput.pressEnter();
    else if (key === "tab") view.mockInput.pressTab();
    else view.mockInput.pressKey(key);
  });
};
async function esc(view: View): Promise<void> {
  await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
}

for (const [width, height] of SIZES) {
  test(`editor at ${width}x${height}: read-only preset, duplicate, reorder, mode, picker, problems and save`, async () => {
    const { workspace, api, state } = harness();
    const view = await mount(api, "standard", workspace, { width, height }, () => { state.backs++; });
    try {
      let text = await frame(view, width, height, "open");
      expect(text).toContain("Workflow editor: standard");
      expect(text).toContain("read only");
      expect(text).toContain("frozen copy");
      if (width >= 120) {
        expect(text).toContain('Transitions of "research"');
        expect(text).toContain("Gates");
      } else expect(text).toContain("[Stages]");
      await press(view, "d");
      await press(view, "c");
      text = await frame(view, width, height, "duplicated");
      expect(text).toContain("standard-custom");
      expect(text).toMatch(width >= 90 ? /Validation: 0 problems/ : /\[Stages\].*✓ 0/);
      // The estimate comes from the earlier run of the same workflow.
      if (width >= 80) expect(text).toContain("(from 1 run)");

      // Select the checks stage, its own gate list, then its gates.
      for (let i = 0; i < 6; i++) await press(view, "down");
      await press(view, "tab");
      text = await frame(view, width, height, "transitions");
      expect(text).toContain("stage gates");
      await press(view, "tab");
      text = await frame(view, width, height, "gates");
      expect(text).toContain("1 typecheck  required");
      await press(view, "j");
      await press(view, "m");
      text = await frame(view, width, height, "reordered");
      expect(text).toContain("1 lint");
      expect(text).toContain("2 typecheck  advisory");

      await press(view, "a");
      text = await frame(view, width, height, "picker");
      expect(text).toContain("Add a gate to stage checks");
      expect(text).toContain("cannot bind");
      await act(async () => { await view.mockInput.typeText("manual"); });
      text = await frame(view, width, height, "picker-search");
      expect(text).toContain("manual-signoff");
      expect(text).toContain(width >= 80 ? "cannot bind: a check stage runs command gates only" : "cannot bind");
      await press(view, "return");
      text = await frame(view, width, height, "picker-refused");
      expect(text).toContain("Add a gate to stage checks");
      await esc(view);

      await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
      text = await frame(view, width, height, "review");
      expect(text).toContain("Save ");
      expect(text).toContain("A new file:");
      expect(text).toContain("+ {");
      await press(view, "return");
      text = await frame(view, width, height, "saved");
      const path = join(workspace, "baked", "workflows", "standard-custom.json");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).stages[6].gates).toEqual([{ gateId: "lint" }, { gateId: "typecheck", mode: "advisory" }, { gateId: "tests" }]);
      expect(text).not.toContain("unsaved");

      // Removing every gate of the check stage is shown live and refused on save, by stage.
      for (let i = 0; i < 3; i++) await press(view, "d");
      text = await frame(view, width, height, "invalid");
      expect(text).toMatch(width >= 90 ? /Validation: 1 problem/ : /\[Gates\].*⚠ 1/);
      await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
      text = await frame(view, width, height, "problems");
      expect(text).toContain("Not saved: 1 problem");
      expect(text).toContain("stage checks");
      await esc(view);
      await esc(view);
      text = await frame(view, width, height, "discard");
      expect(text).toContain("Discard unsaved changes?");
      expect(state.backs).toBe(0);
      await press(view, "y");
      expect(state.backs).toBe(1);
    } finally { await act(async () => view.renderer.destroy()); }
  }, 20000);
}

test("turning on auto approval needs the typed hash prefix on the first save", async () => {
  const { workspace, api, state } = harness();
  const [width, height] = [80, 24];
  const view = await mount(api, "quick-fix", workspace, { width, height }, () => { state.backs++; });
  try {
    await press(view, "c");
    await press(view, "down");
    await press(view, "e");
    let text = await frame(view, width, height, "options");
    expect(text).toContain("Options of approve");
    expect(text).toContain("‹ human ›");
    await press(view, "right");
    text = await frame(view, width, height, "options-auto");
    expect(text).toContain("‹ auto ›");
    await esc(view);
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    text = await frame(view, width, height, "confirm");
    expect(text).toContain("Auto approval");
    expect(text).toContain("at most 3 tasks");
    await press(view, "return");
    text = await frame(view, width, height, "confirm-refused");
    const path = join(workspace, "baked", "workflows", "quick-fix-custom.json");
    expect(existsSync(path)).toBe(false);
    expect(text).toContain("Type the first 12 characters");
    const prefix = /type ([a-f0-9]{12}) \(/.exec(text.replace(/\s+/g, " "))?.[1];
    expect(prefix).toBeTruthy();
    await act(async () => { await view.mockInput.typeText(prefix ?? ""); });
    await press(view, "return");
    await frame(view, width, height, "confirmed");
    expect(JSON.parse(readFileSync(path, "utf8")).autoApproval).toMatchObject({ enabled: true, maxTasks: 3 });
  } finally { await act(async () => view.renderer.destroy()); }
}, 20000);

test("an unknown workflow ID is explained and Esc goes back", async () => {
  const { workspace, api, state } = harness();
  const view = await mount(api, "missing", workspace, { width: 80, height: 24 }, () => { state.backs++; });
  try {
    const text = await frame(view, 80, 24, "missing");
    expect(text).toContain("Unknown workflow missing");
    await esc(view);
    expect(state.backs).toBe(1);
  } finally { await act(async () => view.renderer.destroy()); }
});

test("G drafts a gate from a sentence, saves it to baked/gates and binds it where the cursor is", async () => {
  const { workspace, api: base, state } = harness();
  const directories = { user: join(workspace, "..", "user-gates"), project: join(workspace, "baked", "gates") };
  const prompts: string[] = [];
  const api: WorkflowEditorApi = {
    ...base,
    // A person gate needs no model; a model call here would be a bug.
    draftGate: (request) => { prompts.push(request.text); return draftGate(workspace, request, async () => { throw new Error("no model in this test"); }, loadGateLibrary(workspace, policy, directories)); },
    saveGate: (draft) => {
      saveGateDraft(workspace, draft, () => loadGateLibrary(workspace, policy, directories));
      return libraryViews(workspace, policy, directories);
    },
  };
  const view = await mount(api, "standard", workspace, { width: 120, height: 40 }, () => { state.backs++; });
  try {
    await press(view, "g");
    let text = await frame(view, 120, 40, "read-only");
    expect(text).not.toContain("New gate for");
    await press(view, "c");
    await press(view, "tab");
    await press(view, "g");
    text = await frame(view, 120, 40, "describe");
    expect(text).toContain("New gate for");
    expect(text).toContain("[Run a command]");
    await press(view, "tab");
    await press(view, "tab");
    text = await frame(view, 120, 40, "kind");
    expect(text).toContain("[Ask a person]");
    await act(async () => { await view.mockInput.typeText("Someone from design signs off the screens"); });
    await press(view, "return");
    await act(async () => { await Bun.sleep(50); });
    text = await frame(view, 120, 40, "draft");
    expect(prompts).toEqual(["Someone from design signs off the screens"]);
    expect(text).toContain("Save baked/gates/someone-from-design-signs-off.json");
    expect(text).toContain("Draft gate someone-from-design-signs-off (human, required)");
    await press(view, "return");
    text = await frame(view, 120, 40, "bound");
    const file = join(workspace, "baked", "gates", "someone-from-design-signs-off.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ type: "human" });
    expect(text).toContain("unsaved");
    expect(text).toContain("someone-from-design");
  } finally { await act(async () => view.renderer.destroy()); }
}, 20000);

test("I puts a new station on the transition out of the selected stage", async () => {
  const { workspace, api, state } = harness();
  const view = await mount(api, "standard", workspace, { width: 120, height: 40 }, () => { state.backs++; });
  try {
    await press(view, "i");
    let text = await frame(view, 120, 40, "read only");
    expect(text).not.toContain("Put a station on");
    await press(view, "c");
    await press(view, "i");
    text = await frame(view, 120, 40, "station picker");
    expect(text).toContain("Put a station on");
    expect(text).toContain("Approval");
    await press(view, "down");
    await press(view, "return");
    text = await frame(view, 120, 40, "inserted");
    expect(text).toContain("Review station added on");
    expect(text).not.toContain("Put a station on");
  } finally { await act(async () => view.renderer.destroy()); }
});
