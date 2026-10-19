import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

import { ASSERTION_FAILURES } from "./helpers/assertion-failures.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Failure ownership", problem: "A change needs tests", outcome: "Required behavior is checked", inScope: ["Implement and test the change"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The change works", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "valid input", when: "the program runs", then: "the required result is returned", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nCode and tests.\n## Decisions\nDEC-001: FR-001 needs a source and tests.\n## Components\nSource and tests\n## Data\nText\n## Verification\nRequired checks\n## Risks\nStale tests and source defects";
const task = (id: string, paths: string[], dependsOn: string[] = [], checkIds: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" })), readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });
const graphOf = (tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks });
const check = (id: string, script: string, scope: Check["scope"]): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope, envNames: [], writes: [] });

const tasks = [task("T001", ["src/differ.ts"]), ...[2, 3, 4, 5].map((n) =>
  task(`T00${n}`, [`tests/${n === 2 ? "differ" : `command${n}`}.test.ts`], ["T001"], ["tests-written"]))];
const graph = graphOf(tasks);

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  correctionWrites: string[][] = [];
  service?: NativeWorkflowService;
  waitsAtRepair: Record<string, string[]>[] = [];
  constructor(private root: string, private graph = graph) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A differ and caller tests", facts: [], unknowns: [], constraints: [], suggestedScope: this.graph.tasks.flatMap((t) => t.writes.map((w) => w.path)) }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: this.graph }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const own = request.task as Task;
        this.attempts.push(own.id);
        const root = request.root ?? this.root;
        if (own.origin !== "planned") {
          this.correctionWrites.push(own.writes.map((w) => w.path).sort());
          this.waitsAtRepair.push(this.service?.store.state(request.runId).waitingFor ?? {});
        }
        const path = own.origin !== "planned" ? "src/differ.ts" : own.writes[0]!.path;
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), path === "src/differ.ts"
          ? `export const diff = () => ${own.origin === "planned" ? '["changed", "removed"]' : '["removed", "changed"]'};\n`
          : own.writes[0]?.action === "modify" ? readFileSync(join(root, path), "utf8") + `test("${own.id} caller", () => expect(diff()).toEqual(["removed", "changed"]));\n`
          : 'import { test, expect } from "bun:test";\nconst modulePath = "../src/differ.ts";\nconst { diff } = await import(modulePath);\ntest("orders results", () => expect(diff()).toEqual(["removed", "changed"]));\n');
        output = { schemaVersion: 1, taskId: own.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: repair before downstream caller tests (#1612)", () => {
  for (const { writers, shared } of [{ writers: 1, shared: false }, { writers: 2, shared: false }, { writers: 1, shared: true }]) for (const [stack, failure] of Object.entries(ASSERTION_FAILURES)) {
    if (shared && stack !== "bun") continue;
    test(`${stack} repairs before later tests, writers=${writers}, shared file=${shared}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-repair-priority-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    if (writers > 1) {
      for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test User"], ["config", "user.email", "test@example.test"], ["config", "commit.gpgsign", "false"]]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      }
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests/.gitkeep"), "");
      writeFileSync(join(root, ".gitignore"), ".baked/\n");
      for (const args of [["add", "."], ["commit", "-q", "-m", "Initial"]]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      }
    }
    const scenarioTasks = shared ? tasks.map((t, i) => i > 1 ? { ...t, dependsOn: [tasks[i - 1]!.id], writes: [{ path: "tests/differ.test.ts", action: "modify" as const }] } : t) : tasks;
    const failures = scenarioTasks.slice(1).map((t, index) => ({ path: t.writes[0]!.path, output: failure(index ? `Command${index}` : "Differ") + (index ? "" : "\n    at diff (/work/src/differ.ts:1:1)") }));
    // The command executes the real implementation, then prints each toolchain's deterministic
    // assertion shape. No installed Python, Maven, Go or Rust compiler is required.
    const script = `if (await Bun.file('src/differ.ts').exists()) { const { diff } = await import('./src/differ.ts'); if (JSON.stringify(diff()) !== '["removed","changed"]') { let failed = false; for (const f of ${JSON.stringify(failures)}) if (await Bun.file(f.path).exists()) { console.log(f.output); failed = true; } if (failed) process.exit(1); } }`;
    const policy: RunPolicy = { ...defaultWorkflowPolicy, maxConcurrentWriters: writers, checks: [check("tests-written", script, "task"), check("tests", script, "feature")] };
    const executor = new ScriptedExecutor(root, graphOf(scenarioTasks));
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } }, executor);
    executor.service = service;
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Return removed rows before changed rows and test callers", ownerLabel: "test", policy, ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}) });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval: ${waiting.status} ${waiting.reason} ${service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => service.store.readArtifact(run.runId, a.id)).join("\n")}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") throw new Error(JSON.stringify({ done, attempts: executor.attempts, errors: service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => service.store.readArtifact(run.runId, a.id)) }));
    expect(done.status).toBe("completed");
    if (writers === 1) expect(executor.attempts).toEqual(["T001", "T002", "T006", "T003", "T004", "T005"]);
    else {
      expect(executor.attempts.filter((id) => id === "T003")).toHaveLength(1);
      expect(executor.waitsAtRepair[0]?.T003).toContain("T006");
      expect(service.store.state(run.runId).taskContinuations.T003).toBeUndefined();
      expect(executor.attempts.indexOf("T006")).toBeLessThan(executor.attempts.indexOf("T004"));
    }
    expect(executor.correctionWrites).toEqual([shared ? ["src/differ.ts"] : ["src/differ.ts", "tests/differ.test.ts"]]);
    for (const id of (writers === 1 ? ["T003", "T004", "T005"] : ["T004", "T005"])) expect(service.store.taskCheckRuns(run.runId, id).filter((c) => c.status === "failed")).toEqual([]);
    expect(service.store.run(run.runId).corrective_tasks).toBe(1);
    expect(readFileSync(join(root, service.store.state(run.runId).worktree?.path ?? "", "src/differ.ts"), "utf8")).toContain('["removed", "changed"]');
  }, 60000);
  }
});
