import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectChecks,
  errorHint,
  eventText,
  featureSlug,
  headline,
  isFeatureId,
  budgetLimitText,
  runActions,
  stageGlyph,
  stageText,
} from "../src/components/workflow/format.js";
import { orderRuns } from "../src/components/workflow/RunList.js";
import { formatWorkflowResult } from "../src/core/commands/workflow.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { readRunFileDiff } from "../src/core/workflows/run-diff.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunSnapshot } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import {
  type RunSummary,
  readWorkflowSummaries,
  readWorkflowView,
  readWorkflowViewIfChanged,
} from "../src/core/workflows/view.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const snapshot = (patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  runId: "run",
  featureId: "feature",
  status: "running",
  reason: "none",
  revision: 1,
  eventSeq: 1,
  stageId: "plan",
  approvalDigest: null,
  inputHash: "a".repeat(64),
  workspaceHash: null,
  tokenUsage: 0,
  activeMs: 0,
  estimatedCostUsd: null,
  verificationState: "not_verified",
  limitations: { count: 0, ids: [] },
  pendingRequestIds: [],
  ...patch,
});
const stages = [
  { id: "plan", kind: "plan", status: "running" as const, generation: 0 },
  { id: "approve", kind: "approve", status: "pending" as const, generation: 0 },
];

