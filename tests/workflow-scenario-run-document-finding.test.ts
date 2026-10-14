import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { namesRunDocument } from "../src/core/workflows/spec-amendment.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 21, md-site eed93dab (#1066; colfit 0149cea7 in round 20 the same). A
// correction chose a collision policy for index pages that the approved spec does not name (the
// first unused name instead of a fixed index-page.html). Convergence then raised the code finding
// F-003 and F-004, a partial finding on spec.json: "the spec still requires the fixed
// index-page.html mapping although the correction uses the first unused name". No task writes
// spec.json, so the correction faulted "Correction requires writes outside the approved task
// scope" and the run stopped at 5.30M tokens with every check green.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const request = "Build a static site generator. A README.md becomes the index page.";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "md-site", problem: "Markdown needs pages", outcome: "Pages are generated", inScope: ["Index pages"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "README.md maps to index-page.html", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a README.md", when: "the site is built", then: "it is written to index-page.html", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA generator.\n## Decisions\nDEC-001: FR-001 in src/site.ts.\n## Components\nsrc/site.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "await Bun.file('src/site.ts').text()"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };
const tasks: Task[] = [{ id: "T001", title: "create src/site.ts", description: "create src/site.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/site.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" }];

type Finding = Review["findings"][number];
const f003: Omit<Finding, "evidenceIds"> = { id: "F-003", kind: "partial", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/site.ts", symbol: null, claim: "INDEX.md and index.md collide on a case-insensitive file system", impact: "One page overwrites the other", suggestedFix: "Compare page names case-insensitively in src/site.ts" };
const f004: Omit<Finding, "evidenceIds"> = { id: "F-004", kind: "partial", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "spec.json", symbol: null, claim: "The supplied specification and plan still require the fixed index-page.html mapping, although the correction uses the first unused index-page name", impact: "The spec and the code disagree", suggestedFix: "Update AC-001 in the spec to the first unused index-page name" };

class ScriptedExecutor implements AgentExecutor {
  corrections: Task[] = [];
  convergenceRequests: string[] = [];
  /** both: F-003 and F-004 until the code is fixed; document: F-004 alone until the amendment is read; always: F-004 every time. */
  constructor(private root: string, private mode: "both" | "document" | "always" = "both") {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (!task) throw new Error("No task");
        if (task.origin !== "planned") this.corrections.push(task);
        writeFileSync(join(this.root, "src/site.ts"), task.origin === "planned" ? "export const page = 'first unused index-page name';\n" : "export const page = 'first unused, case-insensitive';\n");
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        this.convergenceRequests.push(request.prompt);
        const fixed = readFileSync(join(this.root, "src/site.ts"), "utf8").includes("case-insensitive");
        const amended = request.prompt.includes("The implementation is authoritative");
        const findings =
          this.mode === "both" ? (fixed ? [] : [f003, f004]) : this.mode === "document" ? (amended ? [] : [f004]) : [f004];
        output = findings.length ? { ...pass, verdict: "changes_requested", findings: findings.map((f) => ({ ...f, evidenceIds })) } : pass;
        break;
      }
      case "refutation": {
        const { finding: raised } = data.extra as unknown as { finding: Finding };
        output = { schemaVersion: 1, findingId: raised.id, decision: "confirmed", evidenceIds, explanation: "The review shows it" };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: md-site eed93dab, a convergence finding on spec.json (#1066)", () => {
  async function drive(mode: "both" | "document" | "always") {
    const root = mkdtempSync(join(tmpdir(), "baked-md-site-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    const executor = new ScriptedExecutor(root, mode);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    return { service, executor, run, done };
  }

  test("the finding records a spec amendment and only the code finding gets a correction", async () => {
    const { service, executor, run, done } = await drive("both");
    expect(done).toMatchObject({ status: "completed" });
    expect(executor.corrections.map((t) => t.findingIds)).toEqual([["F-003"]]);
    const amendments = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("amendments/"));
    expect(amendments.map((a) => a.logical_path)).toEqual(["amendments/F-004.json"]);
    expect(JSON.parse(service.store.readArtifact(run.runId, amendments[0]?.id ?? ""))).toMatchObject({ authority: "implementation", criterionIds: ["AC-001"] });
    // The convergence after the correction reads that the implementation wins over AC-001.
    expect(executor.convergenceRequests.at(-1)).toContain("The implementation is authoritative over AC-001, FR-001");
    expect(service.store.findings(run.runId).find((f) => f.id === "F-004")?.status).toBe("resolved");
    // The run report (and so the delivered pull request) lists it under Decisions.
    expect(runReport(service.store, run.runId)).toContain("Spec amendments (the implementation wins over the spec):");
  });

  test("a round with only the spec.json finding judges the convergence again without a correction", async () => {
    const { service, executor, run, done } = await drive("document");
    expect(done).toMatchObject({ status: "completed" });
    expect(executor.corrections).toEqual([]);
    expect(service.store.run(run.runId).convergence_rounds).toBe(1);
  });

  test("a reviewer that raises spec.json again after the amendment does not start another round", async () => {
    const { done, service, run, executor } = await drive("always");
    expect(done).toMatchObject({ status: "completed" });
    expect(executor.corrections).toEqual([]);
    expect(executor.convergenceRequests).toHaveLength(2);
    expect(service.store.run(run.runId).convergence_rounds).toBe(1);
  });
});

describe("run documents in findings", () => {
  test("spec.json and plan.md are run documents unless a planned task writes a file of that name", () => {
    expect(namesRunDocument({ file: "spec.json" }, ["src/site.ts"])).toBe(true);
    expect(namesRunDocument({ file: "specs\\fixture\\plan.md" }, [])).toBe(true);
    expect(namesRunDocument({ file: "spec.json" }, ["spec.json"])).toBe(false);
    expect(namesRunDocument({ file: "src/site.ts" }, [])).toBe(false);
    expect(namesRunDocument({ file: null }, [])).toBe(false);
  });
});
