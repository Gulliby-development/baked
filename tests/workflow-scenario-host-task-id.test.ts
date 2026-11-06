import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 90, windowfit 08da8647 (#2828). Task T003 wrote its rows and submitted
// its result with `taskId: "T002"`, copied from the task before it. The host rejected the finished
// attempt ("Task T003 did not complete its implementation"), blocked the run `invalid_output` and
// paid 127k tokens for the same rows again. The task id is the host's: each task step runs one
// task, so the result is bound to it and a wrong label is no reason to reject.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Rows", problem: "Rows are missing", outcome: "Rows exist", inScope: ["Write rows"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The first rows exist", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "The last rows exist", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the rows", when: "read", then: "rows 1-5 exist", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "the rows", when: "read", then: "rows 6-10 exist", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nRows.\n## Decisions\nDEC-001: FR-001 in src/first.txt, FR-002 in src/last.txt.\n## Components\nsrc/first.txt, src/last.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 1, checks: [check] };
const task = (id: string, path: string, requirement: string, criterion: string, dependsOn: string[]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: [requirement], criterionIds: [criterion], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  /** Each implementation session: the task it ran for and the id its result named. */
  sessions: { taskId: string; submitted: string }[] = [];
  constructor(
    private workspace: string,
    private tasks: Task[],
  ) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: this.tasks } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const current = request.task as Task;
        const path = current.writes[0]?.path ?? "";
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), `rows of ${current.id}\n`);
        // The second task names the first one, as windowfit's T003 named T002.
        const submitted = current.id === "T002" ? "T001" : current.id;
        this.sessions.push({ taskId: current.id, submitted });
        output = { schemaVersion: 1, taskId: submitted, outcome: "implemented", summary: `Added the rows of ${path}`, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: ["AC-001", "AC-002"].map((criterionId) => ({ criterionId, verdict: "pass", evidenceIds, explanation: "Rows exist" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(parallel: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-hosttaskid-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (parallel) {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    writeFileSync(join(root, "README.md"), "# Rows\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
  }
  // One writer runs T002 after T001; two writers run both tasks at once in their worktrees.
  const tasks = [task("T001", "src/first.txt", "FR-001", "AC-001", []), task("T002", "src/last.txt", "FR-002", "AC-002", parallel ? [] : ["T001"])];
  const executor = new ScriptedExecutor(root, tasks);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write the rows", ownerLabel: "test", policy, ...(parallel ? { executionMode: "worktree" as const, maxConcurrentWriters: 2 } : {}) });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const blocks = service.store
    .events(run.runId, 0, 10000)
    .filter((e) => e.type === "run.state_changed" && (e.payload as { to: string }).to === "blocked")
    .map((e) => (e.payload as { reason: string }).reason);
  return { done, executor, blocks };
}

describe("scenario: windowfit 08da8647, a finished task result that names another task (#2828)", () => {
  test("one writer: the task is accepted on its first session and the run does not block", async () => {
    const { done, executor, blocks } = await runScenario(false);
    expect(blocks).not.toContain("invalid_output");
    expect(done.status).toBe("completed");
    expect(executor.sessions.filter((s) => s.taskId === "T002")).toEqual([{ taskId: "T002", submitted: "T001" }]);
  });

  test("two writers in task worktrees: the batch worker's result is accepted the same way", async () => {
    const { done, executor, blocks } = await runScenario(true);
    expect(blocks).not.toContain("invalid_output");
    expect(done.status).toBe("completed");
    expect(executor.sessions.filter((s) => s.taskId === "T002")).toEqual([{ taskId: "T002", submitted: "T001" }]);
  });
});
