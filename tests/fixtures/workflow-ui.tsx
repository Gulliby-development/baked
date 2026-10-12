import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { RunSnapshot, WorkflowEvent } from "../../src/core/workflows/schemas.js";
import type { RunSummary, WorkflowInfo } from "../../src/core/workflows/view.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { readEditorSource, writeDefinitionFile } from "../../src/core/workflows/v2/editor.js";
const task = { id: "T001", title: "Verify a long task description and its dependencies", description: "Task", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/example.ts", action: "modify" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Requirement" };
const snapshot: RunSnapshot = { runId: "fixture", featureId: "a-rather-long-feature-name", status: "waiting", reason: "approval", revision: 7, eventSeq: 20, stageId: "approve", approvalDigest: null, inputHash: "a".repeat(64), workspaceHash: "b".repeat(64), tokenUsage: 1000, activeMs: 10000, estimatedCostUsd: null, verificationState: "not_verified", limitations: { count: 0, ids: [] }, pendingRequestIds: ["approval"] };
const budget = { tokens: 1000, heldTokens: 0, inFlightTokens: 0, maxTokens: 400000, calls: 4, maxCalls: 80, activeMs: 10000, maxActiveMs: 3600000, repairRounds: 0, maxRepairRounds: 2 };
const kinds = ["research", "specify", "plan", "analyze", "approve", "task-graph", "checks", "review", "converge", "learn"];
const stages = kinds.map((kind, i) => ({ id: kind === "task-graph" ? "implement" : kind, kind, status: i < 4 ? "completed" : i === 4 ? "waiting" : "pending", generation: 0 }));
const details = { title: "Verifiable specification", prompt: "Add a check", specMarkdown: "# Spec\n\nSpecification text", plan: "## Plan\nText that checks wrapping of long plan lines in narrow terminals.\n".repeat(20), criteria: [{ id: "AC-001", text: "Given initial data; when the task runs; then the result is verified", method: "automated", verdict: null, evidenceIds: [] }], lastError: null, autoApproval: null };
const events: WorkflowEvent[] = [
  { schemaVersion: 1, eventId: "e1", runId: "fixture", seq: 19, at: new Date().toISOString(), type: "stage.started", payload: { stepId: "s1", stageId: "approve", generation: 0 } },
  { schemaVersion: 1, eventId: "e2", runId: "fixture", seq: 20, at: new Date().toISOString(), type: "request.created", payload: { requestId: "approval", kind: "approval", digest: "c".repeat(64) } },
];
const actions: unknown[] = [];
const initiative = {
  initiativeId: "values", title: "Value files", status: "awaiting_approval", reason: "", revision: 2, eventSeq: 4, planRevision: 1,
  approvedPlanRevision: null, approvalDigest: null, planDigest: "e".repeat(64), goals: [], completionCriteria: [], workflowId: "sdd",
  featureAutoApproval: null, decompose: null,
  features: ["core", "api", "docs"].map((id, i) => ({ id, title: `Feature ${id}`, mandatory: true, dependsOn: i === 1 ? ["core"] : [], boundary: { scope: id, paths: [] }, contract: `${id} contract`, runFeatureId: `values_${id}`, state: "proposed", runId: null, runStatus: null, runReason: null, pinned: [], contractHash: null, blockers: [], pendingRequests: [], usage: { tokens: 0, calls: 0, activeMs: 0 }, runIds: [] })),
  pendingDecisions: [{ scope: "initiative", featureId: null, runId: null, requestId: "split", kind: "split_approval", digest: "e".repeat(64) }],
  budget: { limits: { maxTotalTokens: 1600000, maxAgentCalls: 320, maxActiveMs: 14400000 }, used: { tokens: 0, calls: 0, activeMs: 0 }, reserved: { tokens: 0, calls: 0, activeMs: 0 }, remaining: { tokens: 1600000, calls: 320, activeMs: 14400000 }, unstartedFeatures: 0, nextShare: null, rule: "" },
  next: { kind: "await_split_approval", featureId: null, runId: null, message: "Approve the split (plan revision 1) or edit it." },
};
const approvalRequest = { id: "approval", kind: "approval", digest: "c".repeat(64), body_json: JSON.stringify({ writes: task.writes, checks: [{ id: "tests", executable: "bun", args: ["test"] }] }), status: "pending", answer_json: null };
const clarificationRequest = { id: "clarify", kind: "clarification", digest: "d".repeat(64), status: "pending", answer_json: null, body_json: JSON.stringify({ findings: [
  { id: "parallel-test-write-conflict", kind: "inconsistency", blocking: true, description: "T002 and T003 run in parallel but both modify tests/workflow-runtime.test.ts without a dependency or a merge protocol.", refs: ["task graph T002.writes: tests/workflow-runtime.test.ts", "task graph T003.writes: tests/workflow-runtime.test.ts", "plan Task graph: T002 and T003 in parallel"] },
  { id: "ac010-verification-mismatch", kind: "inconsistency", blocking: true, description: "FR-018 is declared automated while AC-010 is manual.", refs: ["spec AC-010: method=manual"] },
  { id: "build-gate-undefined", kind: "ambiguity", blocking: false, description: "SC-001 requires bun run build for startup changes but the plan excludes build.", refs: ["spec SC-001"] },
] }) };
let pendingRequests: unknown[] = [approvalRequest];
const service = {
  isDriving: () => false,
  diff: async (_runId: string, path: string) => ({ path, kind: "git", text: "@@ -1 +1 @@\n-old\n+new", preexistingChanges: false, truncated: false }),
  driveError: () => null,
  store: {
    requests: () => pendingRequests,
    details: () => details,
    stages: () => stages,
    budget: () => budget,
    estimate: () => ({ saved: null, comparison: null, projection: { total: { low: 90000, high: 300000 }, remaining: { low: 80000, high: 290000 }, basis: "defaults", samples: 0, tokensPerMinute: 4000, minutesLeft: 90, exhaustsAt: { typical: null, high: "implement" }, label: "Estimate: about 90k–300k tokens in total, 80k–290k still to spend (generic range: this project has no finished runs yet)" } }),
    events: () => events,
    tasks: () => [{ id: "T001", status: "pending", generation: 0, definition_json: JSON.stringify(task) }],
    findings: () => [],
    checks: () => [{ check_id: "tests", status: "passed", validity: "current", snapshot_id: "snapshot", evidence_id: "host-evidence" }],
    checkDetails: () => [{ checkId: "tests", status: "failed", validity: "current", exitCode: 1, reason: "exit", durationMs: 1500, runs: 2, outputTail: "expect(received).toBe(expected)" }],
    configuredChecks: () => ["tests", "lint"],
    runModel: () => "fixture/model",
    worktree: () => null,
    routing: () => null,
    changes: () => [{ path: "src/example.ts", source: "code", action: "modified", edits: 2, status: "applied", drifted: false }, { path: "specs/x/spec.md", source: "spec", action: "created", edits: 1, status: "applied", drifted: false }],
  },
};
const runs: RunSummary[] = [
  { snapshot: { ...snapshot, runId: "done", featureId: "finished-feature", status: "completed", reason: "none", pendingRequestIds: [] }, title: null, stage: { index: 9, total: 10, id: "learn" }, tasks: { done: 2, total: 2 }, pendingKind: null, budget, createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000 },
  { snapshot, title: details.title, stage: { index: 4, total: 10, id: "approve" }, tasks: { done: 0, total: 1 }, pendingKind: "approval", budget, createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000 },
];
const info: WorkflowInfo = { estimate: { tokens: { low: 90000, high: 300000 }, basis: "defaults", samples: 0, label: "Estimate: 90k–300k tokens (generic range: this project has no finished runs yet)" }, enabled: true, defaultWorkflow: "sdd", workflows: ["sdd"], definitions: { sdd: { stages: ["research", "specify", "plan"], writes: true, problems: [] } }, policy: defaultWorkflowPolicy, presets: { quick: { maxTotalTokens: 200000, maxAgentCalls: 40, maxActiveMs: 1800000 }, standard: { maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 3600000 }, extended: { maxTotalTokens: 800000, maxAgentCalls: 160, maxActiveMs: 7200000 }, checkpoints: { maxTotalTokens: 1000000000, maxAgentCalls: 160, maxActiveMs: 7200000, checkpointTokens: 200000 } } };
mock.module("../../src/hooks/useWorkflow.js", () => ({
  useWorkflow: (_workspace: string, runId: string | null) => ({ service: runId ? service : null, snapshot: runId ? snapshot : null, error: null, generation: 1, act: async (action: unknown) => { actions.push(action); } }),
  useWorkflowRuns: () => ({ runs, info, enabled: true, error: null, reload: () => {} }),
  workflowSession: () => ({ start: async () => snapshot }),
  reloadWorkflowSession: async () => true,
  existingWorkflowSession: () => null,
  workflowRoutingApi: () => ({ load: () => ({ global: undefined, project: undefined, workflows: ["sdd"] }), explain: () => { throw new Error("no run model"); }, save: () => {} }),
  workflowGatesApi: () => ({ load: () => defaultWorkflowPolicy.checks.length ? defaultWorkflowPolicy.checks : [{ id: "tests", executable: "bun", args: ["run", "test"], cwd: ".", timeoutMs: 600000, required: true, scope: "feature", envNames: [], writes: [] }], save: async () => {}, suggest: () => [], run: async () => ({ status: "passed", exitCode: 0, durationMs: 10, outputTail: "", truncated: false }) }),
  // The editor reads and writes a temp workspace; user gate and profile folders are temp folders too.
  workflowEditorApi: () => {
    const root = process.env.BAKED_WORKFLOW_FIXTURE_ROOT ?? process.cwd();
    const workspace = join(root, "editor-workspace");
    return {
      open: (id: string) => readEditorSource(workspace, id, defaultWorkflowPolicy, { gateDirectories: { user: join(root, "user-gates"), project: join(workspace, "baked", "gates") }, profileDirectory: join(root, "user-agents") }),
      save: (definition: Parameters<typeof writeDefinitionFile>[1]) => writeDefinitionFile(workspace, definition),
      history: async () => null,
    };
  },
  // One initiative waits for its split approval; Enter on it shows the detail.
  workflowInitiativesApi: () => ({
    load: async () => ({ initiatives: [initiative], driving: [], errors: {} }),
    act: async () => initiative,
  }),
  useWorkflowBadge: () => {},
}));
const { useWorkflowStore } = await import("../../src/stores/workflow.js");
const { WorkflowPanel } = await import("../../src/components/workflow/WorkflowPanel.js");
const capture = process.env.BAKED_UI_CAPTURE_DIR;
if (capture) mkdirSync(capture, { recursive: true });
let frames = 0;
for (const [width, height] of [[120, 40], [80, 24], [50, 20]]) {
  useWorkflowStore.setState({ selectedRunId: null, screen: "home", draftPrompt: "" });
  pendingRequests = [approvalRequest];
  let view!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => { view = await testRender(<WorkflowPanel visible workspace="fixture" activeModel="fixture/model" onClose={() => {}} />, { width, height }); });
  const frame = async (name: string): Promise<string> => {
    for (let i = 0; i < 3; i++) await act(async () => { await view.renderOnce(); });
    const popup = view.renderer.root.findDescendantById("baked-popup");
    assert(popup && popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= width! && popup.y + popup.height <= height!, `${name}: bounds`);
    const text = view.captureCharFrame();
    assert(text.includes("Workflow"), `${name}: title`);
    assert(text.toLowerCase().includes("esc"), `${name}: exit hint`);
    if (capture) writeFileSync(join(capture, `${width}-${height}-${name}.txt`), text);
    frames++;
    return text;
  };
  try {
    const home = await frame("home");
    assert(home.includes("finished-feature"), "home lists runs");
    assert(/needs your approval/.test(home) || width < 80, "home shows what needs the user");
    await act(async () => view.mockInput.pressKey("n"));
    const form = await frame("new");
    assert(form.includes("New workflow run"), "new-run form opens from the list");
    assert(height! < 40 || form.includes("research → specify → plan"), "the form shows the workflow's stages");
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    await act(async () => view.mockInput.pressEnter());
    const decision = await frame("decision-auto");
    assert(decision.includes("Approve the plan"), "a pending approval opens the decision first");
    await act(async () => view.mockInput.pressKey("a"));
    assert(actions.some((a) => typeof a === "object" && a !== null && "kind" in a && a.kind === "approve"), "A approves");
    await act(async () => view.mockInput.pressKey("x"));
    await act(async () => { await view.renderOnce(); });
    await act(async () => { await view.mockInput.typeText("scope cut"); });
    await act(async () => view.mockInput.pressEnter());
    assert(actions.some((a) => typeof a === "object" && a !== null && "kind" in a && a.kind === "reject" && "explanation" in a && a.explanation === "scope cut"), "X collects a rejection reason");
    assert(!(await frame("reject-typed")).includes("Cancel this run?"), "typing in the reason never triggers run actions");
    for (const tab of ["tasks", "changes", "spec", "plan", "checks", "criteria", "findings", "overview"]) {
      await act(async () => view.mockInput.pressTab());
      const text = await frame(tab);
      if (tab === "changes") {
        await act(async () => view.mockInput.pressEnter());
        await act(async () => { await Bun.sleep(20); });
        const diffFrame = await frame("changes-diff");
        assert(diffFrame.includes("+new") || height < 24, "Enter shows the selected file diff");
        assert(diffFrame.includes("diff") && !diffFrame.includes("decide"), "changes footer names its own keys");
      }
      if (tab === "checks") assert(text.includes("lint: not run yet"), "checks list configured checks that have not run");
      if (tab === "overview") assert(text.includes("Waiting at Approve") || width < 80, "overview explains the state");
      if (tab === "overview" && width >= 80) assert(text.includes("Estimate: about"), "overview labels the spend estimate as an estimate");
    }
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    assert((await frame("back-home")).includes("finished-feature"), "Esc returns to the run list");
    // I opens the initiatives from the run list; Enter shows one, Esc twice returns to the runs.
    await act(async () => view.mockInput.pressKey("i"));
    await act(async () => { await Bun.sleep(20); });
    const list = await frame("initiatives");
    assert(list.includes("values") && list.includes("approve split"), "I opens the initiative list");
    await act(async () => view.mockInput.pressEnter());
    const detail = await frame("initiative");
    assert((detail.includes("Value files") || width < 80) && detail.includes("core"), "Enter opens the initiative detail");
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    assert((await frame("initiatives-back")).includes("finished-feature"), "Esc leaves the initiatives for the run list");
    await act(async () => view.mockInput.pressKey("g"));
    const gates = await frame("gates");
    assert(gates.includes("Gates") && gates.includes("bun run test"), "G opens the gate window with the configured gates");
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    assert((await frame("gates-back")).includes("finished-feature"), "Esc leaves the gate window for the run list");
    // E on the workflow field of the new-run form opens the editor; Esc returns to the form.
    await act(async () => view.mockInput.pressKey("n"));
    // Description, GitHub issue and feature ID come before the workflow field.
    await act(async () => view.mockInput.pressTab());
    await act(async () => view.mockInput.pressTab());
    await act(async () => view.mockInput.pressTab());
    await act(async () => view.mockInput.pressKey("e"));
    const editor = await frame("editor");
    assert(editor.includes("Workflow editor: sdd") && editor.includes("read only"), "E opens the editor on the chosen workflow, read only for a built-in");
    assert(editor.includes("frozen copy"), "the editor says started runs keep their frozen copy");
    await act(async () => view.mockInput.pressKey("c"));
    const copy = await frame("editor-copy");
    assert(copy.includes("sdd-custom"), "C duplicates a built-in as a custom workflow");
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    assert((await frame("editor-discard")).includes("Discard unsaved changes?"), "Esc with changes asks first");
    await act(async () => view.mockInput.pressKey("y"));
    assert((await frame("editor-back")).includes("New workflow run"), "leaving the editor returns to the new-run form");
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    // Several analysis findings arrive as one clarification request.
    pendingRequests = [clarificationRequest];
    await act(async () => view.mockInput.pressEnter());
    const questions = await frame("clarification");
    assert(!questions.includes('{"blocking"'), "findings are not dumped as JSON");
    assert(questions.includes("3 questions") || width < 80, "the question count is visible");
    assert(questions.includes("Question 1 of 3"), "the current question is shown in full");
    await act(async () => { await view.mockInput.typeText("Add a dependency T003 -> T002"); });
    await act(async () => view.mockInput.pressEnter());
    assert((await frame("clarification-2")).includes("Question 2 of 3"), "Enter moves to the next question");
    await act(async () => view.mockInput.pressArrow("up"));
    const back = await frame("clarification-back");
    assert(back.includes("Question 1 of 3") && back.includes("Add a dependency T003"), "the earlier answer is kept");
    const before = actions.length;
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    assert.equal(actions.length, before, "a missing blocking answer asks for confirmation first");
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    const sent = actions.at(-1) as { kind: string; answers: Record<string, string> };
    assert.equal(sent.kind, "answer");
    assert.deepEqual(Object.values(sent.answers), ["Add a dependency T003 -> T002"]);
    assert(Object.keys(sent.answers)[0]?.startsWith("parallel-test-write-conflict: T002 and T003"), "answers carry the question");
  } finally { await act(async () => view.renderer.destroy()); }
}
console.log(JSON.stringify({ frames, approvals: actions.length }));
process.exit(0);
