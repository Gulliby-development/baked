import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 34, md-site d486645a (#1285). The test `bun run typecheck exits
// successfully` failed with only `Received: 2`: the test spawned the project's typecheck and
// asserted its exit code, so the tsc diagnostics never reached the check output. T008 opened T011,
// T011 opened T012 for the same failing test, each told only "required check tests-written
// failed", and the run blocked `no_progress`. The host now runs the check the failing test names
// and gives its output to the correction, and tells a correction of a correction that the failure
// is the one the earlier correction was opened for.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Typed site", problem: "The site does not typecheck", outcome: "The project typechecks", inScope: ["Write the site source"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The project typechecks", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the project", when: "bun run typecheck runs", then: "it exits successfully", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne source file.\n## Decisions\nDEC-001: FR-001 typechecks.\n## Components\nsite.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// The project's typecheck: prints a tsc diagnostic while site.ts assigns a string to a number.
const typecheck: Check = { id: "typecheck", executable: "bun", args: ["-e", "const t = await Bun.file('site.ts').text(); if (t.includes('= \"2\"')) { console.log(\"site.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\"); process.exit(2) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
// The written test spawns the typecheck and reports only its exit code, as bun test does.
const testsCheck: Check = { id: "tests-written", executable: "bun", args: ["-e", "const f = Bun.file('site.ts'); if (!(await f.exists())) { console.log('(fail) site.ts exists'); process.exit(1) } if ((await f.text()).includes('= \"2\"')) { console.log('(fail) bun run typecheck exits successfully'); console.log('error: expect(received).toBe(expected)'); console.log('Expected: 0'); console.log('Received: 2'); process.exit(1) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [typecheck, testsCheck] };

class ScriptedExecutor implements AgentExecutor {
  /** The input of each implementation, as the task's worker sees it. */
  implementations: { taskId: string; input: string }[] = [];
  constructor(
    private root: string,
    private writes: string[],
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["site.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write the site", description: "Write site.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "site.ts", action: "create" }], readHints: [], checkIds: ["tests-written"], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const index = this.implementations.length;
        this.implementations.push({ taskId: request.task?.id ?? "", input: request.prompt });
        writeFileSync(join(this.root, "site.ts"), this.writes[Math.min(index, this.writes.length - 1)] ?? "");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote site.ts", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(writes: string[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-spawned-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, writes);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Make the site typecheck", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
  const lastError = errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "";
  const findings = service.store.findings(run.runId).map((f) => JSON.parse(f.body_json) as { claim: string; impact: string; suggestedFix: string; evidenceIds: string[] });
  return { done, executor, root, lastError, findings };
}

const bad = 'export const n: number = "2";\n';
const good = "export const n: number = 2;\n";
/** A correction that changes the file but keeps the type error. */
const stillBad = 'export const n: number = "2"; // a cast was not the fix\n';

describe("scenario: md-site d486645a, a test that spawns the project's typecheck (#1285)", () => {
  test("the corrective gets the typecheck's own diagnostics, and its successor is told it is the same failure", async () => {
    const { done, executor, root, lastError, findings } = await runScenario([bad, stillBad, good]);
    expect(lastError).toBe("");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "site.ts"), "utf8")).toBe(good);
    expect(executor.implementations.map((i) => i.taskId)).toEqual(["T001", "T002", "T003"]);
    // Both check findings quote the diagnostic the test's child process printed.
    const failed = findings.filter((f) => f.claim.endsWith("required check tests-written failed"));
    expect(failed).toHaveLength(2);
    for (const finding of failed) {
      expect(finding.impact).toContain("Failing: ");
      expect(finding.impact).toContain("runs the project's typecheck check");
      expect(finding.impact).toContain("error TS2322");
      expect(finding.evidenceIds).toHaveLength(2);
    }
    expect(executor.implementations[1]?.input).toContain("error TS2322");
    // The correction of the correction knows the earlier one left the same failure.
    expect(executor.implementations[2]?.input).toContain("This is the same failure T002 was opened for");
    expect(executor.implementations[1]?.input).not.toContain("This is the same failure");
  }, 60000);

  test("a failing test that names no project check keeps the check output as it was", async () => {
    const { findings } = await runScenario(["export const n = 1;\n// missing\n", good]);
    expect(findings.every((f) => !f.impact.includes("runs the project's"))).toBe(true);
  }, 60000);
});
