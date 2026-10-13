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
import { testUpdateOwners } from "../src/core/workflows/task-graph.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 14, mdtoc-update 881294de (#931). The brief names the existing tests a
// new `--print` option breaks. The plan: T001 changes src/cli.ts, T002 the README, T003 updates the
// expectations in tests/cli.test.ts (after T001). T001's task check failed on tests/cli.test.ts
// and became a corrective task that rewrote T003's tests (183k, 5 attempts) before T003 ran.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Print option", problem: "No --print", outcome: "--print exists", inScope: ["Add --print"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "parseArgs returns print", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the CLI", when: "parseArgs runs", then: "it returns print", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nAdd --print.\n## Decisions\nDEC-001: FR-001 needs parseArgs to return print.\n## Components\nsrc/cli.ts, tests/cli.test.ts\n## Data\nOptions\n## Verification\nTests\n## Risks\nExisting expectations change";
// The existing tests: they expect `print: false` once the source returns it.
const tests: Check = {
  id: "tests",
  executable: "bun",
  args: ["-e", "const s = await Bun.file('src/cli.ts').text(); const t = await Bun.file('tests/cli.test.ts').text(); if (s.includes('print') && !t.includes('print: false')) { console.log('tests/cli.test.ts:\\n(fail) parseArgs > defaults: expected { print: false }'); process.exit(1) }"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [tests] };
const planned = (id: string, path: string, dependsOn: string[] = [], checkIds = ["tests"]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "modify" }], readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });
const plan = [planned("T001", "src/cli.ts"), planned("T002", "README.md", [], []), planned("T003", "tests/cli.test.ts", ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A CLI", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: plan } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        const path = task?.writes[0]?.path ?? "";
        const content: Record<string, string> = {
          "src/cli.ts": "export const parseArgs = () => ({ print: false });\n",
          "README.md": "# mdtoc\n\n`--print` prints the table of contents.\n",
          "tests/cli.test.ts": "expect(parseArgs([])).toEqual({ print: false });\n",
        };
        writeFileSync(join(this.root, path), content[path] ?? "fixed\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: `Wrote ${path}`, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: mdtoc-update 881294de, a planned test update after the source change (#931)", () => {
  test("the source task's check failing only on those tests waits for the task that updates them", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-mdtoc-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "src/cli.ts"), "export const parseArgs = () => ({});\n");
    writeFileSync(join(root, "tests/cli.test.ts"), "expect(parseArgs([])).toEqual({});\n");
    writeFileSync(join(root, "README.md"), "# mdtoc\n");
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Add --print; update the three parseArgs expectations", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "tests/cli.test.ts"), "utf8")).toContain("print: false");
    // No corrective task rewrote T003's tests: T001's failure was handed to T003.
    expect(service.store.run(run.runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    const handoff = service.store.latestArtifact(run.runId, "tasks/handoffs/T001.json");
    if (!handoff) throw new Error("No handoff artifact");
    expect(JSON.parse(service.store.readArtifact(run.runId, handoff.id))).toMatchObject({ taskId: "T001", checkId: "tests", owners: ["T003"] });
  }, 60000);
});

describe("testUpdateOwners", () => {
  const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: plan };
  const [source, readme, update] = plan as [Task, Task, Task];
  const row = (t: Task, status: string) => ({ id: t.id, status, generation: 0, snapshot_id: "s", definition_json: JSON.stringify(t) }) as never;
  const failing = "tests/cli.test.ts:\n(fail) parseArgs > defaults";
  const rows = (status: string) => [row(source, "implemented"), row(readme, "pending"), row(update, status)];
  test("names the unfinished task that writes the failing tests, even when it depends on the task", () => {
    expect(testUpdateOwners(graph, rows("pending"), {}, source, failing)).toEqual(["T003"]);
  });
  test("is the task's own failure once that task is done, or when the output names other files", () => {
    expect(testUpdateOwners(graph, rows("verified"), {}, source, failing)).toEqual([]);
    expect(testUpdateOwners(graph, rows("pending"), {}, source, `${failing}\nsrc/cli.ts(1,1): error`)).toEqual([]);
    expect(testUpdateOwners(graph, rows("pending"), {}, source, `${failing}\nREADME.md: bad`)).toEqual([]);
    expect(testUpdateOwners(graph, rows("pending"), {}, source, "1 test failed")).toEqual([]);
  });
  test("is not used for a corrective task", () => {
    expect(testUpdateOwners(graph, rows("pending"), {}, { ...source, origin: "repair" }, failing)).toEqual([]);
  });
});
