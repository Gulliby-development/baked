import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { RunSnapshot, WorkflowEvent } from "../../src/core/workflows/schemas.js";
import type { RunSummary, WorkflowInfo } from "../../src/core/workflows/view.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
const task = { id: "T001", title: "Verify a long task description and its dependencies", description: "Task", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/example.ts", action: "modify" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Requirement" };
const snapshot: RunSnapshot = { runId: "fixture", featureId: "a-rather-long-feature-name", status: "waiting", reason: "approval", revision: 7, eventSeq: 20, stageId: "approve", approvalDigest: null, inputHash: "a".repeat(64), workspaceHash: "b".repeat(64), tokenUsage: 1000, activeMs: 10000, estimatedCostUsd: null, verificationState: "not_verified", pendingRequestIds: ["approval"] };
const budget = { tokens: 1000, heldTokens: 0, inFlightTokens: 0, maxTokens: 400000, calls: 4, maxCalls: 80, activeMs: 10000, maxActiveMs: 3600000, repairRounds: 0, maxRepairRounds: 2 };
const kinds = ["research", "specify", "plan", "analyze", "approve", "task-graph", "checks", "review", "converge", "learn"];
const stages = kinds.map((kind, i) => ({ id: kind === "task-graph" ? "implement" : kind, kind, status: i < 4 ? "completed" : i === 4 ? "waiting" : "pending", generation: 0 }));
const details = { title: "Verifiable specification", prompt: "Add a check", specMarkdown: "# Spec\n\nSpecification text", plan: "## Plan\nText that checks wrapping of long plan lines in narrow terminals.\n".repeat(20), criteria: [{ id: "AC-001", text: "Given initial data; when the task runs; then the result is verified", method: "automated", verdict: null, evidenceIds: [] }], lastError: null };
const events: WorkflowEvent[] = [
  { schemaVersion: 1, eventId: "e1", runId: "fixture", seq: 19, at: new Date().toISOString(), type: "stage.started", payload: { stepId: "s1", stageId: "approve", generation: 0 } },
  { schemaVersion: 1, eventId: "e2", runId: "fixture", seq: 20, at: new Date().toISOString(), type: "request.created", payload: { requestId: "approval", kind: "approval", digest: "c".repeat(64) } },
];
const actions: unknown[] = [];
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
    events: () => events,
    tasks: () => [{ id: "T001", status: "pending", generation: 0, definition_json: JSON.stringify(task) }],
    findings: () => [],
    checks: () => [{ check_id: "tests", status: "passed", validity: "current", snapshot_id: "snapshot", evidence_id: "host-evidence" }],
    checkDetails: () => [{ checkId: "tests", status: "failed", validity: "current", exitCode: 1, reason: "exit", durationMs: 1500, runs: 2, outputTail: "expect(received).toBe(expected)" }],
    configuredChecks: () => ["tests", "lint"],
    changes: () => [{ path: "src/example.ts", source: "code", action: "modified", edits: 2, status: "applied", drifted: false }, { path: "specs/x/spec.md", source: "spec", action: "created", edits: 1, status: "applied", drifted: false }],
  },
};
const runs: RunSummary[] = [
  { snapshot: { ...snapshot, runId: "done", featureId: "finished-feature", status: "completed", reason: "none", pendingRequestIds: [] }, title: null, stage: { index: 9, total: 10, id: "learn" }, tasks: { done: 2, total: 2 }, pendingKind: null, budget, createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000 },
  { snapshot, title: details.title, stage: { index: 4, total: 10, id: "approve" }, tasks: { done: 0, total: 1 }, pendingKind: "approval", budget, createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000 },
];
const info: WorkflowInfo = { enabled: true, defaultWorkflow: "sdd", workflows: ["sdd"], policy: defaultWorkflowPolicy, presets: { quick: { maxTotalTokens: 200000, maxAgentCalls: 40, maxActiveMs: 1800000 }, standard: { maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 3600000 }, extended: { maxTotalTokens: 800000, maxAgentCalls: 160, maxActiveMs: 7200000 } } };
mock.module("../../src/hooks/useWorkflow.js", () => ({
  useWorkflow: (_workspace: string, runId: string | null) => ({ service: runId ? service : null, snapshot: runId ? snapshot : null, error: null, generation: 1, act: async (action: unknown) => { actions.push(action); } }),
  useWorkflowRuns: () => ({ runs, info, enabled: true, error: null, reload: () => {} }),
  workflowSession: () => ({ start: async () => snapshot }),
  reloadWorkflowSession: async () => true,
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
    assert((await frame("new")).includes("New workflow run"), "new-run form opens from the list");
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
    }
    await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
    assert((await frame("back-home")).includes("finished-feature"), "Esc returns to the run list");
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
