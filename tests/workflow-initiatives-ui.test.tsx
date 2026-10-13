import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { type InitiativesApi, InitiativesPopup } from "../src/components/workflow/InitiativesView.js";
import { NewRunForm } from "../src/components/workflow/NewRunForm.js";
import { PremiumPopup } from "../src/components/ui/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { InitiativeStartInput } from "../src/core/workflows/initiatives/forms.js";
import type { InitiativeView } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeAction } from "../src/core/workflows/initiatives/view-model.js";
import type { StartRunInput, WorkflowInfo } from "../src/core/workflows/view.js";
import { featureView, initiativeView } from "./helpers/initiative-views.js";

type View = Awaited<ReturnType<typeof testRender>>;
const SIZES = [
  [120, 40],
  [80, 24],
  [50, 20],
] as const;

async function frame(view: View, width: number, height: number, name: string): Promise<string> {
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  const popup = view.renderer.root.findDescendantById("baked-popup");
  expect(popup, name).toBeTruthy();
  if (popup) {
    expect(popup.x >= 0 && popup.y >= 0, `${name}: origin`).toBe(true);
    expect(popup.x + popup.width <= width && popup.y + popup.height <= height, `${name}: inside ${width}x${height}`).toBe(true);
  }
  const text = view.captureCharFrame();
  const capture = process.env.BAKED_UI_CAPTURE_DIR;
  if (capture) {
    mkdirSync(capture, { recursive: true });
    writeFileSync(join(capture, `${width}-${height}-${name}.txt`), text);
  }
  expect(text, name).toContain("Workflow");
  expect(text.toLowerCase(), `${name}: exit hint`).toContain("esc");
  return text;
}
const press = async (view: View, key: string, options?: { ctrl?: boolean }) => {
  await act(async () => {
    if (key === "up" || key === "down" || key === "left" || key === "right") view.mockInput.pressArrow(key);
    else if (key === "return") view.mockInput.pressEnter();
    else if (key === "tab") view.mockInput.pressTab();
    else if (key === "escape") { view.mockInput.pressEscape(); await Bun.sleep(120); }
    else view.mockInput.pressKey(key, options);
  });
};
/** The frame as one line without the popup border and scrollbar, so wrapped sentences match. */
const flat = (text: string) => text.replace(/[│┃█▀▄]/g, " ").replace(/\s+/g, " ");

/** Three initiatives: one waiting for its split approval, one running with a blocked feature, one done. */
function initiatives(): InitiativeView[] {
  const split = initiativeView({
    initiativeId: "billing", title: "Move billing to the new API", status: "awaiting_approval", approvedPlanRevision: null, approvalDigest: null,
    planRevision: 2, revision: 5,
    features: [featureView("schema", { state: "proposed" }), featureView("client", { state: "proposed", dependsOn: ["schema"] }), featureView("ui", { state: "proposed", dependsOn: ["client"] })],
    pendingDecisions: [{ scope: "initiative", featureId: null, runId: null, requestId: "split-2", kind: "split_approval", digest: "e".repeat(64) }],
    next: { kind: "await_split_approval", featureId: null, runId: null, message: "Approve the split (plan revision 2) or edit it." },
  });
  const active = initiativeView({
    initiativeId: "search", title: "Full-text search across projects", parallelRuns: 2,
    features: [
      featureView("index", { state: "accepted", runId: "run-index", runStatus: "completed", contractHash: "c".repeat(64) }),
      featureView("query", { state: "needs_decision", dependsOn: ["index"], runId: "run-query", runStatus: "waiting", pendingRequests: [{ scope: "feature", featureId: "query", runId: "run-query", requestId: "q1", kind: "approval", digest: "f".repeat(64) }] }),
      featureView("ranking", { state: "blocked", dependsOn: ["query"], runId: "run-ranking", runStatus: "blocked", blockers: ["checks failed: tests"] }),
      featureView("docs", { state: "waiting", dependsOn: ["ranking"], blockers: ["waits for ranking's contract (ranking is blocked)"] }),
    ],
    pendingDecisions: [{ scope: "feature", featureId: "query", runId: "run-query", requestId: "q1", kind: "approval", digest: "f".repeat(64) }],
    next: { kind: "decide", featureId: "query", runId: "run-query", message: "Feature query waits for a decision" },
  });
  const done = initiativeView({ initiativeId: "logging", title: "Structured logging", status: "completed", features: [featureView("core", { state: "accepted", runId: "run-log", runStatus: "completed" })], next: { kind: "done", featureId: null, runId: null, message: "Every mandatory feature has an accepted result." } });
  return [done, active, split];
}

