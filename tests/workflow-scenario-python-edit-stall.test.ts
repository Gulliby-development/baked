import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWithCwd } from "../src/core/cwd.js";
import { getIntelligenceClient, setIntelligenceClient } from "../src/core/intelligence/instance.js";
import { editFileTool } from "../src/core/tools/edit-file.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { withToolPhases } from "../src/core/tools/tool-phase.js";
import type { IntelligenceClient } from "../src/core/workers/intelligence-client.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { ProfileSchema } from "../src/core/workflows/schemas.js";
import { ToolDeadlineError, withDeadline } from "../src/core/workflows/stall.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { runUsageMarkdown } from "../src/core/workflows/usage-markdown.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("scenario: an empty Python multi_edit match returns without blocking the driver (#1616)", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const file = join(fixture.root, "test_expenses.py");
  const original = "assert total() == 1\n";
  writeFileSync(file, original);
  // Isolate the synchronous infinite loop on main so the regression stops at the child's timeout.
  // A cold Bun start on a Windows runner took over 5 s, so the limit leaves room for it.
  const result = spawnSync(process.execPath, [join(import.meta.dir, "helpers/python-empty-multi-edit.ts"), file], { timeout: 20000, encoding: "utf8", windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ success: false, error: "empty oldString (0 edits applied)" });
  expect(readFileSync(file, "utf8")).toBe(original);
});

/** Completed model steps survive a driver disappearing before its final response. */
class ScriptedExecutor extends FixtureExecutor {
  crashNext = true;
  store!: WorkflowStore;
  override async execute(request: ExecutionRequest) {
    if (this.crashNext) {
      this.crashNext = false;
      this.store.recordAttemptUsage(request.runId, request.attemptId, 1800);
      this.store.recordAttemptUsage(request.runId, request.attemptId, 4200);
      throw new Error("scripted driver stopped inside multi_edit");
    }
    return super.execute(request);
  }
}

test("scenario: supervisor takeover keeps completed-step tokens in budgets and reports (#1616)", async () => {
  const fixture = workflowFixture({ executor: (root) => new ScriptedExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const { store } = service;
  executor.store = store;
  const { runId } = await fixture.start();
  store.transition(runId, "running");
  const profile = ProfileSchema.array().parse(JSON.parse(store.run(runId).profiles_json))[0]!;
  const stepId = store.beginStep(runId, "task-T005");
  const attemptId = store.reserve(runId, stepId, profile.model, 9000, fixturePolicy);
  await expect(executor.execute({ runId, attemptId, profile, prompt: "Edit Python tests", signal: new AbortController().signal })).rejects.toThrow("scripted driver stopped");
  expect(await service.takeOverStalledDriver(runId, { pid: process.pid, owner: "stopped-driver" })).toBe(true);
  await service.drive(runId, new AbortController().signal);
  expect(store.attempts(runId).find((a) => a.id === attemptId)).toMatchObject({ status: "interrupted", used_tokens: 4200, usage_complete: 1 });
  expect(store.events(runId, 0, 10000).find((e) => e.type === "attempt.finished" && (e.payload as { attemptId: string }).attemptId === attemptId)?.payload).toMatchObject({ usedTokens: 4200, usageComplete: false, usageEstimated: true });
  const total = 4200 + executor.calls.length * 50;
  expect(store.run(runId).token_usage).toBe(total);
  expect(store.remainingTokens(runId, fixturePolicy)).toBe(fixturePolicy.maxTotalTokens - total);
  const usage = runUsage(store, runId);
  expect(usage.totalTokens).toBe(total);
  expect(usage.attempts.find((a) => a.attemptId === attemptId)?.usageEstimated).toBe(true);
  expect(runReport(store, runId)).toContain("Tokens of interrupted attempts: 4,200 included as an estimate");
  expect(runUsageMarkdown(usage)).toContain("Tokens of interrupted attempts: 4,200 included as an estimate");
  // Repeated recovery must neither charge the old attempt again nor hold its old reservation.
  await service.drive(runId, new AbortController().signal);
  expect(store.run(runId).token_usage).toBe(4200 + executor.calls.length * 50);
}, 60000);

for (const tool of [editFileTool, multiEditTool]) {
  test(`scenario: ${tool.name} journals Python pre-write phases (#1616)`, async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const file = join(fixture.root, "test_expenses.py");
    writeFileSync(file, "def test_total():\n\tassert total() == 1\n");
    const phases: string[] = [];
    const edit = { oldString: "  assert total() == 1", newString: "  assert total() == 2" };
    const result = await withToolPhases((phase) => phases.push(phase), () =>
      tool.name === "multi_edit"
        ? multiEditTool.execute({ path: file, edits: [edit] })
        : editFileTool.execute({ path: file, ...edit }),
    );
    expect(result.success).toBe(true);
    expect(phases.slice(0, 5)).toEqual(["match", "analyze", "pre_diagnostics", "cas", "write"]);
    expect(readFileSync(file, "utf8")).toBe("def test_total():\n\tassert total() == 2\n");
  });

  test(`scenario: blocked ${tool.name} pre-diagnostics ends at the tool deadline without a late write (#1616)`, async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const previous = getIntelligenceClient();
    let release!: (value: []) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<[]>((resolve) => { release = resolve; });
    setIntelligenceClient({
      isReady: true,
      getFileDependents: () => { entered(); return pending; },
      routerGetDiagnostics: async () => ({ value: [], backend: "scripted-worker" }),
    } as unknown as IntelligenceClient);
    cleanups.push(() => setIntelligenceClient(previous));
    const file = join(fixture.root, "test_expenses.py");
    const original = "assert total() == 1\n";
    writeFileSync(file, original);
    const edit = { oldString: "assert total() == 1", newString: "assert total() == 2" };
    let toolPending: ReturnType<typeof multiEditTool.execute>;
    const call = runWithCwd(fixture.root, () => withDeadline(tool.name, 100, () => {
      toolPending = tool.name === "multi_edit"
        ? multiEditTool.execute({ path: file, edits: [edit] })
        : editFileTool.execute({ path: file, ...edit });
      return toolPending;
    }));
    // Attach before waiting for entry so a slow host never produces an unhandled rejection.
    const rejected = expect(call).rejects.toBeInstanceOf(ToolDeadlineError);
    await started;
    await rejected;
    release([]);
    await toolPending!;
    expect(readFileSync(file, "utf8")).toBe(original);
  });
}
