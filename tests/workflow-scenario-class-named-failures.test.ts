import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { classFilesInOutput } from "../src/core/verification/convergence.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 29, plainbooks 2d0a6a57 (#1270). `mvn verify` failed in QueryTest, whose
// subject Query.java another planned task wrote. Surefire names test classes, not paths, so the
// host found no planned file in the output and gave the repair the files of the first task (the
// fallback), which could not edit Query.java or QueryTest.java; two attempts changed nothing and
// the run blocked.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Ledger", problem: "Reports are missing", outcome: "Reports cut accounts by depth", inScope: ["Amounts", "Queries"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Amounts parse", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "Queries cut accounts at a depth", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "an amount", when: "it parses", then: "it keeps cents", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "a:b:c", when: "depth 2 is asked", then: "a:b is shown", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nAmounts and queries.\n## Decisions\nDEC-001: FR-002 in Query.java.\n## Components\nAmount.java, Query.java\n## Data\nText\n## Verification\nmvn verify\n## Risks\nNone for fixture";
const AMOUNT = "src/main/java/acme/Amount.java";
const AMOUNT_TEST = "src/test/java/acme/AmountTest.java";
const QUERY = "src/main/java/acme/engine/Query.java";
const QUERY_TEST = "src/test/java/acme/engine/QueryTest.java";
/** Fails like Maven Surefire until Query.java is fixed: class names, no file paths. */
const surefire = [
  "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.05 s <<< FAILURE! -- in acme.engine.QueryTest",
  "[ERROR] acme.engine.QueryTest.depthCuts -- Time elapsed: 0.01 s <<< FAILURE!",
  "[ERROR] Failures: ",
  "[ERROR]   QueryTest.depthCuts:42 expected: <a:b> but was: <a>",
  "[ERROR] Tests run: 9, Failures: 1, Errors: 0, Skipped: 0",
].join("\\n");
const verify: Check = { id: "verify", executable: "bun", args: ["-e", `const q = await Bun.file('${QUERY}').text(); if (q !== 'fixed') { console.log('${surefire}'); process.exit(1) }`], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 1, checks: [verify] };
const planned = (id: string, paths: string[], requirement: string, criterion: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${paths[0]}`, description: `Write ${paths.join(", ")}`, requirementIds: [requirement], criterionIds: [criterion], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const plan = [planned("T001", [AMOUNT, AMOUNT_TEST], "FR-001", "AC-001"), planned("T002", [QUERY, QUERY_TEST], "FR-002", "AC-002", ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  corrections: ExecutionRequest[] = [];
  constructor(private root: string) {}
  private write(path: string, text: string) {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), text);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: plan } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.id === "T001") for (const path of [AMOUNT, AMOUNT_TEST]) this.write(path, "amount");
        else if (task?.id === "T002") for (const path of [QUERY, QUERY_TEST]) this.write(path, "cut at the first colon");
        else {
          this.corrections.push(request);
          // Like T024: the fix is in Query.java; without it in the writes nothing can change.
          if (task?.writes.some((w) => w.path === QUERY)) this.write(QUERY, "fixed");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: ["AC-001", "AC-002"].map((criterionId) => ({ criterionId, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: plainbooks 2d0a6a57, a Surefire failure named by class (#1270)", () => {
  test("the repair may write the failing test class and the source it tests, and the run completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-plainbooks-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse amounts and cut accounts by depth", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    const writes = executor.corrections[0]?.task?.writes.map((w) => w.path) ?? [];
    expect(writes).toContain(QUERY);
    expect(writes).toContain(QUERY_TEST);
    expect(done.status).toBe("completed");
    expect(executor.corrections).toHaveLength(1);
  });
});

describe("planned files a test runner names by class", () => {
  const tasks = [...plan, planned("T003", ["src/main/java/acme/report/Reports.java", "src/test/java/acme/report/ReportsTest.java", "src/main/java/acme/cli/Query.java"], "FR-002", "AC-002")];
  test("a fully qualified class picks the file at its package path", () => {
    expect(classFilesInOutput("Tests run: 3, Failures: 1 -- in acme.engine.QueryTest", tasks)).toEqual([QUERY_TEST]);
    expect(classFilesInOutput("at acme.report.Reports.cut(Reports.java:57)", tasks)).toEqual(["src/main/java/acme/report/Reports.java"]);
  });
  test("a simple name or a frame matches only a file no other planned file shares the name with", () => {
    expect(classFilesInOutput("[ERROR]   ReportsTest.depth:12 expected", tasks)).toEqual(["src/test/java/acme/report/ReportsTest.java"]);
    expect(classFilesInOutput("\tat Query.cut(Query.java:9)", tasks)).toEqual([]);
    expect(classFilesInOutput("Ran 3 tests across 1 file.", tasks)).toEqual([]);
  });
});