for (const [width, height] of SIZES) {
  test(`initiatives at ${width}x${height}: list, detail, run link and confirmed split approval`, async () => {
    const views = initiatives();
    const acted: { id: string; action: InitiativeAction }[] = [];
    const opened: string[] = [];
    const state = { selected: null as string | null, backs: 0 };
    const api: InitiativesApi = {
      load: async () => ({ initiatives: views, driving: [], errors: {} }),
      act: async (id, action) => {
        acted.push({ id, action });
        return views.find((v) => v.initiativeId === id) as InitiativeView;
      },
    };
    function Harness() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return (
        <InitiativesPopup api={api} width={Math.min(120, width)} height={Math.min(40, height)} selectedId={selectedId}
          onSelect={(id) => { state.selected = id; setSelectedId(id); }} onBack={() => { state.backs++; }} onOpenRun={(id) => { opened.push(id); }} />
      );
    }
    let view!: View;
    await act(async () => { view = await testRender(<Harness />, { width, height }); });
    try {
      let text = await frame(view, width, height, "list");
      // Initiatives that need a person come first; the finished one is last.
      expect(text.indexOf("search")).toBeLessThan(text.indexOf("logging"));
      expect(text).toContain("billing");
      expect(text).toContain("approve split");
      expect(text).toContain("1/4 features");
      expect(text).toMatch(/12k\/400k/);
      expect(flat(text)).toMatch(/1 decision/);
      await press(view, "return");
      expect(state.selected).toBe("search");
      text = await frame(view, width, height, "detail");
      expect(text).toContain("Full-text search");
      // The body scrolls in a small terminal; the selected feature stays in view.
      if (height >= 24) {
        expect(text).toContain("Features in dependency order (4)");
        const order = text.slice(text.indexOf("Features in dependency order"));
        expect(order.indexOf("index")).toBeLessThan(order.indexOf("ranking"));
      }
      expect(text).toContain("index");
      expect(text).toContain("Plan revision 1 (approved)");
      if (width >= 100) expect(text).toContain("up to 2 features at once");
      expect(text).toContain("Next: Feature query waits");
      expect(text).toContain("ranking: checks failed");
      if (width >= 80) expect(text).toContain("run run-index");
      await press(view, "down");
      text = await frame(view, width, height, "detail-feature");
      expect(flat(text)).toContain("approval waits in run run-query");
      await press(view, "return");
      expect(opened).toEqual(["run-query"]);
      // Re-plan supersedes the selected feature's run, so it asks first; N keeps it.
      await press(view, "x");
      text = await frame(view, width, height, "replan-confirm");
      expect(flat(text)).toContain("Re-plan query?");
      await press(view, "n");
      expect(acted).toEqual([]);
      await press(view, "p");
      await act(async () => { await Bun.sleep(20); });
      expect(acted.at(-1)?.action).toEqual({ kind: "pause", expectedRevision: 3 });
      await press(view, "escape");
      expect(state.selected).toBeNull();
      text = await frame(view, width, height, "back-to-list");
      await press(view, "down");
      await press(view, "return");
      expect(state.selected).toBe("billing");
      text = await frame(view, width, height, "split");
      expect(flat(text)).toContain("Split approval pending for plan revision 2");
      if (height >= 24) expect(text).toContain("not approved");
      await press(view, "a");
      text = await frame(view, width, height, "approve-confirm");
      expect(flat(text)).toContain("Approve plan revision 2 (3 features)?");
      await press(view, "y");
      await act(async () => { await Bun.sleep(20); });
      expect(acted.at(-1)).toEqual({ id: "billing", action: { kind: "approve", expectedRevision: 5, requestId: "split-2", digest: "e".repeat(64) } });
      await press(view, "escape");
      await press(view, "escape");
      expect(state.backs).toBe(1);
    } finally { await act(async () => view.renderer.destroy()); }
  }, 20000);
}

