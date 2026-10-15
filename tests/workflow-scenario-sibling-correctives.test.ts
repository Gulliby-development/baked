import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { siblingCorrections } from "../src/core/workflows/task-graph.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 30, md-site 337d16db (#1285). Each property test task failed the shared
// `tests-written` check on a real source defect, and each failure opened a corrective. The check
// runs every test file, so the corrective of the first test task still failed on the second test
// task's file, whose own corrective had not run yet, and opened a corrective of itself (T011 to
// T013, 1.45M tokens). Such a corrective now waits for the sibling that is fixing that file.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Site", problem: "Pages are wrong", outcome: "Pages render", inScope: ["Render pages"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Pages render", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a page", when: "it is built", then: "it renders", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nTwo sources and their property tests.\n## Decisions\nDEC-001: FR-001 in both sources.\n## Components\nsrc/a.txt, src/b.txt\n## Data\nText\n## Verification\nProperty tests\n## Risks\nNone for fixture";
// One test command over every test file, as md-site's `tests-written`: a failing file is named.
const script = "const fs = require('node:fs'); let failed = false; for (const n of ['a', 'b']) { if (!fs.existsSync(`tests/${n}.test.ts`)) continue; if (fs.readFileSync(`src/${n}.txt`, 'utf8') !== 'ok') { console.log(`(fail) tests/${n}.test.ts > ${n} renders`); failed = true } } process.exit(failed ? 1 : 0)";
const check = (id: string, scope: "task" | "feature"): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope, envNames: [], writes: [] });
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check("tests-written", "task"), check("tests", "feature")] };
const planned = (id: string, paths: string[], checkIds: string[], dependsOn: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  corrections: string[] = [];
  constructor(private root: string) {}
  private write(path: string, text: string) {
    mkdirSync(join(this.root, path, ".."), { recursive: true });
    writeFileSync(join(this.root, path), text);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/a.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", ["src/a.txt", "src/b.txt"], []), planned("T002", ["tests/a.test.ts"], ["tests-written"], ["T001"]), planned("T003", ["tests/b.test.ts"], ["tests-written"], ["T001"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        if (task.id === "T001") {
          this.write("src/a.txt", "bug");
          this.write("src/b.txt", "bug");
        } else if (task.origin === "planned") this.write(task.writes[0]?.path ?? "", "property test");
        else {
          // A corrective fixes the source its test task's failure is about, as md-site's did.
          this.corrections.push(task.id);
          const of = /Task (T\d+) required check/.exec(task.description)?.[1];
          if (of === "T002") this.write("src/a.txt", "ok");
          else if (of === "T003") this.write("src/b.txt", "ok");
          else for (const n of ["a", "b"]) this.write(`src/${n}.txt`, "ok");
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

describe("scenario: md-site 337d16db, correctives of sibling test tasks (#1285)", () => {
  test("a corrective that fails only on a sibling's test file waits for it instead of opening a corrective of itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-mdsite-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Render the pages", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "src/b.txt"), "utf8")).toBe("ok");
    // One corrective per test task's failure, and none of a corrective.
    expect(executor.corrections).toHaveLength(2);
    expect(service.store.run(run.runId).corrective_tasks).toBe(2);
  }, 60000);
});

describe("siblingCorrections", () => {
  const fix = (id: string, findingId: string): Task => ({ ...planned(id, ["src/a.txt", "src/b.txt"], ["tests-written"]), origin: "repair", findingIds: [findingId] });
  const tasks = [planned("T001", ["src/a.txt", "src/b.txt"], []), planned("T002", ["tests/a.test.ts"], ["tests-written"]), planned("T003", ["tests/b.test.ts"], ["tests-written"]), fix("T004", "F1"), fix("T005", "F2")];
  const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks };
  const predecessors = { F1: "T002", F2: "T003" };
  const rows = (t005: string) => [{ id: "T004", status: "running" }, { id: "T005", status: t005 }] as unknown as TaskRow[];
  const t004 = tasks[3] as Task;
  test("waits for the corrective fixing the failing test file", () => {
    expect(siblingCorrections(graph, rows("pending"), t004, "(fail) tests/b.test.ts > b renders", predecessors)).toEqual(["T005"]);
  });
  test("a failure in its own test file, an unclaimed file or a planned task is not deferred", () => {
    expect(siblingCorrections(graph, rows("pending"), t004, "(fail) tests/a.test.ts > a\n(fail) tests/b.test.ts > b", predecessors)).toEqual([]);
    expect(siblingCorrections(graph, rows("pending"), t004, "AssertionError: expected ok", predecessors)).toEqual([]);
    expect(siblingCorrections(graph, rows("pending"), tasks[1] as Task, "(fail) tests/b.test.ts > b", predecessors)).toEqual([]);
  });
  test("a sibling that already finished its attempt is not waited for, so two never wait for each other", () => {
    expect(siblingCorrections(graph, rows("implemented"), t004, "(fail) tests/b.test.ts > b renders", predecessors)).toEqual([]);
  });
});
