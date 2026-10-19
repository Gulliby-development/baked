import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { runRoot } from "../src/core/workflows/worktree.js";
import { readWorkflowView } from "../src/core/workflows/view.js";

// #1596: the literal expected values already belong to the audited spec. The agent writes
// only actual(input); the host must supply executable tests and retain every row's ID.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Double", problem: "No doubler",
  outcome: "Double a number", inScope: ["Double"], outOfScope: [], assumptions: [], openQuestions: [], dependencies: [],
  requirements: [{ id: "FR-001", text: "Return twice the input number", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a JSON number", when: "double is called",
    then: "Input | Expected\n--- | ---\n12 | 24\n-3 | -6\n0 | 0", method: "automated" }],
};
const markdown = "# Plan\n## Context\nDouble.\n## Decisions\nDEC-001: FR-001 doubles numbers.\n## Components\ntests/double.test.ts\n## Data\nJSON numbers\n## Verification\nBun tests\n## Risks\nNone";
const rowTest = { framework: "bun" as const, harness: "tests/double-harness.ts", test: "tests/double.test.ts", data: "tests/double.rows.json" };
const task = (enabled: boolean): Task => ({
  id: "T001", title: "Test double", description: "Write the actual(input) harness for double", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
  dependsOn: [], profileId: "implementer", writes: [rowTest.harness, rowTest.test, rowTest.data].map((path) => ({ path, action: "create" })),
  readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Verify the examples",
  ...(enabled ? { rows: ["AC-001"], rowTest } : {}),
});

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  caseProblems: string[] = [];
  constructor(private enabled: boolean, private corrupt = false, private parallel = false) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string; snapshotHash: string;
      extra: { derivationAudit?: unknown; evidence?: { id: string }[] };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["tests/double.test.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task(this.enabled), ...(this.parallel ? [{ ...task(false), id: "T002", title: "Write a note", description: "Write a note", writes: [{ path: "note.txt", action: "create" }] }] : [])] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [],
        ...(data.extra.derivationAudit ? { derivations: ["12 | 24", "-3 | -6", "0 | 0"].map((row) => ({ criterionId: "AC-001", row, recomputed: row.split("|")[1]?.trim(), matches: true, derivation: "Multiply the input by two as FR-001 requires" })) } : {}) }; break;
      case "implementation": {
        this.implementations++;
        const root = request.root ?? "";
        if (request.task?.id === "T002") {
          writeFileSync(join(root, "note.txt"), "Doubles verified by the acceptance tests.\n");
          output = { schemaVersion: 1, taskId: "T002", outcome: "implemented", summary: "Wrote note", evidenceIds: [], unresolved: [] };
          break;
        }
        mkdirSync(dirname(join(root, rowTest.harness)), { recursive: true });
        writeFileSync(join(root, rowTest.harness), "export const actual = (input: number) => input * 2;\n");
        if (!this.enabled) {
          writeFileSync(join(root, rowTest.data), "[]\n");
          writeFileSync(join(root, rowTest.test), 'import { test, expect } from "bun:test";\nimport { actual } from "./double-harness.ts";\ntest("ordinary", () => { expect(actual(12)).toBe(24); expect(actual(-3)).toBe(-6); expect(actual(0)).toBe(0); });\n');
        }
        if (this.corrupt) writeFileSync(join(root, rowTest.data), "[]\n");
        this.caseProblems = await request.caseCheck?.(root) ?? [];
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote only the harness", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The emitted tests pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected output ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function start(enabled = true, corrupt = false, parallel = false, reopen = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-acceptance-rows-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (parallel) {
    for (const args of [["init"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"]])
      expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
    writeFileSync(join(root, "README.md"), "# Fixture\n");
    expect(Bun.spawnSync(["git", "add", "README.md"], { cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-c", "core.hooksPath=", "commit", "-m", "Fixture"], { cwd: root }).exitCode).toBe(0);
  }
  const policy: RunPolicy = { ...defaultWorkflowPolicy, ...(enabled ? { rowsAsData: "on" } : {}),
    ...(parallel ? { executionMode: "worktree", maxConcurrentWriters: 2 } : {}),
    checks: [{ id: "tests", executable: process.execPath, args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }], critic: "off" };
  const executor = new ScriptedExecutor(enabled, corrupt, parallel);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  let service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write double and verify its numeric examples", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const pending = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  expect({ status: pending.status, reason: pending.reason, approval: !!approval }).toMatchObject({ approval: true });
  if (!approval) throw new Error("Approval missing");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: pending.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  if (reopen) {
    service.close();
    service = new NativeWorkflowService(root, config, executor);
  }
  const done = await service.drive(run.runId, new AbortController().signal);
  return { root: runRoot(root, service.store.state(run.runId)), service, runId: run.runId, executor, done };
}

describe("scenario: audited acceptance rows become tests (#1596)", () => {
  test("the host writes all rows and Bun tests while the executor writes only a harness", async () => {
    const { root, service, runId, executor, done } = await start();
    const errors = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.map((a) => service.store.readArtifact(runId, a.id))).toEqual([]);
    expect(done.status).toBe("completed");
    expect(executor.implementations).toBe(1);
    expect(executor.caseProblems).toEqual([]);
    const artifact = service.store.latestArtifact(runId, "rows.json");
    expect(artifact).not.toBeNull();
    expect(readWorkflowView(service, runId).details.acceptanceRows?.rows).toHaveLength(3);
    const rows = JSON.parse(readFileSync(join(root, rowTest.data), "utf8"));
    expect(rows.map((row: { id: string }) => row.id)).toEqual(["AC-001:1", "AC-001:2", "AC-001:3"]);
    const passing = Bun.spawnSync([process.execPath, "test", "./tests/double.test.ts"], { cwd: root });
    expect(passing.exitCode).toBe(0);
    writeFileSync(join(root, rowTest.harness), "export const actual = (input: number) => input;\n");
    expect(Bun.spawnSync([process.execPath, "test", "./tests/double.test.ts"], { cwd: root }).exitCode).not.toBe(0);
    expect(service.store.effects(runId).filter((e) => e.kind === "file_patch").map((e) => JSON.parse(e.intent_json).path)).toEqual(expect.arrayContaining([rowTest.test, rowTest.data]));
  }, 60000);

  test("default-off runs still ask the executor to write ordinary tests and have no rows artifact", async () => {
    const { service, runId, executor, done } = await start(false);
    expect(done.status).toBe("completed");
    expect(service.store.latestArtifact(runId, "rows.json")).toBeNull();
    expect(readWorkflowView(service, runId).details.acceptanceRows).toBeUndefined();
    expect(executor.caseProblems).toEqual([]);
  }, 60000);

  test("a provider cannot submit changed host data", async () => {
    const { executor, done } = await start(true, true);
    expect(done.status).not.toBe("completed");
    expect(executor.caseProblems.join("\n")).toContain("Host-written acceptance file tests/double.rows.json");
  }, 60000);

  test("a reopened service uses the persisted audit before writing rows", async () => {
    const { service, runId, done } = await start(true, false, false, true);
    expect(done.status).toBe("completed");
    expect(service.store.artifacts(runId).filter((a) => a.logical_path === "rows.json")).toHaveLength(1);
  }, 60000);

  test("parallel task worktrees integrate host files with the harness", async () => {
    const { root, executor, done } = await start(true, false, true);
    expect(done.status).toBe("completed");
    expect(executor.implementations).toBe(2);
    expect(executor.caseProblems).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, rowTest.data), "utf8"))).toHaveLength(3);
    expect(Bun.spawnSync([process.execPath, "test", "./tests/double.test.ts"], { cwd: root }).exitCode).toBe(0);
  }, 90000);
});