test("the initiative screen explains an empty project and a disabled one", async () => {
  for (const data of [{ initiatives: [], driving: [], errors: {} }, null]) {
    let view!: View;
    await act(async () => {
      view = await testRender(<InitiativesPopup api={{ load: async () => data, act: async () => { throw new Error("unused"); } }} width={80} height={24} selectedId={null} onSelect={() => {}} onBack={() => {}} onOpenRun={() => {}} />, { width: 80, height: 24 });
    });
    try {
      const text = await frame(view, 80, 24, data ? "empty" : "disabled");
      expect(text).toContain(data ? "No initiatives yet" : "Workflows are off");
    } finally { await act(async () => view.renderer.destroy()); }
  }
});

test("the initiative screen starts an initiative and edits a split from typed text", async () => {
  const views = initiatives();
  const acted: InitiativeAction[] = [];
  const started: InitiativeStartInput[] = [];
  const state = { selected: null as string | null };
  const api: InitiativesApi = {
    load: async () => ({ initiatives: views, driving: [], errors: {} }),
    act: async (id, action) => {
      acted.push(action);
      return views.find((v) => v.initiativeId === id) as InitiativeView;
    },
    start: async (input) => {
      started.push(input);
      return views[2] as InitiativeView;
    },
    info: async () => ({ workflows: ["sdd", "quick"], defaultWorkflow: "sdd" }),
  };
  function Harness() {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    return (
      <InitiativesPopup api={api} width={100} height={40} selectedId={selectedId} model="fixture/model"
        onSelect={(id) => { state.selected = id; setSelectedId(id); }} onBack={() => {}} onOpenRun={() => {}} />
    );
  }
  let view!: View;
  await act(async () => { view = await testRender(<Harness />, { width: 100, height: 40 }); });
  const type = async (text: string) => { await act(async () => { await view.mockInput.typeText(text); }); };
  try {
    let text = await frame(view, 100, 40, "list-start");
    expect(text).toContain("new initiative");
    await press(view, "n");
    text = await frame(view, 100, 40, "start-form");
    expect(text).toContain("New initiative");
    await type("Move billing to the new API");
    text = await frame(view, 100, 40, "start-typed");
    expect(text).toContain("move-billing-to-the-new");
    await press(view, "tab");
    await press(view, "tab");
    await press(view, "right");
    await press(view, "tab");
    await type("2M 100 1h");
    await press(view, "tab");
    await press(view, "right");
    await press(view, "s", { ctrl: true });
    await act(async () => { await Bun.sleep(20); });
    expect(started).toEqual([{ initiativeId: "move-billing-to-the-new", prompt: "Move billing to the new API", workflow: "quick", model: "fixture/model", budget: { tokens: 2_000_000, calls: 100, timeMs: 3_600_000 }, tieredApproval: { maxTasks: 5, maxFiles: 10 } }]);
    expect(state.selected).toBe("billing");
    text = await frame(view, 100, 40, "started");
    expect(flat(text)).toContain("N rejects it");
    await press(view, "n");
    text = await frame(view, 100, 40, "reject-reason");
    expect(flat(text)).toContain("Why reject plan revision 2?");
    await type("Too coarse");
    await press(view, "return");
    await act(async () => { await Bun.sleep(20); });
    expect(acted.at(-1)).toEqual({ kind: "reject", expectedRevision: 5, requestId: "split-2", reason: "Too coarse" });
    await press(view, "e");
    text = await frame(view, 100, 40, "rename");
    expect(flat(text)).toContain("New title of feature schema");
    await press(view, "escape");
    expect(acted).toHaveLength(1);
    await press(view, "s");
    await type("schema-a: Tables; schema-b: Migrations");
    await press(view, "return");
    await act(async () => { await Bun.sleep(20); });
    expect(acted.at(-1)).toEqual({ kind: "edit", expectedRevision: 5, edit: { op: "split", featureId: "schema", into: [{ id: "schema-a", title: "Tables" }, { id: "schema-b", title: "Migrations" }] } });
  } finally { await act(async () => view.renderer.destroy()); }
}, 20000);

