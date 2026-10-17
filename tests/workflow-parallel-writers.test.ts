import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { attemptCapFault } from "../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { migration001 } from "../src/core/workflows/migrations/001.js";
import { migration002 } from "../src/core/workflows/migrations/002.js";
import { migration003 } from "../src/core/workflows/migrations/003.js";
import { migration004 } from "../src/core/workflows/migrations/004.js";
import { migration005 } from "../src/core/workflows/migrations/005.js";
import { planBatch } from "../src/core/workflows/parallel.js";
import { type Check, PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId, WorkflowStore } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { AgentExecutor, ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function repository(root: string): string {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Project\n");
  writeFileSync(join(root, "shared.txt"), "one\ntwo\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  return git(root, "rev-parse", "HEAD");
}

/** A planned task of the fixture: what it writes and the content it gives each file. */
interface Plan {
  id: string;
  files: Record<string, string>;
  action?: "create" | "modify";
  dependsOn?: string[];
}

const MARKDOWN =
  "# Plan\n## Context\nWrite the files.\n## Decisions\nDEC-001: FR-001 needs the files.\n## Components\nFiles\n## Data\nText\n## Verification\nCheck files\n## Risks\nNone for fixture";

function taskOf(plan: Plan): Task {
  return {
    id: plan.id, title: `Write ${Object.keys(plan.files).join(", ")}`, description: "Write the files", requirementIds: ["FR-001"],
    criterionIds: ["AC-001"], dependsOn: plan.dependsOn ?? [], profileId: "implementer",
    writes: Object.keys(plan.files).map((path) => ({ path, action: plan.action ?? "create" })),
    readHints: [], checkIds: ["where"], origin: "planned", findingIds: [], rationale: "Required behavior",
  };
}

interface Started { taskId: string; root: string; start: number; end: number }

/**
 * Completes the flow with a plan of several tasks. Each implementation writes its files through
 * the workflow tool policy in the root it is handed, so its edits are journaled effects there.
 */
class ParallelExecutor implements AgentExecutor {
  service: NativeWorkflowService | undefined;
  started: Started[] = [];
  integrations: { taskId: string; integration: Record<string, unknown> }[] = [];
  /** Runs before a task's edits; a test uses it to wait, stray or lose the worker. */
  hooks: Record<string, (request: ExecutionRequest) => Promise<void> | void> = {};
  /** Content the integrator writes for each conflicting file. */
  resolution: Record<string, string> = {};
  /** What the integrator reports as unresolved (#1414). */
  integratorUnresolved: string[] = [];
  /** Tasks whose first attempt writes a partial file and stops at its token cap. */
  capped = new Set<string>();
  /** Tasks whose first attempt edits its files and is then stopped by its token cap (#935). */
  capFault = new Set<string>();
  /**
   * Attempts per task that edit a file, end exactly at their token cap with the forced finalize
   * step spent and no submit, and throw the cap fault as the executor does (#1056).
   */
  capAtLimit: Record<string, number> = {};
  /** Tasks of `capAtLimit` whose last step went past the cap before a final submit was forced (#1070). */
  capUnforced = new Set<string>();
  /**
   * Tasks whose first attempt writes a partial file, is finalized by its token cap after an edit
   * it did not check and submits a complete result (#1329).
   */
  cutOffUnchecked = new Set<string>();
  /** The failed checks each implementation was handed from a cut-off attempt (#1329). */
  cutOffChecks: { taskId: string; failed?: { id: string; output: string }[] }[] = [];
  /** Tasks whose first attempt reports its edit tool unavailable and submits no change. */
  lostTool = new Set<string>();
  /** Tasks whose first attempt ends blocked with this summary and no change. */
  blockedOnce: Record<string, { summary: string; noTools?: boolean }> = {};
  /** What each implementation was told about the session it replaces. */
  previous: { taskId: string; previousAttempt?: { summary: string; unresolved: string[] } }[] = [];
  /** Attempts per task whose worker writes a partial file and then dies without a result. */
  crashes: Record<string, number> = {};
  /** The earlier edits each implementation was handed. */
  earlier: { taskId: string; root: string; content: string | null; earlierEdits?: { paths: string[]; patch: string } }[] = [];
  constructor(private workspace: string, private plans: Plan[]) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const service = this.service;
    if (request.profile.output === "plan") {
      const taskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(MARKDOWN), tasks: this.plans.map(taskOf) };
      return { output: { schemaVersion: 1, markdown: MARKDOWN, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation" || !service)
      return new FixtureExecutor(root).execute(request);
    const task = request.task;
    if (!task) throw new Error("Implementation without a task");
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      extra: { integration?: Record<string, unknown>; earlierEdits?: { paths: string[]; patch: string }; previousAttempt?: { summary: string; unresolved: string[] }; cutOffChecks?: { failed: { id: string; output: string }[] } };
    };
    const guard = new WorkflowToolPolicy(
      service.store, service.leases, request.runId, request.attemptId, request.profile,
      PolicySchema.parse(JSON.parse(service.store.run(request.runId).policy_json)), task, root,
    );
    const write = (path: string, content: string) =>
      guard.execute("edit_file", { path }, async () => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), content);
      });
    if (data.extra.integration) {
      this.integrations.push({ taskId: task.id, integration: data.extra.integration });
      for (const w of task.writes) await write(w.path, this.resolution[w.path] ?? "");
      if (this.integratorUnresolved.length)
        return {
          output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Merged both changes", evidenceIds: [], unresolved: this.integratorUnresolved },
          inputTokens: 25,
          outputTokens: 25,
        };
    } else {
      const entry: Started = { taskId: task.id, root, start: performance.now(), end: 0 };
      this.started.push(entry);
      await this.hooks[task.id]?.(request);
      const plan = this.plans.find((p) => p.id === task.id);
      const first = Object.keys(plan?.files ?? {})[0] ?? "";
      this.earlier.push({
        taskId: task.id, root,
        content: existsSync(join(root, first)) ? readFileSync(join(root, first), "utf8") : null,
        ...(data.extra.earlierEdits ? { earlierEdits: data.extra.earlierEdits } : {}),
      });
      if ((this.crashes[task.id] ?? 0) > 0) {
        this.crashes[task.id] = (this.crashes[task.id] ?? 0) - 1;
        await write(first, "partial");
        throw new Error("worker process exited");
      }
      this.previous.push({ taskId: task.id, ...(data.extra.previousAttempt ? { previousAttempt: data.extra.previousAttempt } : {}) });
      const blocked = this.blockedOnce[task.id];
      if (blocked) {
        delete this.blockedOnce[task.id];
        if (blocked.noTools)
          service.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, JSON.stringify({ schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "no_submission", finalizedBy: null, totalTokens: 50, steps: [{ inputTokens: 25, outputTokens: 25, cacheReadTokens: null, toolCalls: 0, compactedBytes: 0 }] }));
        return {
          output: { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: blocked.summary, evidenceIds: [], unresolved: [blocked.summary] },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      if (this.lostTool.delete(task.id))
        return {
          output: { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: "The edit_file tool is not available in this session", evidenceIds: [], unresolved: ["edit_file unavailable"] },
          inputTokens: 25,
          outputTokens: 25,
        };
      if ((this.capAtLimit[task.id] ?? 0) > 0) {
        this.capAtLimit[task.id] = (this.capAtLimit[task.id] ?? 0) - 1;
        await write(first, "partial");
        service.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, JSON.stringify({ schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "tokens", finalizedBy: this.capUnforced.has(task.id) ? null : "tokens", totalTokens: 1000, steps: [] }));
        throw attemptCapFault(request.profile.id, 1000, 1000);
      }
      if (this.capFault.delete(task.id)) {
        for (const path of Object.keys(plan?.files ?? {})) {
          await write(path, "partial");
          await write(path, "partial, edited");
        }
        throw attemptCapFault(request.profile.id, 374_264, 374_264);
      }
      this.cutOffChecks.push({ taskId: task.id, ...(data.extra.cutOffChecks ? { failed: data.extra.cutOffChecks.failed } : {}) });
      if (this.cutOffUnchecked.delete(task.id)) {
        await write(first, "partial");
        const steps = [["edit_file"], ["request_check"], ["multi_edit"], ["submit_result"]].map((tools) => ({ inputTokens: 25, outputTokens: 25, cacheReadTokens: null, toolCalls: tools.length, tools, compactedBytes: 0 }));
        service.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, JSON.stringify({ schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "submitted", finalizedBy: "tokens", totalTokens: 1000, steps }));
        return {
          output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote files", evidenceIds: [], unresolved: [] },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      if (this.capped.delete(task.id)) {
        await write(first, "partial");
        service.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, JSON.stringify({ schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "submitted", finalizedBy: "tokens", totalTokens: 1000, steps: [] }));
        return {
          output: { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: "Ran out of tokens", evidenceIds: [], unresolved: [`${first} is only partly written`] },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      for (const [path, content] of Object.entries(plan?.files ?? {})) await write(path, content);
      entry.end = performance.now();
    }
    return {
      output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote files", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

/** A feature check that passes when every file has the given content. */
function contentCheck(expected: Record<string, string>): Check {
  const script = `const expected = ${JSON.stringify(expected)}; for (const [path, text] of Object.entries(expected)) if (!(await Bun.file(path).exists()) || (await Bun.file(path).text()) !== text) process.exit(1);`;
  return { id: "check", executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 20000, required: true, scope: "feature", envNames: [], writes: [] };
}
const whereCheck: Check = { id: "where", executable: "bun", args: ["-e", "console.log(process.cwd())"], cwd: ".", timeoutMs: 20000, required: true, scope: "task", envNames: [], writes: [] };

function setup(plans: Plan[], expected: Record<string, string>, options: { overlap?: boolean; policy?: Partial<RunPolicy> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "baked-parallel-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const head = repository(root);
  const policy: RunPolicy = {
    ...fixturePolicy,
    checks: [contentCheck(expected), whereCheck],
    ...(options.overlap ? { allowOverlappingWrites: true } : {}),
    ...options.policy,
  };
  const executor = new ParallelExecutor(root, plans);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const store = service.store;
  const start = (writers: number, mode: "inline" | "worktree" = "worktree") =>
    service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write the files", ownerLabel: "test", policy, executionMode: mode, maxConcurrentWriters: writers });
  const drive = (runId: string) => service.drive(runId, new AbortController().signal);
  const approve = async (runId: string) => {
    const waiting = await drive(runId);
    if (waiting.status !== "waiting") throw new Error(`Expected an approval, run is ${waiting.status}`);
    const request = store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");
    await service.decide(runId, { commandId: newId(), expectedRevision: store.run(runId).revision }, { kind: "approve", requestId: request.id, digest: request.digest });
  };
  const complete = async (runId: string) => {
    await approve(runId);
    return drive(runId);
  };
  const batches = (runId: string) =>
    store.artifacts(runId).filter((a) => a.logical_path.startsWith("tasks/batches/")).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as { tasks: string[]; deferredByOverlap: string[]; deferredByBudget: string[] });
  const tree = (runId: string) => join(root, `.baked/worktrees/${runId}/main`);
  const status = (task: string, runId: string) => store.tasks(runId).find((t) => t.id === task)?.status;
  const lastError = (runId: string) => {
    const diagnostic = store.artifacts(runId).filter((a) => a.kind === "diagnostic").at(-1);
    return diagnostic ? store.readArtifact(runId, diagnostic.id) : "";
  };
  return { root, head, executor, service, store, policy, start, drive, approve, complete, batches, tree, status, lastError };
}

/** Resolves once every named task has started, or fails after a few seconds. */
function barrier(executor: ParallelExecutor, ids: string[]): () => Promise<void> {
  return async () => {
    const deadline = Date.now() + 5000;
    while (!ids.every((id) => executor.started.some((s) => s.taskId === id))) {
      if (Date.now() > deadline) throw new Error(`Tasks ${ids.join(", ")} did not run at the same time`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
}

const overlaps = (a: Started | undefined, b: Started | undefined) =>
  !!a && !!b && a.start < b.end && b.start < a.end;

describe("workflow parallel writers", () => {
  test("two independent tasks run at the same time in their own worktrees and are integrated", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    const wait = barrier(fx.executor, ["T001", "T002"]);
    fx.executor.hooks = { T001: wait, T002: wait };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    const [first, second] = ["T001", "T002"].map((id) => fx.executor.started.find((s) => s.taskId === id));
    expect(overlaps(first, second)).toBe(true);
    expect(first?.root).toBe(join(fx.root, `.baked/worktrees/${run.runId}/T001`));
    expect(second?.root).toBe(join(fx.root, `.baked/worktrees/${run.runId}/T002`));
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"]]);
    // Integrated into the run worktree and committed on the run branch; the working copy is untouched.
    expect(readFileSync(join(fx.tree(run.runId), "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(fx.tree(run.runId), "b.txt"), "utf8")).toBe("B");
    const commit = fx.store.state(run.runId).worktree?.commit ?? "";
    expect(git(fx.root, "show", `${commit}:a.txt`)).toBe("A");
    expect(git(fx.root, "show", `${commit}:b.txt`)).toBe("B");
    expect(git(fx.root, "rev-parse", `${commit}^`)).toBe(fx.head);
    expect(git(fx.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(git(fx.root, "rev-parse", "HEAD")).toBe(fx.head);
    expect(existsSync(join(fx.root, "a.txt"))).toBe(false);
    // Each effect is bound to the root it touched: the agent edits to the task worktree, the
    // integration to the run worktree, the task checks to the task worktree.
    const intents = fx.store.effects(run.runId).map((e) => ({ kind: e.kind, ...JSON.parse(e.intent_json) }) as { kind: string; path?: string; tool?: string; checkId?: string; root?: string });
    expect(intents.find((i) => i.tool === "edit_file" && i.path === "a.txt")?.root).toBe(`.baked/worktrees/${run.runId}/T001`);
    expect(intents.find((i) => i.tool === "integrate" && i.path === "b.txt")?.root).toBe(`.baked/worktrees/${run.runId}/main`);
    // (The checks stage runs every policy check again in the run worktree.)
    expect(intents.filter((i) => i.checkId === "where").map((i) => i.root).sort()).toEqual([`.baked/worktrees/${run.runId}/T001`, `.baked/worktrees/${run.runId}/T002`, `.baked/worktrees/${run.runId}/main`]);
    // Task worktrees are gone after integration and no lease is left.
    expect(existsSync(join(fx.root, `.baked/worktrees/${run.runId}/T001`))).toBe(false);
    expect(git(fx.root, "worktree", "list")).not.toContain("/T00");
    expect(fx.store.leases()).toEqual([]);
  });

  test("a task capped after editing continues in a new worktree with its earlier edits", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.capped.add("T001");
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(fx.lastError(run.runId)).toBe("");
    expect(done.status).toBe("completed");
    const attempts = fx.executor.earlier.filter((e) => e.taskId === "T001");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.content).toBeNull();
    // The continuing attempt finds the partial file in its new worktree and is told about it.
    expect(attempts[1]?.content).toBe("partial");
    expect(attempts[1]?.earlierEdits?.paths).toEqual(["a.txt"]);
    expect(attempts[1]?.earlierEdits?.patch).toContain("+partial");
    expect(fx.store.state(run.runId).taskContinuations).toEqual({ T001: 1 });
    expect(fx.store.state(run.runId).taskCarry).toEqual({});
    expect(readFileSync(join(fx.tree(run.runId), "a.txt"), "utf8")).toBe("A");
  });

  test("a cut-off attempt whose unchecked edit fails its task check continues in its own task, not integrated (#1329)", async () => {
    // Bench R33 md-site 11b11f19: corrective T013 hit its token cap after an edit it never
    // checked, submitted a failing test, and the next corrective's worktree inherited it.
    const expected = { "a.txt": "A" };
    const fx = setup([{ id: "T001", files: expected }], expected, {
      policy: { checks: [contentCheck(expected), { ...contentCheck(expected), id: "where", scope: "task" }] },
    });
    fx.executor.cutOffUnchecked.add("T001");
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(fx.lastError(run.runId)).toBe("");
    expect(done.status).toBe("completed");
    const attempts = fx.executor.earlier.filter((e) => e.taskId === "T001");
    expect(attempts).toHaveLength(2);
    // The partial file was never integrated: the continuation gets it as its own earlier edit.
    expect(attempts[1]?.content).toBe("partial");
    expect(attempts[1]?.earlierEdits?.paths).toEqual(["a.txt"]);
    expect(fx.executor.cutOffChecks.filter((c) => c.taskId === "T001").map((c) => c.failed?.map((f) => f.id))).toEqual([undefined, ["where"]]);
    expect(fx.store.state(run.runId).taskContinuations).toEqual({ T001: 1 });
    expect((fx.store.state(run.runId).graph?.tasks ?? []).map((t) => t.id)).toEqual(["T001"]);
    expect(readFileSync(join(fx.tree(run.runId), "a.txt"), "utf8")).toBe("A");
  });

  test("an attempt that ends exactly at its token cap continues its task instead of stopping the run (#1056)", async () => {
    // Bench R20 colfit 0149cea7: the forced finalize step used the last of the cap and nothing was
    // submitted, so the run stopped with attempt_cap and the resume ran the finished siblings again.
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.capAtLimit.T001 = 1;
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    const attempts = fx.executor.earlier.filter((e) => e.taskId === "T001");
    expect(attempts).toHaveLength(2);
    // The continuing attempt starts from the capped attempt's edit.
    expect(attempts[1]?.content).toBe("partial");
    expect(fx.store.state(run.runId).taskContinuations).toEqual({ T001: 1 });
    // The sibling ran once.
    expect(fx.executor.started.filter((s) => s.taskId === "T002")).toHaveLength(1);
    expect(readFileSync(join(fx.tree(run.runId), "a.txt"), "utf8")).toBe("A");
  });

  test("an attempt whose last step passed the cap before a final submit was forced continues too (#1070)", async () => {
    // Bench R21 cfgtrace T016: a multi_edit applied, 10 steps, 426,324 tokens of a 426,324 cap and
    // no finalize step, so the attempt was not continued and the run stopped.
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }], { "a.txt": "A" });
    fx.executor.capAtLimit.T001 = 1;
    fx.executor.capUnforced.add("T001");
    const run = await fx.start(1);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.executor.earlier.filter((e) => e.taskId === "T001")).toHaveLength(2);
    expect(fx.store.state(run.runId).taskContinuations).toEqual({ T001: 1 });
  });

  test("a second capped attempt stops the run but keeps the finished sibling for the resume (#1056)", async () => {
    // T001 is capped in the first batch (it continues) and again in the second, next to T003.
    const fx = setup(
      [{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }, { id: "T003", files: { "c.txt": "C" }, dependsOn: ["T002"] }],
      { "a.txt": "A", "b.txt": "B", "c.txt": "C" },
    );
    fx.executor.capAtLimit.T001 = 2;
    const run = await fx.start(2);
    const blocked = await fx.complete(run.runId);
    expect(blocked).toMatchObject({ status: "blocked", reason: "attempt_cap" });
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"], ["T001", "T003"]]);
    // The sibling that finished next to the stopped task is integrated, not invalidated.
    expect(fx.status("T003", run.runId)).toBe("implemented");
    await fx.service.resume(run.runId, { commandId: newId(), expectedRevision: fx.store.run(run.runId).revision });
    const done = await fx.drive(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.executor.started.filter((s) => s.taskId === "T003")).toHaveLength(1);
    expect(readFileSync(join(fx.tree(run.runId), "c.txt"), "utf8")).toBe("C");
  });

  test("a plain resume after an attempt-cap stop lets the rebuilt task write its files again", async () => {
    // Bench R14/R15 (#927, #954): the stopped task is invalidated on resume and rebuilt in a fresh
    // worktree without its earlier edits, while the journal still carries them.
    const fx = setup(
      [{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "shared.txt": "one\ntwo\nthree\n" }, action: "modify" }],
      { "a.txt": "A", "shared.txt": "one\ntwo\nthree\n" },
    );
    fx.executor.capFault.add("T001");
    fx.executor.capFault.add("T002");
    const run = await fx.start(2);
    const blocked = await fx.complete(run.runId);
    expect(blocked).toMatchObject({ status: "blocked", reason: "attempt_cap" });
    await fx.service.resume(run.runId, { commandId: newId(), expectedRevision: fx.store.run(run.runId).revision });
    const done = await fx.drive(run.runId);
    expect(fx.lastError(run.runId)).not.toContain("File changed outside this attempt");
    expect(done.status).toBe("completed");
    expect(fx.store.events(run.runId).filter((e) => JSON.stringify(e).includes("File changed outside this attempt"))).toEqual([]);
    expect(readFileSync(join(fx.tree(run.runId), "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(fx.tree(run.runId), "shared.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  test("tasks that would create the same directory are serialized into batches", async () => {
    const fx = setup([{ id: "T001", files: { "lib/a.txt": "A" } }, { id: "T002", files: { "lib/b.txt": "B" } }, { id: "T003", files: { "c.txt": "C" } }], { "lib/a.txt": "A", "lib/b.txt": "B", "c.txt": "C" });
    const run = await fx.start(3);
    expect((await fx.complete(run.runId)).status).toBe("completed");
    expect(fx.batches(run.runId).map((b) => [b.tasks, b.deferredByOverlap])).toEqual([[["T001", "T003"], ["T002"]], [["T002"], []]]);
    const [a, b] = ["T001", "T002"].map((id) => fx.executor.started.find((s) => s.taskId === id));
    expect(overlaps(a, b)).toBe(false);
    expect(readFileSync(join(fx.tree(run.runId), "lib/b.txt"), "utf8")).toBe("B");
    // The pure planner: a shared path or created directory defers, unless overlap is allowed.
    const tasks = [taskOf({ id: "T001", files: { "x/a": "" } }), taskOf({ id: "T002", files: { "x/b": "" } })];
    expect(planBatch(tasks, 4, false, () => false).overlapping).toEqual(["T002"]);
    expect(planBatch(tasks, 4, false, (path) => path === "x").batch).toHaveLength(2);
    expect(planBatch(tasks, 4, true, () => false).batch).toHaveLength(2);
    expect(planBatch(tasks, 1, false, () => true).batch.map((t) => t.id)).toEqual(["T001"]);
  });

  test("a task that changes a file outside its writes is rejected and not integrated", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    // The first task in graph order strays with a journaled edit; the task after it is still integrated.
    fx.executor.hooks = {
      T001: (request) => {
        const root = request.root ?? "";
        writeFileSync(join(root, "stray.txt"), "stray");
        const effect = fx.store.prepareEffect(request.runId, request.attemptId, "file_patch", { tool: "edit_file", path: "stray.txt", root: relative(fx.root, root).replaceAll("\\", "/") }, null, hashBytes("stray"));
        fx.store.effectStatus(request.runId, effect, "applied");
      },
    };
    const run = await fx.start(2);
    const blocked = await fx.complete(run.runId);
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toBe("input_changed");
    expect(fx.lastError(run.runId)).toContain("outside its write scope: stray.txt (none -> ");
    expect(fx.status("T001", run.runId)).toBe("blocked");
    expect(fx.status("T002", run.runId)).toBe("implemented");
    expect(readFileSync(join(fx.tree(run.runId), "b.txt"), "utf8")).toBe("B");
    expect(existsSync(join(fx.tree(run.runId), "a.txt"))).toBe(false);
    expect(existsSync(join(fx.tree(run.runId), "stray.txt"))).toBe(false);
    expect(existsSync(join(fx.root, "stray.txt"))).toBe(false);
  });

  test("a sibling file a host process rewrote without a journaled edit is put back, not blamed on the task (#1188)", async () => {
    // Bench R25, bytelens T002: T001's unformatted file was rewritten in T002's worktree by an
    // unjournaled whole-unit formatter pass; the run stopped input_changed, and so did the resume.
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.hooks = {
      T002: (request) => {
        const root = request.root ?? "";
        writeFileSync(join(root, "shared.txt"), "one\ntwo\nformatted\n");
        writeFileSync(join(root, "stray.txt"), "stray");
      },
    };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(fx.lastError(run.runId)).not.toContain("outside its write scope");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(fx.tree(run.runId), "shared.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\n");
    expect(existsSync(join(fx.tree(run.runId), "stray.txt"))).toBe(false);
    const record = fx.store.artifacts(run.runId).find((a) => a.logical_path.startsWith("tasks/T002/reverted-outside-"));
    const reverted = JSON.parse(fx.store.readArtifact(run.runId, record?.id ?? "")) as { reverted: { path: string; before: string | null; after: string | null }[] };
    expect(reverted.reverted.map((r) => r.path)).toEqual(["shared.txt", "stray.txt"]);
    expect(reverted.reverted[0]?.after).toBe(hashBytes("one\ntwo\nformatted\n"));
    expect(reverted.reverted[1]?.before).toBeNull();
  });

  test("a serial task in the run worktree also gets an unjournaled sibling change put back (#1188)", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.hooks = { T002: (request) => writeFileSync(join(request.root ?? "", "shared.txt"), "reformatted\n") };
    const run = await fx.start(1);
    const done = await fx.complete(run.runId);
    expect(fx.lastError(run.runId)).not.toContain("outside its write scope");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(fx.tree(run.runId), "shared.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\n");
    expect(fx.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("tasks/T002/reverted-outside-"))).toBe(true);
  });

  test("inline, an unjournaled change outside the task's writes still stops the run and is kept (#1188)", async () => {
    // Inline the root is the user's working copy: the change may be the user's own edit.
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }], { "a.txt": "A" });
    fx.executor.hooks = { T001: (request) => writeFileSync(join(request.root ?? "", "shared.txt"), "user edit\n") };
    const run = await fx.start(1, "inline");
    const blocked = await fx.complete(run.runId);
    expect(blocked).toMatchObject({ status: "blocked", reason: "input_changed" });
    expect(fx.lastError(run.runId)).toContain("outside its write scope: shared.txt (");
    expect(readFileSync(join(fx.root, "shared.txt"), "utf8")).toBe("user edit\n");
  });

  test("losing one task's worker interrupts only that task; resume runs it again", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    const wait = barrier(fx.executor, ["T001", "T002"]);
    let lose = true;
    fx.executor.hooks = {
      T001: wait,
      T002: async (request) => {
        await wait();
        if (!lose) return;
        lose = false;
        // Another owner, since gone, took the task worktree's lease: this worker has lost it.
        const resource = `worktree:.baked/worktrees/${request.runId}/T002` as const;
        const held = fx.store.lease(resource);
        fx.store.transaction(() => fx.store.putLease({ resource, owner_id: "other-owner", owner_epoch: (held?.owner_epoch ?? 0) + 1, run_id: request.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: 2147483647 }) }));
      },
    };
    const run = await fx.start(2);
    const stopped = await fx.complete(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("owner_lost");
    expect(fx.status("T002", run.runId)).toBe("interrupted");
    expect(fx.status("T001", run.runId)).toBe("implemented");
    expect(
      fx.store
        .events(run.runId, 0, 10000)
        .some((e) => e.type === "task.state_changed" && e.payload.to === "interrupted" && e.payload.cause === "lease_lost"),
    ).toBe(true);
    expect(readFileSync(join(fx.tree(run.runId), "a.txt"), "utf8")).toBe("A");
    expect(existsSync(join(fx.tree(run.runId), "b.txt"))).toBe(false);
    // The run's own leases are released; the lease the other owner took is its own.
    expect(fx.store.leases().map((l) => l.owner_id)).toEqual(["other-owner"]);
    await fx.service.resume(run.runId, { commandId: newId(), expectedRevision: fx.store.run(run.runId).revision });
    const done = await fx.drive(run.runId);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(fx.tree(run.runId), "b.txt"), "utf8")).toBe("B");
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"], ["T002"]]);
    expect(fx.store.leases()).toEqual([]);
  });

  test("a task whose worker dies is restarted once with its edits and the run completes", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.crashes = { T002: 1 };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(fx.tree(run.runId), "b.txt"), "utf8")).toBe("B");
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"], ["T002"]]);
    // The restarted attempt starts from the run worktree with the dead worker's edit applied.
    const restarted = fx.executor.earlier.filter((e) => e.taskId === "T002").at(-1);
    expect(restarted?.content).toBe("partial");
    expect(restarted?.earlierEdits?.paths).toEqual(["b.txt"]);
    const record = fx.store.artifacts(run.runId).find((a) => a.logical_path === "tasks/restarts/T002.json");
    expect(record).toBeDefined();
    const restart = JSON.parse(fx.store.readArtifact(run.runId, record?.id ?? "")) as {
      reason: string;
      carriedPaths: string[];
      interruptedTokens: number;
      carriedTokens: number;
    };
    expect(restart.reason).toContain("worker process exited");
    expect(restart.carriedPaths).toEqual(["b.txt"]);
    // #843: what the restart reuses of the attempt it replaces.
    expect(typeof restart.interruptedTokens).toBe("number");
    expect(restart.carriedTokens).toBe(restart.interruptedTokens);
    const interrupted = fx.store
      .events(run.runId, 0, 10000)
      .flatMap((e) => (e.type === "task.state_changed" && e.payload.to === "interrupted" ? [e.payload] : []));
    expect(interrupted).toEqual([
      // #929: an error of BAKED's own code carries its stack, so its caller is known.
      // #1432: the restart carries the dead worker's edits, which counts as progress.
      expect.objectContaining({ taskId: "T002", cause: "worker_lost", detail: expect.stringContaining("worker process exited"), stack: expect.stringContaining("workflow-parallel-writers.test.ts"), carried: true }),
    ]);
    expect(fx.store.continuedAttempts(run.runId)).toBe(1);
    expect(fx.store.state(run.runId).taskRestarts).toEqual({ T002: 1 });
    expect(fx.store.leases()).toEqual([]);
  });

  test("a step that hashes a record with an undefined field does not lose the task's worker", async () => {
    // #929: canonical() threw "Cannot hash a non-JSON value" for an undefined object value, which
    // the scheduler reported as a lost worker and the attempt was discarded.
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.hooks.T002 = async () => {
      hashJson({ path: "b.txt", range: undefined });
    };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"]]);
    const interrupted = fx.store
      .events(run.runId, 0, 10000)
      .filter((e) => e.type === "task.state_changed" && e.payload.to === "interrupted");
    expect(interrupted).toEqual([]);
  });

  test("a task whose worker dies again after its restart blocks the run with owner_lost", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.crashes = { T002: 2 };
    const run = await fx.start(2);
    const stopped = await fx.complete(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("owner_lost");
    expect(fx.lastError(run.runId)).toContain("Lost the worker of T002");
    expect(fx.status("T002", run.runId)).toBe("interrupted");
    expect(fx.status("T001", run.runId)).toBe("implemented");
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"], ["T002"]]);
    // A person's resume still implements it again.
    await fx.service.resume(run.runId, { commandId: newId(), expectedRevision: fx.store.run(run.runId).revision });
    expect((await fx.drive(run.runId)).status).toBe("completed");
    expect(readFileSync(join(fx.tree(run.runId), "b.txt"), "utf8")).toBe("B");
  });

  test("a task whose session lost its edit tool is restarted once in a fresh session", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    fx.executor.lostTool.add("T002");
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(fx.lastError(run.runId)).toBe("");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(fx.tree(run.runId), "b.txt"), "utf8")).toBe("B");
    expect(fx.store.state(run.runId).taskRestarts).toEqual({ T002: 1 });
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"], ["T002"]]);
  });

  // R6: planned tasks reran in full after a correction (3.08M tokens, 17.5% of the round); the host
  // runs their task checks first and skips the agent when they pass.
  for (const mode of ["worktree", "inline"] as const) {
    test(`an invalidated planned task whose task checks pass is implemented without an agent, ${mode} run`, async () => {
      const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" }, dependsOn: ["T001"] }], { "a.txt": "A", "b.txt": "B" });
      let invalidated = false;
      fx.executor.hooks.T002 = (request) => {
        if (invalidated) return;
        invalidated = true;
        fx.store.transaction(() => fx.store.taskStatus(request.runId, "T001", "invalidated"));
      };
      const run = await fx.start(mode === "inline" ? 1 : 2, mode);
      const done = await fx.complete(run.runId);
      expect(fx.lastError(run.runId)).toBe("");
      expect(done.status).toBe("completed");
      expect(fx.executor.started.filter((s) => s.taskId === "T001")).toHaveLength(1);
      expect(fx.executor.started.filter((s) => s.taskId === "T002")).toHaveLength(1);
      expect(["implemented", "verified"]).toContain(fx.status("T001", run.runId));
      const marker = fx.store.artifacts(run.runId).find((a) => a.logical_path === "tasks/T001/host-first-1.json");
      expect(marker && JSON.parse(fx.store.readArtifact(run.runId, marker.id))).toEqual({ taskId: "T001", passed: true });
    });
  }

  for (const writers of [1, 2]) {
    test(`a blocked implementer restarts once under assume with the worker's account, ${String(writers)} writer(s)`, async () => {
      const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" }, { policy: { clarification: "assume" } });
      fx.executor.blockedOnce.T002 = { summary: "One test remains failing: the fixture lacks an over-budget category" };
      const run = await fx.start(writers);
      const done = await fx.complete(run.runId);
      expect(fx.lastError(run.runId)).toBe("");
      expect(done.status).toBe("completed");
      expect(fx.store.state(run.runId).taskRestarts).toEqual({ T002: 1 });
      expect(fx.executor.previous.filter((p) => p.taskId === "T002").map((p) => p.previousAttempt?.summary)).toEqual([undefined, "One test remains failing: the fixture lacks an over-budget category"]);
      expect(fx.store.artifacts(run.runId).some((a) => a.logical_path === "tasks/restarts/T002.json")).toBe(true);
    });
  }

  // Bench round 12, cfgtrace 4018a791: the README task ran before the CLI task, reported the
  // missing `cfgtrace.__main__` as blocked and stopped the run (#807).
  for (const writers of [1, 2]) {
    test(`a task blocked on a file a task still to run writes waits for it, ${String(writers)} writer(s)`, async () => {
      const fx = setup(
        [{ id: "T001", files: { "USAGE.md": "R" } }, { id: "T002", files: { "tool/out.txt": "C" } }],
        { "USAGE.md": "R", "tool/out.txt": "C" },
        { policy: { clarification: "ask" } },
      );
      fx.executor.blockedOnce.T001 = { summary: "Cannot capture the output: tool/out.txt is missing in this worktree" };
      const run = await fx.start(writers);
      const done = await fx.complete(run.runId);
      expect(fx.lastError(run.runId)).toBe("");
      expect(done.status).toBe("completed");
      expect(fx.store.state(run.runId).taskRestarts).toEqual({});
      const wait = fx.store.artifacts(run.runId).find((a) => a.logical_path === "tasks/waits/T001.json");
      expect(wait && JSON.parse(fx.store.readArtifact(run.runId, wait.id)).waitsFor).toEqual(["T002"]);
      const t001 = fx.executor.started.filter((s) => s.taskId === "T001");
      const t002 = fx.executor.started.find((s) => s.taskId === "T002");
      expect(t001).toHaveLength(2);
      expect(t002 && t001[1] && t001[1].start >= t002.end).toBe(true);
    });
  }

  test("a task blocked on a file no unfinished task writes still blocks the run", async () => {
    const fx = setup(
      [{ id: "T001", files: { "tool/out.txt": "C" } }, { id: "T002", files: { "USAGE.md": "R" } }],
      { "USAGE.md": "R", "tool/out.txt": "C" },
      { policy: { clarification: "ask" } },
    );
    fx.executor.blockedOnce.T002 = { summary: "Cannot capture the output: tool/out.txt is missing in this worktree" };
    const run = await fx.start(1);
    const stopped = await fx.complete(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(fx.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("tasks/waits/"))).toBe(false);
  });

  test("a session that made no tool call and submitted nothing restarts without assume, whatever its wording", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" }, { policy: { clarification: "ask" } });
    fx.executor.blockedOnce.T002 = { summary: "Could not proceed", noTools: true };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.store.state(run.runId).taskRestarts).toEqual({ T002: 1 });
  });

  test("a blocked implementer without a host fact and without assume still blocks the run", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }], { "a.txt": "A" }, { policy: { clarification: "ask" } });
    fx.executor.blockedOnce.T001 = { summary: "Cannot satisfy FR-002 as written" };
    const run = await fx.start(1);
    const stopped = await fx.complete(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(fx.store.state(run.runId).taskRestarts).toEqual({});
  });

  test("a task that reports its tool unavailable again after the restart blocks the run", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }], { "a.txt": "A" });
    const execute = fx.executor.execute.bind(fx.executor);
    fx.executor.execute = async (request) => {
      if (request.task?.id === "T001" && request.profile.output === "implementation") fx.executor.lostTool.add("T001");
      return execute(request);
    };
    const run = await fx.start(1);
    const stopped = await fx.complete(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("invalid_output");
    expect(fx.store.state(run.runId).taskRestarts).toEqual({ T001: 1 });
  });

  test("a run blocked with owner_lost resumes itself under assume, a bounded number of times", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" }, { policy: { clarification: "assume" } });
    fx.service.ownerLostBackoffMs = [0, 0, 0];
    fx.executor.crashes = { T002: 2 };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.store.state(run.runId).ownerLostResumes).toBe(1);
    expect(fx.store.artifacts(run.runId).some((a) => a.logical_path === "owner-lost/resume-1.json")).toBe(true);
  });

  test("an owner_lost run stays blocked once its automatic resumes are spent", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" }, { policy: { clarification: "assume" } });
    fx.service.ownerLostBackoffMs = [0];
    fx.executor.crashes = { T002: 5 };
    const run = await fx.start(2);
    const stopped = await fx.complete(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("owner_lost");
    expect(fx.store.state(run.runId).ownerLostResumes).toBe(1);
  });

  test("a batch shrinks to the tasks the remaining budget covers", async () => {
    const plans = [{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }];
    const expected = { "a.txt": "A", "b.txt": "B" };
    // A first run measures what one task reserves.
    const measure = setup(plans, expected);
    const measured = await measure.start(2);
    expect((await measure.complete(measured.runId)).status).toBe("completed");
    const steps = new Map(measure.store.steps(measured.runId).map((s) => [s.id, s.stage_id]));
    const perTask = Math.max(...measure.store.attempts(measured.runId).filter((a) => a.model_id && steps.get(a.step_id)?.startsWith("task-")).map((a) => a.reserved_tokens));
    expect(perTask).toBeGreaterThan(1000);

    const fx = setup(plans, expected);
    const run = await fx.start(2);
    await fx.approve(run.runId);
    // Hold all but one and a half task reservations, so only one task of the batch fits.
    const policy = PolicySchema.parse(JSON.parse(fx.store.run(run.runId).policy_json));
    const hold = fx.store.transaction(() => fx.store.beginStep(run.runId, "hold"));
    fx.store.reserve(run.runId, hold, null, fx.store.remainingTokens(run.runId, policy) - Math.floor(perTask * 1.5), policy);
    await fx.drive(run.runId);
    const batches = fx.batches(run.runId);
    expect(batches[0]).toMatchObject({ tasks: ["T001"], deferredByBudget: ["T002"] });
    expect(batches[1]?.tasks).toEqual(["T002"]);
    const [a, b] = ["T001", "T002"].map((id) => fx.executor.started.find((s) => s.taskId === id));
    expect(overlaps(a, b)).toBe(false);
  }, 90_000);

  test("an integration conflict is resolved by an integrator task; checks and review then pass", async () => {
    const fx = setup(
      [{ id: "T001", files: { "shared.txt": "ONE\ntwo\n" }, action: "modify" }, { id: "T002", files: { "shared.txt": "one\nTWO\n" }, action: "modify" }],
      { "shared.txt": "ONE\nTWO\n" },
      { overlap: true },
    );
    fx.executor.resolution = { "shared.txt": "ONE\nTWO\n" };
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.batches(run.runId).map((b) => b.tasks)).toEqual([["T001", "T002"]]);
    // The integrator worked for T002 on the conflicting file only, with both diffs, the spec and both task definitions.
    expect(fx.executor.integrations).toHaveLength(1);
    const { taskId, integration } = fx.executor.integrations[0] ?? { taskId: "", integration: {} };
    expect(taskId).toBe("T002");
    const files = integration.files as { path: string; integratedDiff: string; taskDiff: string; base: string }[];
    expect(files.map((f) => f.path)).toEqual(["shared.txt"]);
    // The run worktree is a regular checkout: with `core.autocrlf=true` (Git for Windows) its base is CRLF.
    expect(files[0]?.base?.replace(/\r\n/g, "\n")).toBe("one\ntwo\n");
    expect(files[0]?.integratedDiff).toContain("+ONE");
    expect(files[0]?.taskDiff).toContain("+TWO");
    expect((integration.spec as { featureId: string }).featureId).toBe("fixture");
    expect((integration.tasks as Task[]).map((t) => t.id)).toEqual(["T001", "T002"]);
    const record = fx.store.artifacts(run.runId).find((a) => a.logical_path === "tasks/T002/integration.json");
    expect(JSON.parse(fx.store.readArtifact(run.runId, record?.id ?? "")).conflicts).toEqual(["shared.txt"]);
    // The result passed the feature check and review on the run branch.
    expect(readFileSync(join(fx.tree(run.runId), "shared.txt"), "utf8")).toBe("ONE\nTWO\n");
    expect(git(fx.root, "show", `${fx.store.state(run.runId).worktree?.commit}:shared.txt`)).toBe("ONE\nTWO");
    expect(fx.store.checks(run.runId).filter((c) => c.check_id === "check").at(-1)?.status).toBe("passed");
    expect(Object.values(fx.store.state(run.runId).reviews).every((r) => r.verdict === "pass")).toBe(true);
    expect(readFileSync(join(fx.root, "shared.txt"), "utf8")).toBe("one\ntwo\n");
    // Without the policy's permission the same plan is refused before approval.
    const strict = setup([{ id: "T001", files: { "shared.txt": "x" }, action: "modify" }, { id: "T002", files: { "shared.txt": "y" }, action: "modify" }], { "shared.txt": "x" });
    const refused = await strict.start(2);
    expect((await strict.drive(refused.runId)).status).toBe("blocked");
    expect(strict.lastError(refused.runId)).toContain("both write shared.txt without a dependency");
  });

  // Audit of 2026-10-17 (#1414): the merged file is over its size target, which faulted the run as an unresolved conflict.
  test("an integrator that reports only a missed size target resolved the conflict", async () => {
    const fx = setup(
      [{ id: "T001", files: { "shared.txt": "ONE\ntwo\n" }, action: "modify" }, { id: "T002", files: { "shared.txt": "one\nTWO\n" }, action: "modify" }],
      { "shared.txt": "ONE\nTWO\n" },
      { overlap: true },
    );
    fx.executor.resolution = { "shared.txt": "ONE\nTWO\n" };
    fx.executor.integratorUnresolved = ["shared.txt is now 520 lines, above the ~400-line target"];
    const run = await fx.start(2);
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.executor.integrations).toHaveLength(1);
    const record = fx.store.artifacts(run.runId).find((a) => a.logical_path === "tasks/size-targets/T002.json");
    expect(fx.store.readArtifact(run.runId, record?.id ?? "")).toContain("400-line target");
  });

  test("one writer behaves as phase 1: every task in the run worktree, one at a time", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }, { id: "T002", files: { "b.txt": "B" } }], { "a.txt": "A", "b.txt": "B" });
    const run = await fx.start(1);
    expect((await fx.complete(run.runId)).status).toBe("completed");
    expect(new Set(fx.executor.started.map((s) => s.root))).toEqual(new Set([fx.tree(run.runId)]));
    const [a, b] = fx.executor.started;
    expect(overlaps(a, b)).toBe(false);
    expect(fx.batches(run.runId)).toEqual([]);
    expect(fx.store.effects(run.runId).some((e) => JSON.parse(e.intent_json).tool === "integrate")).toBe(false);
    expect(readdirNames(join(fx.root, ".baked/worktrees", run.runId))).toEqual(["main"]);
  });

  test("the writer count is part of the approval digest and needs worktree execution", async () => {
    const fx = setup([{ id: "T001", files: { "a.txt": "A" } }], { "a.txt": "A" });
    const one = await fx.start(1);
    const two = await fx.start(2);
    const policyOf = (runId: string) => JSON.parse(fx.store.run(runId).policy_json);
    expect(policyOf(one.runId).maxConcurrentWriters).toBe(1);
    expect(policyOf(two.runId).maxConcurrentWriters).toBe(2);
    // One writer keeps the policy hash a worktree run had before several writers existed.
    expect(hashJson(policyOf(one.runId))).toBe(hashJson(PolicySchema.parse({ ...fx.policy, executionMode: "worktree" })));
    expect("allowOverlappingWrites" in policyOf(one.runId)).toBe(false);
    expect(fx.store.state(one.runId).manifest.policyHash).not.toBe(fx.store.state(two.runId).manifest.policyHash);
    // Several writers or overlapping writes without a worktree are refused at start.
    const refusal = await fx.start(2, "inline").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WorkflowFault);
    expect((refusal as WorkflowFault).message).toContain("needs worktree execution");
    expect(PolicySchema.safeParse({ ...fx.policy, maxConcurrentWriters: 5 }).success).toBe(false);
    // The CLI flag.
    expect(parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--worktree", "--writers", "3"]).flags.writers).toBe("3");
    expect(() => parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--writers", "2"])).toThrow(/requires --worktree/);
    expect(() => parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--worktree", "--writers", "5"])).toThrow(/from 1 to 4/);
    expect(parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--clarification", "assume"]).flags.clarification).toBe("assume");
    expect(() => parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--clarification", "maybe"])).toThrow(/ask or assume/);
  });

  test("migration 006 keeps tasks, dependencies and findings and allows the interrupted status", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-parallel-db-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".baked"), { recursive: true });
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    db.exec("PRAGMA foreign_keys=ON;");
    for (const [index, sql] of [migration001, migration002, migration003, migration004, migration005].entries()) {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations VALUES (?,?,?)", [index + 1, hashBytes(sql), Date.now()]);
    }
    db.run("INSERT INTO features VALUES ('legacy','specs/legacy',1)");
    db.run("INSERT INTO runs (id,feature_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES ('r1','legacy','paused','{}','[]','{}','{}',?,1,1)", ["a".repeat(64)]);
    for (const id of ["T001", "T002"])
      db.run("INSERT INTO tasks (run_id,id,definition_json,definition_hash,status,updated_at) VALUES ('r1',?,'{}',?,'pending',1)", [id, "b".repeat(64)]);
    db.run("INSERT INTO task_dependencies VALUES ('r1','T002','T001')");
    db.run("INSERT INTO findings (run_id,id,fingerprint,body_json,status,repair_task_id,created_at) VALUES ('r1','f1',?,'{}','open','T002',1)", ["c".repeat(64)]);
    db.close();
    const store = new WorkflowStore(root);
    try {
      expect(store.schemaVersion()).toBe(13);
      expect(store.tasks("r1").map((t) => t.id)).toEqual(["T001", "T002"]);
      expect(store.findings("r1").map((f) => f.repair_task_id)).toEqual(["T002"]);
      store.transaction(() => store.taskStatus("r1", "T002", "interrupted"));
      expect(store.tasks("r1").find((t) => t.id === "T002")?.status).toBe("interrupted");
      const raw = store.connection;
      expect(raw.query("SELECT task_id,dependency_id FROM task_dependencies").all()).toEqual([{ task_id: "T002", dependency_id: "T001" }]);
      expect(() => raw.run("INSERT INTO task_dependencies VALUES ('r1','T009','T001')")).toThrow();
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

function readdirNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}
