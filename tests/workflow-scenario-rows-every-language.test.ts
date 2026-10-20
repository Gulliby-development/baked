import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { runRoot } from "../src/core/workflows/worktree.js";

// #1660: rows as data expanded 0 rows in a Go initiative and three controls, because only Bun and
// pytest had templates, the reader took only two-column tables and the spec author was never told
// the table shape. A Go spec with a labelled 12-row table must now become a host-written test.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const go = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const cases = Array.from({ length: 12 }, (_, i) => [i - 3, (i - 3) * 2] as const);
const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Double", problem: "No doubler",
  outcome: "Double a number", inScope: ["Double"], outOfScope: [], assumptions: [], openQuestions: [], dependencies: [],
  requirements: [{ id: "FR-001", text: "Return twice the input number", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a JSON number", when: "Double is called",
    then: `Input | Scenario | Expected\n--- | --- | ---\n${cases.map(([input, expected]) => `\`${input}\` | ${input < 0 ? "negative" : "non-negative"} number | \`${expected}\``).join("\n")}`, method: "automated" }],
};
const markdown = "# Plan\n## Context\nDouble.\n## Decisions\nDEC-001: FR-001 doubles numbers.\n## Components\ndouble/double.go\n## Data\nJSON numbers\n## Verification\nGo tests\n## Risks\nNone";
const rowTest = { framework: "go" as const, package: "double", harness: "double/harness.go", test: "double/rows_test.go", data: "double/testdata/rows.json" };
const task: Task = {
  id: "T001", title: "Test Double", description: "Write the Actual(input) harness for Double", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
  dependsOn: [], profileId: "implementer", writes: [rowTest.harness, rowTest.test, rowTest.data].map((path) => ({ path, action: "create" })),
  readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Verify the examples", rows: ["AC-001"], rowTest,
};
const HARNESS = "package double\n\nfunc Actual(input any) (any, error) {\n\treturn input.(float64) * 2, nil\n}\n";

class ScriptedExecutor implements AgentExecutor {
  specNotes: unknown[] = [];
  implementations = 0;
  caseProblems: string[] = [];
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string; snapshotHash: string;
      extra: { derivationAudit?: unknown; evidence?: { id: string }[]; acceptanceRows?: { note: string } };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["double/double.go"] }; break;
      case "spec": this.specNotes.push(data.extra.acceptanceRows?.note); output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [],
        // The analyzer copies only the input and expected cells, without the Scenario label.
        derivations: cases.map(([input, expected]) => ({ criterionId: "AC-001", row: `${input} | ${expected}`, recomputed: String(expected), matches: true, derivation: "Multiply the input by two as FR-001 requires" })) }; break;
      case "implementation": {
        this.implementations++;
        const root = request.root ?? "";
        mkdirSync(dirname(join(root, rowTest.harness)), { recursive: true });
        writeFileSync(join(root, rowTest.harness), HARNESS);
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

describe("scenario: rows as data in a Go project with a labelled table (#1660)", () => {
  test("the spec author is told the table shape, and the host writes the Go test and all 12 rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-rows-go-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "go.mod"), "module example.com/fixture\n\ngo 1.21\n");
    // Without a Go toolchain the check only proves the run reaches it; with one it runs the rows.
    const check = go ? { executable: "go", args: ["test", "./..."] } : { executable: process.execPath, args: ["--version"] };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, rowsAsData: "on", critic: "off",
      checks: [{ id: "tests", ...check, cwd: ".", timeoutMs: 120000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const executor = new ScriptedExecutor();
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write Double and verify its numeric examples", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const pending = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.map((a) => service.store.readArtifact(run.runId, a.id))).toEqual([]);
    if (!approval) throw new Error(`Approval missing: ${pending.status} ${pending.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: pending.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(executor.specNotes[0]).toContain("Input | Scenario | Expected");
    expect(done.status).toBe("completed");
    expect(executor.implementations).toBe(1);
    expect(executor.caseProblems).toEqual([]);
    const workspace = runRoot(root, service.store.state(run.runId));
    const rows = JSON.parse(readFileSync(join(workspace, rowTest.data), "utf8")) as { id: string; label?: string; input: number; expected: number }[];
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ id: "AC-001:1", label: "negative number", input: -3, expected: -6 });
    expect(readFileSync(join(workspace, rowTest.test), "utf8")).toContain("func TestAcceptanceRowsRows(t *testing.T)");
    expect(runReport(service.store, run.runId)).toContain("the host wrote 12 rows and their tests for 1 harness task");
    if (!go) return;
    writeFileSync(join(workspace, rowTest.harness), "package double\n\nfunc Actual(input any) (any, error) {\n\treturn input, nil\n}\n");
    expect(Bun.spawnSync(["go", "test", "./..."], { cwd: workspace, stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
  }, 180000);
});