const info: WorkflowInfo = {
  estimate: { tokens: { low: 90000, high: 300000 }, basis: "defaults", samples: 0, label: "Estimate: 90k–300k tokens" },
  enabled: true, defaultWorkflow: "sdd", workflows: ["sdd", "review-only"],
  definitions: {
    sdd: { stages: ["research", "specify", "plan"], writes: true, problems: [], execution: null, worktreeRefusal: null },
    "review-only": { stages: ["review"], writes: false, problems: [], execution: null, worktreeRefusal: "A definition that reviews the working copy's diff runs inline; a worktree would not contain that diff" },
  },
  policy: { ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] }] },
  presets: { quick: { maxTotalTokens: 200000, maxAgentCalls: 40, maxActiveMs: 1800000 }, standard: { maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 3600000 }, extended: { maxTotalTokens: 800000, maxAgentCalls: 160, maxActiveMs: 7200000 }, checkpoints: { maxTotalTokens: 1000000000, maxAgentCalls: 160, maxActiveMs: 7200000, checkpointTokens: 200000 } },
};

for (const [width, height] of SIZES) {
  test(`new-run form at ${width}x${height}: worktree toggle, writers and the core's refusal`, async () => {
    const started: StartRunInput[] = [];
    let view!: View;
    await act(async () => {
      view = await testRender(
        <PremiumPopup visible title="Workflow" width={Math.min(120, width)} height={Math.min(40, height)} footerHints={[{ key: "Esc", label: "back" }]}>
          <NewRunForm active info={info} model="fixture/model" initialPrompt="Add a search box" width={Math.min(120, width) - 6}
            onStart={async (input) => { started.push(input); }} onCancel={() => {}} />
        </PremiumPopup>,
        { width, height },
      );
    });
    try {
      // The prompt fills the feature ID, so focus starts on it: feature → workflow → budget → cost cap.
      for (let i = 0; i < 3; i++) await press(view, "tab");
      await act(async () => { await view.mockInput.typeText("2.5"); });
      // Then the execution mode.
      await press(view, "tab");
      let text = await frame(view, width, height, "inline");
      expect(text).toContain("‹ inline ›");
      // The skipped writer row lies below the focused field; a small terminal scrolls past it.
      if (height >= 40) expect(text).toContain("more needs worktree");
      // Writers are skipped while inline: the next field is Questions, then Tests, Routes and the start button.
      await press(view, "tab");
      await press(view, "right");
      if (height >= 40) expect(await frame(view, width, height, "assume")).toContain("‹ assume ›");
      await press(view, "tab");
      await press(view, "right");
      if (height >= 40) expect(await frame(view, width, height, "warn")).toContain("‹ warn ›");
      await press(view, "tab");
      await press(view, "right");
      if (height >= 40) expect(await frame(view, width, height, "run model only")).toContain("‹ run model only ›");
      await press(view, "tab");
      await press(view, "return");
      expect(started.at(-1)).toMatchObject({ executionMode: "inline", clarification: "assume", testIntegrity: "warn", modelStrict: true, maxCostUsd: 2.5 });
      expect(started.at(-1)?.maxConcurrentWriters).toBeUndefined();
      for (let i = 0; i < 4; i++) await press(view, "up");
      await press(view, "right");
      text = await frame(view, width, height, "worktree");
      expect(text).toContain("‹ worktree ›");
      expect(text).toContain("‹ 1 › of 4");
      await press(view, "tab");
      for (let i = 0; i < 5; i++) await press(view, "right");
      text = await frame(view, width, height, "writers");
      expect(text).toContain("‹ 4 › of 4");
      await press(view, "left");
      await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
      await act(async () => { await Bun.sleep(20); });
      expect(started.at(-1)).toMatchObject({ workflowId: "sdd", executionMode: "worktree", maxConcurrentWriters: 3 });
      // Review-only refuses a worktree with the core's own words, and nothing starts.
      const count = started.length;
      for (let i = 0; i < 4; i++) await press(view, "up");
      await press(view, "right");
      expect(started.length).toBe(count);
      for (let i = 0; i < 3; i++) await press(view, "down");
      await press(view, "right");
      await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
      await act(async () => { await Bun.sleep(20); });
      text = await frame(view, width, height, "refused");
      expect(started.length).toBe(count);
      expect(flat(text)).toContain("runs inline");
    } finally { await act(async () => view.renderer.destroy()); }
  }, 20000);
}
