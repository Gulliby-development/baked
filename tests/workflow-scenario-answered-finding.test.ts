import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 31, pgnvet 3f03497b (#1297). The brief keeps the tests hermetic, but a
// built-in rule had the planner add a test that starts the program to feed it raw stdin bytes.
// The analysis raised the conflict, the person answered "no test starts a process", and the
// planner kept the task: the same finding came back and the person was asked again, four times
// in the run (about 1.2M tokens). An answered finding that is raised again now goes back to the
// planner once with the answer as binding before the person is asked again.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "pgnvet", problem: "No PGN checker", outcome: "A checker with hermetic tests", inScope: ["Checker"], outOfScope: ["Tests that start a process"], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "Invalid UTF-8 on stdin is rejected", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "invalid UTF-8 on stdin", when: "the checker runs", then: "it exits 2", method: "automated" }],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nA checker.\n## Decisions\nDEC-001: FR-001 is tested through the injected Io.\n## Components\nsrc/main.ts\n## Data\nBytes\n## Verification\nHermetic tests\n## Risks\nNone";
const task = (id: string, title: string, path: string, extra: Partial<Task> = {}): Task => ({ id, title, description: title, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required", ...extra });
const code = task("T001", "Implement the checker", "src/main.ts");
const hermetic = task("T002", "Test stdin bytes through the injected Io", "tests/main.test.ts", { dependsOn: ["T001"] });
const spawning = task("T002", "Test stdin bytes by starting src/main.ts as a process", "tests/main.test.ts", { dependsOn: ["T001"] });
const finding = { id: "F001", kind: "inconsistency", refs: ["tasks.json"], description: "T002 starts src/main.ts as a process, but the request says the tests are hermetic.", blocking: true };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

class ScriptedExecutor implements AgentExecutor {
  plans = 0;
  spawns = false;
  /** The planner follows its built-in rule until the answer reaches it as binding. */
  constructor(private keepsProcessTest: (prompt: string) => boolean) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/main.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        this.plans++;
        this.spawns = this.keepsProcessTest(request.prompt);
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [code, this.spawns ? spawning : hermetic] } };
        break;
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: this.spawns ? "needs_revision" : "pass", findings: this.spawns ? [finding] : [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(keepsProcessTest: (prompt: string) => boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-answered-finding-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(keepsProcessTest);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build pgnvet. Tests are hermetic: the command line is tested through an injected Io.", ownerLabel: "test", policy });
  const pending = (kind: string) => service.store.requests(run.runId).filter((r) => r.kind === kind && r.status === "pending");
  await service.drive(run.runId, new AbortController().signal);
  const asked = pending("clarification")[0];
  if (!asked) throw new Error("No clarification request");
  const snapshot = await service.get(run.runId);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "answer", requestId: asked.id, digest: asked.digest, answers: { F001: "No test starts a process; test the decoding through the Io." } });
  await service.drive(run.runId, new AbortController().signal);
  return { executor, service, runId: run.runId, pending, clarifications: () => service.store.requests(run.runId).filter((r) => r.kind === "clarification").length };
}

describe("scenario: pgnvet 3f03497b, an answered analysis finding raised again (#1297)", () => {
  test("goes back to the planner with the answer as binding instead of asking the person again", async () => {
    // Like the run: the planner keeps the process test until the answer reaches it as binding.
    const { executor, pending, clarifications } = await plan((prompt) => !prompt.includes("binding decisions"));
    expect(clarifications()).toBe(1);
    expect(pending("approval")).toHaveLength(1);
    expect(executor.spawns).toBe(false);
    // Planned, rerouted by the analysis, replanned after the answer, then once more with it binding.
    expect(executor.plans).toBe(4);
  }, 60000);

  // Audit of 2026-10-17 (#1416): the oldest answer was matched, so a newer answer never got its return.
  test("a newer answer after the binding return goes back to the planner with that answer", async () => {
    const SECOND = "Use a mockable Io for every stdin test.";
    // The planner settles only once a binding note carries the second answer.
    const bound = (prompt: string) =>
      prompt
        .split("do not record the conflict as a decision instead:")
        .slice(1)
        .some((note) => (note.split("User clarification")[0] ?? "").includes("mockable Io"));
    const { executor, service, runId, pending, clarifications } = await plan((prompt) => !bound(prompt));
    const asked = pending("clarification")[0];
    if (!asked) throw new Error("No second clarification request");
    const snapshot = await service.get(runId);
    await service.decide(runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "answer", requestId: asked.id, digest: asked.digest, answers: { F001: SECOND } });
    await service.drive(runId, new AbortController().signal);
    expect(clarifications()).toBe(2);
    expect(pending("approval")).toHaveLength(1);
    expect(executor.spawns).toBe(false);
  }, 60000);

  test("the person is asked again when the binding return did not settle it", async () => {
    const { executor, pending, clarifications } = await plan(() => true);
    expect(clarifications()).toBe(2);
    expect(pending("clarification")).toHaveLength(1);
    expect(executor.plans).toBe(4);
  }, 60000);
});
