import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench rounds 19 to 21, md-site (#1109). Convergence stopped with a finding on AC-001
// that kept coming back, and the last review also left AC-006 (a criterion only a browser could
// show) inconclusive with no finding. The stop was accepted, by the assume rule and by a person,
// but only the finding became a known limitation: acceptance then threw "Criterion AC-006 did not
// pass" and the run blocked three rounds in a row after 5.80M tokens with every check green.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const request = "Build a static site generator with a navigation sidebar.";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "md-site", problem: "Markdown needs pages", outcome: "Pages are generated", inScope: ["Pages", "Sidebar"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Each Markdown file becomes a page", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "The sidebar stays visible while scrolling", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a Markdown file", when: "the site is built", then: "a page is written", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "a long page", when: "it is scrolled in a browser", then: "the sidebar stays visible", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA generator.\n## Decisions\nDEC-001: FR-001 and FR-002 in src/site.ts.\n## Components\nsrc/site.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "await Bun.file('src/site.ts').text()"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const tasks: Task[] = [{ id: "T001", title: "create src/site.ts", description: "create src/site.ts", requirementIds: ["FR-001", "FR-002"], criterionIds: ["AC-001", "AC-002"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/site.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" }];

type Finding = Review["findings"][number];
const gap = (round: number): Omit<Finding, "evidenceIds"> => ({ id: `F-00${String(round)}`, kind: "missing", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/site.ts", symbol: null, claim: `Nested pages lose their front matter (round ${String(round)})`, impact: "Titles are wrong", suggestedFix: "Parse front matter in src/site.ts" });

class ScriptedExecutor implements AgentExecutor {
  private rounds = 0;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const coverage = [
      { criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" },
      { criterionId: "AC-002", verdict: "pass", evidenceIds, explanation: "Checks pass" },
    ];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (!task) throw new Error("No task");
        writeFileSync(join(this.root, "src/site.ts"), `export const pages = ${JSON.stringify(task.id)};\n`);
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        // AC-001 fails with a fresh finding every round; AC-002 needs a browser the host lacks.
        this.rounds += 1;
        output = {
          ...pass,
          verdict: "changes_requested",
          coverage: [
            { criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Nested pages lose front matter" },
            { criterionId: "AC-002", verdict: "inconclusive", evidenceIds: [], explanation: "Scrolling needs a browser" },
          ],
          findings: [{ ...gap(this.rounds), evidenceIds }],
        };
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

describe("scenario: md-site, an accepted convergence stop with an inconclusive criterion (#1109)", () => {
  async function drive(policy: RunPolicy) {
    const root = mkdtempSync(join(tmpdir(), "baked-md-site-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    const executor = new ScriptedExecutor(root);
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
    return { service, run, done };
  }
  const lastError = (service: NativeWorkflowService, runId: string) => {
    const artifact = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/")).at(-1);
    return artifact ? service.store.readArtifact(runId, artifact.id) : "";
  };

  test("the assume rule accepts the stop and the inconclusive criterion becomes an unverified limitation", async () => {
    const { service, run, done } = await drive({ ...defaultWorkflowPolicy, checks: [check], clarification: "assume" });
    expect(lastError(service, run.runId)).toBe("");
    expect(done).toMatchObject({ status: "completed" });
    const limitations = service.store.state(run.runId).limitations;
    expect(limitations.find((l) => l.findingId === "unverified-AC-002")).toMatchObject({ kind: "unverified", criterionIds: ["AC-002"], decidedBy: "notes" });
    expect(limitations.filter((l) => l.criterionIds.includes("AC-001")).map((l) => l.decidedBy)).toEqual(["assume"]);
    expect(runReport(service.store, run.runId)).toContain("Criterion AC-002 could not be verified on this host");
  }, 60000);

  test("a person accepting the stop completes the run too", async () => {
    const { service, run, done } = await drive({ ...defaultWorkflowPolicy, checks: [check] });
    expect(done).toMatchObject({ status: "waiting" });
    const pending = service.store.requests(run.runId).find((r) => r.kind === "convergence" && r.status === "pending");
    if (!pending) throw new Error("No pending convergence request");
    const snapshot = await service.get(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "accept", requestId: pending.id });
    const final = await service.drive(run.runId, new AbortController().signal);
    expect(lastError(service, run.runId)).toBe("");
    expect(final).toMatchObject({ status: "completed" });
    const limitations = service.store.state(run.runId).limitations;
    expect(limitations.map((l) => [l.findingId.startsWith("unverified") ? l.findingId : "finding", l.decidedBy])).toEqual([["finding", "user"], ["unverified-AC-002", "notes"]]);
  }, 60000);
});