describe("workflow panel formatting", () => {
  test("feature slugs are valid ids and fall back for non-latin text", () => {
    expect(featureSlug("Add a --json flag to `baked workflow status`!")).toBe("add-a-json-flag-to");
    expect(featureSlug("\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c JSON \u0441\u0442\u0430\u0442\u0443\u0441 \u0434\u043b\u044f \u0437\u0430\u043f\u0443\u0441\u043a\u0430")).toBe("dobavit-json-status-dlya-zapuska");
    expect(isFeatureId(featureSlug("\u0421\u0434\u0435\u043b\u0430\u0442\u044c \u043a\u0440\u0430\u0441\u0438\u0432\u043e"))).toBe(true);
    expect(isFeatureId("bad id")).toBe(false);
  });
  test("actions offered match the run state", () => {
    const keys = (s: RunSnapshot) => runActions(s).map((a) => a.action);
    
    expect(keys(snapshot({ status: "running" }))).toEqual(["pause", "cancel"]);
    expect(keys(snapshot({ status: "paused" }))).toEqual(["resume", "undo", "cancel"]);
    expect(keys(snapshot({ status: "waiting", pendingRequestIds: ["r"] }))).toEqual([
      "decide",
      "undo",
      "cancel",
    ]);
    expect(keys(snapshot({ status: "blocked", reason: "budget_exhausted" }))).toEqual([
      "extend",
      "fork",
      "undo",
      "cancel",
    ]);
    expect(keys(snapshot({ status: "completed" }))).toEqual(["fork", "undo"]);
    expect(keys(snapshot({ status: "created" }))).toEqual(["resume", "cancel"]);
  });
  test("an ended run with its worktree on disk offers the discard", () => {
    const discard = (s: RunSnapshot, worktree: boolean) =>
      runActions(s, null, null, worktree).find((a) => a.action === "discard-worktree")?.key;
    expect(discard(snapshot({ status: "failed" }), true)).toBe("D");
    expect(discard(snapshot({ status: "cancelled" }), false)).toBeUndefined();
    expect(discard(snapshot({ status: "paused" }), true)).toBeUndefined();
  });
  test("a stopped run offers a switch to the tab's model", () => {
    const blocked = snapshot({ status: "blocked", reason: "provider_account" });
    expect(runActions(blocked, null, "codex/gpt-6-luna").find((a) => a.action === "reroute")?.key).toBe("M");
    expect(runActions(blocked).some((a) => a.action === "reroute")).toBe(false);
    expect(runActions(snapshot({ status: "running" }), null, "codex/gpt-6-luna").some((a) => a.action === "reroute")).toBe(false);
    expect(headline(blocked, stages, false).next).toContain("M to continue");
  });
  test("headline explains state and next step", () => {
    expect(headline(snapshot(), stages, true).now).toBe("Working on Plan.");
    const waiting = headline(
      snapshot({ status: "waiting", reason: "approval", stageId: "approve" }),
      stages,
      false,
    );
    expect(waiting.now).toContain("Waiting at Approve");
    expect(waiting.next).toContain("Enter");
    expect(headline(snapshot(), stages, false).next).toContain("releases the workspace");
  });
  test("activity skips noise and names stages", () => {
    const base = { schemaVersion: 1 as const, eventId: "e", runId: "run", seq: 1, at: new Date().toISOString() };
    expect(
      eventText({ ...base, type: "stage.started", payload: { stepId: "s", stageId: "plan", generation: 1 } }, stages),
    ).toBe("Plan started (round 2)");
    expect(
      eventText({ ...base, type: "budget.updated", payload: { usedTokens: 1, reservedTokens: 0, activeMs: 0, estimatedCostUsd: null } }, stages),
    ).toBeNull();
    const wait = { stageId: "wait-ci", deadline: "2026-10-10T08:00:00.000Z", intervalSeconds: 30, polls: 0 };
    expect(eventText({ ...base, type: "wait.progress", payload: { ...wait, pending: ["ci-green"] } }, stages)).toMatch(/^Waiting for ci-green until .+ \(every 30s\)$/);
    expect(eventText({ ...base, type: "wait.progress", payload: { ...wait, pending: [] } }, stages)).toBe("Wait gates pass");
  });
  test("paused stages and no-op transitions read correctly", () => {
    const stage = { id: "plan", kind: "plan", status: "running" as const, generation: 0 };
    expect(stageGlyph(stage, true, "paused")).toBe("‖");
    expect(stageGlyph(stage, true, "running")).toBe("▶");
    expect(stageText({ ...stage, produces: "plan" }, true, "▶")).toBe("[▶ Plan → plan]");
    expect(stageText({ ...stage, produces: "plan", generation: 1 }, false, "✓")).toBe("✓ Plan×2");
    const base = { schemaVersion: 1 as const, eventId: "e", runId: "run", seq: 1, at: new Date().toISOString() };
    expect(eventText({ ...base, type: "run.state_changed", payload: { from: "paused", to: "paused", reason: "user_pause", revision: 2 } }, stages)).toBeNull();
  });
  test("budget blocks name the limit and count held reservations", () => {
    const budget = { tokens: 294851, heldTokens: 420370, inFlightTokens: 0, maxTokens: 800000, calls: 3, maxCalls: 160, activeMs: 154274, maxActiveMs: 7200000, repairRounds: 0, maxRepairRounds: 2 };
    expect(budgetLimitText(budget)).toBe("the next agent step needs more tokens than remain: 715k of 800k are used or held, 85k left");
    expect(budgetLimitText({ ...budget, calls: 160 })).toContain("agent calls");
    const blocked = headline(snapshot({ status: "blocked", reason: "budget_exhausted", stageId: "plan" }), stages, false, budget);
    expect(blocked.now).toContain("715k of 800k");
    expect(blocked.next).toContain("starts again from Research");
  });
  test("errors get an actionable hint", () => {
    expect(errorHint("Select a model before starting a workflow")).toContain("Ctrl+L");
    expect(errorHint("Workflows are turned off by workflows.enabled: false in the configuration.")).toContain("press E");
    expect(errorHint("something unexpected")).toBeNull();
  });
  test("runs needing the user sort first", () => {
    const summary = (id: string, status: RunSnapshot["status"], pendingKind: string | null, updatedAt: number) =>
      ({ snapshot: snapshot({ runId: id, status }), pendingKind, updatedAt }) as RunSummary;
    const ordered = orderRuns([
      summary("done", "completed", null, 3),
      summary("active", "running", null, 2),
      summary("waiting", "waiting", "approval", 1),
    ]);
    expect(ordered.map((r) => r.snapshot.runId)).toEqual(["waiting", "active", "done"]);
  });
  test("checks are proposed from package scripts with the project runner", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-wf-checks-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    expect(detectChecks(root)).toEqual([]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "x", lint: "y" } }));
    writeFileSync(join(root, "bun.lock"), "");
    const checks = detectChecks(root);
    expect(checks.map((c) => c.id)).toEqual(["lint", "tests"]);
    expect(checks[1]).toMatchObject({ executable: "bun", args: ["run", "test"], required: true });
  });
  test("slash results are summarized instead of dumped as JSON", () => {
    const text = formatWorkflowResult(
      snapshot({ status: "waiting", reason: "approval", pendingRequestIds: ["r"] }),
    );
    expect(text).toContain("feature: waiting");
    expect(text).toContain("decision is waiting");
    expect(formatWorkflowResult({ items: [] })).toContain('"items"');
  });
});

