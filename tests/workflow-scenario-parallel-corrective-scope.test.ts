import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 33, url-shortener b69757cd (#1285). One defect in src/storage.ts (a
// named parameter without its prefix) failed the `tests-written` check of two parallel test tasks,
// T003 and T004. Each failure opened a corrective, T006 and T007, and both ran in task worktrees,
// where the narrow first attempt of the single-writer path was not applied: each could write the
// whole union of six files (634k tokens, 32 percent of the run). Now the second test task waits for
// the corrective the first one opened, and that corrective's first attempt writes only the failing
// test and the sources it imports, in its worktree too.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Shortener", problem: "No links", outcome: "Links are stored", inScope: ["Store links"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Links are stored", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a link", when: "it is shortened", then: "it is stored", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nStorage, codes and two test files.\n## Decisions\nDEC-001: FR-001 in storage.\n## Components\nsrc/storage.ts, src/code.ts, src/server.ts\n## Data\nSQLite\n## Verification\nTests\n## Risks\nNone for fixture";
// The test command runs every test file present, as url-shortener's `tests-written`.
const script = "const fs = require('node:fs'); let failed = false; for (const n of ['storage', 'api']) { const file = `tests/${n}.test.ts`; if (fs.existsSync(file) && fs.readFileSync('src/storage.ts', 'utf8').includes('bug')) { console.log(`(fail) ${file} > insertLink: Missing parameter \"code\"`); failed = true } } process.exit(failed ? 1 : 0)";
const check = (id: string, scope: "task" | "feature"): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope, envNames: [], writes: [] });
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check("tests-written", "task"), check("tests", "feature")] };
const planned = (id: string, paths: string[], checkIds: string[], dependsOn: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  /** The writes of each corrective attempt, in order. */
  corrections: { taskId: string; writes: string[] }[] = [];
  /** Corrective attempts that end blocked without a change, to check the widening. */
  blockFirst = false;
  constructor(private workspace: string) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/storage.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [
          planned("T001", ["src/storage.ts", "src/code.ts", "src/server.ts"], []),
          planned("T002", ["tests/storage.test.ts"], ["tests-written"], ["T001"]),
          planned("T003", ["tests/api.test.ts"], ["tests-written"], ["T001"]),
        ] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        if (task.id === "T001") {
          write("src/storage.ts", "export const insertLink = (code: string) => code; // bug\n");
          write("src/code.ts", "export const code = () => 'abc';\n");
          write("src/server.ts", 'import { insertLink } from "./storage";\nexport const serve = () => insertLink("x");\n');
        } else if (task.id === "T002") write("tests/storage.test.ts", 'import { insertLink } from "../src/storage";\ninsertLink("a");\n');
        else if (task.id === "T003") write("tests/api.test.ts", 'import { insertLink } from "../src/storage";\nimport { serve } from "../src/server";\nserve();\ninsertLink("b");\n');
        else {
          this.corrections.push({ taskId: task.id, writes: task.writes.map((w) => w.path).sort() });
          if (this.blockFirst && this.corrections.length === 1) {
            output = { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: "The fix needs src/code.ts", evidenceIds: [], unresolved: ["src/code.ts"] };
            break;
          }
          write("src/storage.ts", "export const insertLink = (code: string) => `$${code}`;\n");
        }
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(blockFirst: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-shortener-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Shortener\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  const executor = new ScriptedExecutor(root);
  executor.blockFirst = blockFirst;
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Shorten links", ownerLabel: "test", policy, executionMode: "worktree", maxConcurrentWriters: 2 });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { service, executor, done, runId: run.runId };
}

describe("scenario: url-shortener b69757cd, one defect failing two parallel test tasks (#1285)", () => {
  test("one corrective fixes it, and its first attempt in a worktree writes only where the failure points", async () => {
    const { service, executor, done, runId } = await runScenario(false);
    expect(done.status).toBe("completed");
    const worktree = service.store.state(runId).worktree?.path ?? "";
    expect(readFileSync(join(service.store.workspace, worktree, "src/storage.ts"), "utf8")).not.toContain("bug");
    // One corrective for the defect: the other test task's check ran again after it and passed.
    expect(executor.corrections.map((c) => c.taskId)).toHaveLength(1);
    const repairs = (service.store.state(runId).graph?.tasks ?? []).filter((t) => t.origin !== "planned");
    expect(repairs).toHaveLength(1);
    // The failing test and the source it imports; not src/code.ts or src/server.ts.
    expect(executor.corrections[0]?.writes).toHaveLength(2);
    expect(executor.corrections[0]?.writes).toContain("src/storage.ts");
    expect(executor.corrections[0]?.writes.some((path) => path.startsWith("tests/"))).toBe(true);
    expect(runReport(service.store, runId)).toMatch(/\| 2 of \d+ first \|/);
  }, 60000);

  test("a narrowed corrective that ends blocked in its worktree runs again with its whole scope", async () => {
    const { executor, done } = await runScenario(true);
    expect(done.status).toBe("completed");
    expect(executor.corrections).toHaveLength(2);
    expect(executor.corrections[0]?.writes).toHaveLength(2);
    expect(executor.corrections[1]?.writes.length).toBeGreaterThan(2);
    expect(executor.corrections[1]?.writes).toContain("src/code.ts");
  }, 60000);
});
