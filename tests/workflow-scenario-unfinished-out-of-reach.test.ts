import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { outOfReach, outsidePaths } from "../src/core/workflows/out-of-reach.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Smoke caesar (Java/Maven) 2026-11-11, run 886d9832, #3021. The planner told the README task to
// write "a one-line sample file in a scratch directory outside the repository" and run the CLI on
// it. `edit_file` takes only workspace paths and `run_probe` runs only mvn and java, so the worker
// wrote README.md, `maven-verify` passed, and T002 ended `blocked` on that step at every resume:
// a carried restart, a host resume and a manual one, 527k tokens. node-npm-wordfreq 11-07 (run
// 8d80efd3) ended the same way: T001 blocked with its checks green, its only unresolved item the
// later test task's file.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Caesar", problem: "No cipher", outcome: "A cipher", inScope: ["Create the cipher"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Shifts letters", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a text", when: "it is shifted by 3", then: "each letter moves 3 on", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA cipher, its README and its tests.\n## Decisions\nDEC-001: FR-001 is tested last.\n## Components\nsrc/main/java/caesar/Main.java, README.md, src/test/java/caesar/MainTest.java\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// `mvn verify` stand-in: it passes on whatever the tasks wrote.
const verify: Check = { id: "maven-verify", executable: "bun", args: ["-e", "console.log('Tests run: 22, Failures: 0')"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [verify] };
const MAIN = "src/main/java/caesar/Main.java";
const TEST = "src/test/java/caesar/MainTest.java";
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["maven-verify"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const TASKS = [planned("T001", MAIN), planned("T002", "README.md", ["T001"]), planned("T003", TEST, ["T002"])];

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(
    private root: string,
    private blocked: Record<string, string[]>,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: TASKS } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        const id = task?.id ?? "";
        this.implemented.push(id);
        for (const write of task?.writes ?? []) {
          mkdirSync(dirname(join(this.root, write.path)), { recursive: true });
          writeFileSync(join(this.root, write.path), `// ${id} attempt ${this.implemented.length}\n`);
        }
        const unresolved = this.blocked[id] ?? [];
        output = { schemaVersion: 1, taskId: id, outcome: unresolved.length ? "blocked" : "implemented", summary: `Wrote ${task?.writes[0]?.path}`, evidenceIds: [], unresolved };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(blocked: Record<string, string[]>) {
  const root = mkdtempSync(join(tmpdir(), "baked-caesar-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, blocked);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create the caesar CLI with a README and tests", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { service, runId: run.runId, done, executor };
}

const outOfReachRecord = (service: NativeWorkflowService, runId: string, taskId: string) => {
  const artifact = service.store.latestArtifact(runId, `tasks/${taskId}/out-of-reach.json`);
  return artifact ? JSON.parse(service.store.readArtifact(runId, artifact.id)) : null;
};

const SCRATCH = "Write a one-line sample file /tmp/claude-1000/scratchpad/sample.txt and run `java -cp target/classes caesar.Main --shift 3` on it: the probe exited 2 with error: cannot read /tmp/claude-1000/scratchpad/sample.txt";

describe("scenario: smoke caesar, a README step that needs a file outside the repository (#3021)", () => {
  test("the README task's only unresolved step is out of reach: the host finishes it and the run completes", async () => {
    const { service, runId, done, executor } = await runScenario({ T002: [SCRATCH] });
    // On main: T002 ended blocked at every attempt and the run stopped `blocked:invalid_output`.
    expect(done.status).toBe("completed");
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    expect(outOfReachRecord(service, runId, "T002")).toMatchObject({
      taskId: "T002",
      outcome: "blocked",
      items: [{ item: SCRATCH, reason: "outside_workspace", paths: ["/tmp/claude-1000/scratchpad/sample.txt"] }],
      checks: ["maven-verify"],
    });
  });

  test("node-npm-wordfreq: a task whose only unresolved item is a later task's file is finished too", async () => {
    const item = `${TEST} does not exist yet, so the --shift edge cases are untested`;
    const { service, runId, done, executor } = await runScenario({ T001: [item] });
    expect(done.status).toBe("completed");
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    expect(outOfReachRecord(service, runId, "T001")).toMatchObject({ items: [{ reason: "later_task", tasks: ["T003"], paths: [TEST] }] });
  });

  test("a gap in the task's own scope still stops the run", async () => {
    const { service, runId, done } = await runScenario({ T002: ["The README does not document the --decode flag yet"] });
    expect(done.status).not.toBe("completed");
    expect(outOfReachRecord(service, runId, "T002")).toBeNull();
  });
});

describe("outOfReach (#3021)", () => {
  const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "", planHash: "", tasks: TASKS };
  const rows = (status: Record<string, string>) => TASKS.map((t) => ({ id: t.id, status: status[t.id] ?? "pending" }) as TaskRow);
  const [main, readme] = [TASKS[0] as Task, TASKS[1] as Task];
  const root = "/home/u/caesar";

  test("an outside path, the words, a later task's file, and an in-scope gap", () => {
    expect(outOfReach([SCRATCH], root, graph, rows({}), readme)?.[0]?.reason).toBe("outside_workspace");
    expect(outOfReach(["Run the example in a scratch directory outside the repository"], root, graph, rows({}), readme)?.[0]).toMatchObject({ reason: "outside_workspace", paths: [] });
    expect(outOfReach([`${TEST} is not written yet`], root, graph, rows({}), main)?.[0]).toMatchObject({ reason: "later_task", tasks: ["T003"] });
    // One in-scope item among them keeps the task unfinished.
    expect(outOfReach([SCRATCH, "README.md lacks the --decode section"], root, graph, rows({}), readme)).toBeNull();
    expect(outOfReach([], root, graph, rows({}), readme)).toBeNull();
  });

  test("a file of an earlier task, or of a later task already done, is not out of reach", () => {
    expect(outOfReach([`${MAIN} lacks --decode`], root, graph, rows({ T001: "implemented" }), readme)).toBeNull();
    expect(outOfReach([`${TEST} is not written yet`], root, graph, rows({ T003: "implemented" }), main)).toBeNull();
  });

  test("outsidePaths: a machine path outside the workspace, not a route or the workspace's own path", () => {
    expect(outsidePaths("cannot read /tmp/x/sample.txt.", root)).toEqual(["/tmp/x/sample.txt"]);
    expect(outsidePaths("GET /api/users returns 500", root)).toEqual([]);
    expect(outsidePaths("see /home/u/caesar/README.md", root)).toEqual([]);
    expect(outsidePaths("write C:\\Users\\me\\AppData\\Local\\Temp\\s.txt", root)).toEqual(["C:\\Users\\me\\AppData\\Local\\Temp\\s.txt"]);
    expect(outsidePaths("the sample at ../sample.txt", root)).toEqual(["../sample.txt"]);
    expect(outsidePaths(`${MAIN} lacks --decode`, root)).toEqual([]);
  });
});