describe("workflow view model", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "baked-wf-view-"));
    const policy = defaultWorkflowPolicy;
    const service = new NativeWorkflowService(root, {
      ...DEFAULT_CONFIG,
      defaultModel: "fixture/model",
      workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy },
    });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => service.close());
    return { service, policy };
  };
  test("exposes stages, budget and recent events without shipping runtime state", async () => {
    const { service, policy } = setup();
    const run = await service.start({ commandId: newId(), featureId: "view", workflowId: "sdd", prompt: "Show it", ownerLabel: "test", policy });
    const view = readWorkflowView(service, run.runId);
    expect(view.stages.map((s) => s.kind)).toEqual([
      "research", "specify", "plan", "analyze", "approve", "task-graph", "checks", "review", "converge", "learn",
    ]);
    expect(view.stages.every((s) => s.status === "pending")).toBe(true);
    expect(view.budget).toMatchObject({ tokens: 0, maxTokens: policy.maxTotalTokens, maxCalls: policy.maxAgentCalls });
    expect(view.details.prompt).toContain("Show it");
    // Creation records the run, the model routing it froze, then the estimate made at that moment.
    expect(view.events.map((e) => e.type)).toEqual(["run.created", "artifact.committed", "artifact.committed"]);
    expect(view.estimate.saved).toMatchObject({ basis: "defaults" });
    expect("state" in view).toBe(false);
    // The run's own definition as a line: its review gates, none of them run yet.
    expect(view.gates.review?.map((g) => [g.id, g.mode, g.last])).toEqual([
      ["correctness-review", "required", null],
      ["security-review", "required", null],
    ]);
    expect(readWorkflowViewIfChanged(service, run.runId, view.stamp)).toBeNull();
    const step = service.store.beginStep(run.runId, "research");
    const changed = readWorkflowViewIfChanged(service, run.runId, view.stamp);
    expect(changed?.stages[0]).toMatchObject({ id: "research", status: "running" });
    service.store.finishStep(run.runId, step, "completed");
    expect(readWorkflowView(service, run.runId).stages[0]?.status).toBe("completed");
  });
  test("summaries list runs with stage position and pending request kind", async () => {
    const { service, policy } = setup();
    const run = await service.start({ commandId: newId(), featureId: "listed", workflowId: "sdd", prompt: "List it", ownerLabel: "test", policy });
    service.store.transaction(() => service.store.request(run.runId, "clarification", "b".repeat(64), { questions: [] }));
    const [summary] = readWorkflowSummaries(service, 10);
    expect(summary).toMatchObject({ pendingKind: "clarification", tasks: { done: 0, total: 0 } });
    expect(summary?.stage.total).toBe(10);
    expect(summary?.snapshot.featureId).toBe("listed");
  });
});

