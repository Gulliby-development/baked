import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// #1942 (R61 md-site): a formatter gate's fixer laid the host-written rows test out again, and the
// next attempt over the same rows was refused input_changed before the model ran. #1944: a real
// change of a host file still stops, and its message names a way forward.
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
const task: Task = {
  id: "T001", title: "Test double", description: "Write the actual(input) harness for double", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
  dependsOn: [], profileId: "implementer", writes: [rowTest.harness, rowTest.test, rowTest.data].map((path) => ({ path, action: "create" })),
  readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Verify the examples", rows: ["AC-001"], rowTest,
};

/** Biome's default layout: tab indentation, and short arrays on one line. */
const biomeLayout = (root: string) => {
  const test = join(root, rowTest.test);
  writeFileSync(test, readFileSync(test, "utf8").replace(/^ {2}/gm, "\t"));
  const data = join(root, rowTest.data);
  writeFileSync(data, `${JSON.stringify(JSON.parse(readFileSync(data, "utf8")), null, "\t")}\n`);
};

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  /** What the first attempt does to the host files besides writing a wrong harness. */
  stop = new AbortController();
  constructor(private first: "layout" | "edit") {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string; snapshotHash: string;
      extra: { derivationAudit?: unknown; evidence?: { id: string }[] };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["tests/double.test.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [],
        ...(data.extra.derivationAudit ? { derivations: ["12 | 24", "-3 | -6", "0 | 0"].map((row) => ({ criterionId: "AC-001", row, recomputed: row.split("|")[1]?.trim(), matches: true, derivation: "Multiply the input by two as FR-001 requires" })) } : {}) }; break;
      case "implementation": {
        const root = request.root ?? "";
        mkdirSync(dirname(join(root, rowTest.harness)), { recursive: true });
        // The first attempt's harness fails the rows, so a second attempt runs over the same rows.
        const first = ++this.implementations === 1;
        writeFileSync(join(root, rowTest.harness), `export const actual = (input: number) => input * ${first ? 3 : 2};\n`);
        if (first && this.first === "layout") biomeLayout(root);
        // A person stops the run after the first attempt.
        if (first && this.first === "edit") this.stop.abort();
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote the harness", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The emitted tests pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected output ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function start(first: "layout" | "edit") {
  const root = mkdtempSync(join(tmpdir(), "baked-rows-fixer-layout-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, rowsAsData: "on", critic: "off",
    checks: [{ id: "tests", executable: process.execPath, args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
  const executor = new ScriptedExecutor(first);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write double and verify its numeric examples", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const pending = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("Approval missing");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: pending.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, executor.stop.signal).catch(() => service.get(run.runId));
  const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => String(service.store.readArtifact(run.runId, a.id)));
  return { root: runRoot(root, service.store.state(run.runId)), service, runId: run.runId, executor, done, errors };
}

describe("scenario: a fixer's layout of a host-written rows file (#1942, #1944)", () => {
  test("the next attempt over the same rows keeps the fixer's layout instead of stopping input_changed", async () => {
    const { root, executor, done, errors } = await start("layout");
    expect(errors.join("\n")).not.toContain("INPUT_CHANGED");
    expect(executor.implementations).toBe(2);
    expect(done.status).toBe("completed");
    // The fixer's layout stays; the host does not write its own back over it.
    expect(readFileSync(join(root, rowTest.test), "utf8")).toContain("\texpect(");
    expect(Bun.spawnSync([process.execPath, "test", `./${rowTest.test}`], { cwd: root }).exitCode).toBe(0);
  }, 90000);

  test("a changed host file still stops, and the message names how to go on", async () => {
    const { root, service, runId, done } = await start("edit");
    expect(done.status).not.toBe("completed");
    // Not a layout: the assertion itself changed while the run was stopped.
    const test = join(root, rowTest.test);
    writeFileSync(test, readFileSync(test, "utf8").replace("toEqual(expected)", "toBeDefined()"));
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { acceptWorkspace: true });
    const blocked = await service.drive(runId, new AbortController().signal);
    const errors = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => String(service.store.readArtifact(runId, a.id)));
    expect(blocked.reason).toBe("input_changed");
    const refusal = errors.find((error) => error.includes("Host-written acceptance file changed")) ?? "";
    expect(refusal).toContain(`baked workflow resume ${runId} --accept-workspace`);
    expect(refusal).toContain(`baked workflow revise ${runId}`);
    // Deleting the file and accepting the workspace has the host write it again.
    rmSync(test);
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { acceptWorkspace: true });
    const resumed = await service.drive(runId, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(readFileSync(test, "utf8")).toContain("toEqual(expected)");
  }, 90000);
});