describe("workflow run changes and checks", () => {
  const setupRun = async (git: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "baked-wf-diff-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sh = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(root, "kept.ts"), "export const a = 1;\n");
    if (git) {
      sh(["init", "-q"]);
      sh(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
      sh(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
    }
    const service = new NativeWorkflowService(root, {
      ...DEFAULT_CONFIG,
      defaultModel: "fixture/model",
      workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy },
    });
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "diff", workflowId: "sdd", prompt: "Change files", ownerLabel: "test", policy: defaultWorkflowPolicy });
    const step = service.store.beginStep(run.runId, "implement");
    const attempt = service.store.reserve(run.runId, step, null, 0, defaultWorkflowPolicy);
    const edit = (path: string, before: string | null, content: string) => {
      writeFileSync(join(root, path), content);
      service.store.transaction(() => {
        const id = service.store.prepareEffect(run.runId, attempt, "file_patch", { path, tool: "edit_file" }, before, null);
        service.store.finishFileEffect(run.runId, id, hashBytes(content));
      });
    };
    return { root, service, runId: run.runId, edit };
  };
  test("lists touched files, flags outside edits and diffs only those files", async () => {
    const { root, service, runId, edit } = await setupRun(true);
    edit("kept.ts", hashBytes("export const a = 1;\n"), "export const a = 2;\n");
    edit("added.ts", null, "export const b = 1;\n");
    const changes = readWorkflowView(service, runId).changes;
    expect(changes.map((c) => [c.path, c.action, c.drifted])).toEqual([
      ["kept.ts", "modified", false],
      ["added.ts", "created", false],
    ]);
    writeFileSync(join(root, "added.ts"), "edited by user\n");
    expect(readWorkflowView(service, runId).changes.find((c) => c.path === "added.ts")?.drifted).toBe(true);
    const tracked = await readRunFileDiff(service.store, runId, "kept.ts");
    expect(tracked.kind).toBe("git");
    expect(tracked.text).toContain("+export const a = 2;");
    expect(tracked.text).toContain("-export const a = 1;");
    expect((await readRunFileDiff(service.store, runId, "added.ts")).text).toContain("+edited by user");
    await expect(readRunFileDiff(service.store, runId, "package.json")).rejects.toThrow("did not change");
  });
  test("without Git the diff explains why content is unavailable", async () => {
    const { service, runId, edit } = await setupRun(false);
    edit("kept.ts", hashBytes("export const a = 1;\n"), "x\n");
    const diff = await readRunFileDiff(service.store, runId, "kept.ts");
    expect(diff.kind).toBe("unavailable");
    expect(diff.text).toContain("Git repository");
  });
  test("check details keep the latest result per check with the failing output tail", async () => {
    const { service, runId } = await setupRun(false);
    const snapshot = service.store.putSnapshot(runId, {});
    const record = (status: "passed" | "failed", output: string) =>
      service.store.transaction(() => {
        const artifact = service.store.artifact(runId, "check", `checks/tests/${newId()}.json`, JSON.stringify({ output }));
        const evidence = service.store.addEvidence(runId, "command", snapshot.id, artifact.id);
        service.store.checkResult(runId, "tests", evidence, status, status === "passed" ? 0 : 1, "exit", 1200);
      });
    record("passed", "ok");
    record("failed", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
    const [detail] = readWorkflowView(service, runId).checkDetails;
    expect(detail).toMatchObject({ checkId: "tests", status: "failed", exitCode: 1, runs: 2 });
    expect(detail?.outputTail?.split("\n")).toHaveLength(40);
    expect(detail?.outputTail).toEndWith("line 59");
  });
  test("store reports appended events to an observer", async () => {
    const { service, runId } = await setupRun(false);
    const seen: string[] = [];
    service.store.onEvent = (event) => seen.push(event.type);
    service.store.transaction(() => service.store.transition(runId, "paused"));
    expect(seen).toContain("run.state_changed");
  });
});

describe("clarification questions", () => {
  test("analysis findings become readable questions with blocking flags and references", async () => {
    const { clarificationItems, clarificationAnswers } = await import("../src/components/workflow/DecisionPrompt.js");
    const items = clarificationItems({
      findings: [
        { id: "write-conflict", kind: "inconsistency", blocking: true, description: "T002 and T003 both modify one file.", refs: ["task graph T002.writes"] },
        { id: "build-gate", kind: "ambiguity", blocking: false, description: "Build is not in the policy.", refs: ["spec SC-001"] },
      ],
    });
    expect(items.map((i) => [i.key, i.label, i.blocking])).toEqual([
      ["write-conflict", "inconsistency", true],
      ["build-gate", "ambiguity", false],
    ]);
    expect(items[0]?.text).toBe("T002 and T003 both modify one file.");
    expect(clarificationAnswers(items, ["Add a dependency", " "])).toEqual({
      "write-conflict: T002 and T003 both modify one file.": "Add a dependency",
    });
    expect(clarificationItems({ questions: [{ question: "Which store?", blocking: true }] })[0]).toMatchObject({ key: "Q1", text: "Which store?", blocking: true });
  });
});
