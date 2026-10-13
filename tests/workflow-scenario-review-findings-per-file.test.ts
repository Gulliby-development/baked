import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 17, md-site 23c03a8e (#994). One task creates src/front-matter.ts and a
// later task extends it, each for its own criterion. The correctness review raises three findings
// in that file under both criteria, and one in another file. Before the fix each finding resolved
// to the planned task of its criterion, so the three findings in one file became separate
// corrective tasks (239k, 347k and 910k tokens), each reading the same file and tests again.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Markdown site", problem: "Pages have no front matter", outcome: "Front matter is parsed", inScope: ["Parse front matter"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Scalars are parsed", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "Headings are stripped", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a page", when: "it is built", then: "its scalars are parsed", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "a page", when: "it is built", then: "its heading is stripped", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA parser and a site.\n## Decisions\nDEC-001: FR-001 and FR-002 share one parser file.\n## Components\nsrc/front-matter.ts, src/site.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "await Bun.file('src/front-matter.ts').text()"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned = (id: string, path: string, action: "create" | "modify", criterion: string, requirement: string, dependsOn: string[] = []): Task => ({ id, title: `${action} ${path}`, description: `${action} ${path}`, requirementIds: [requirement], criterionIds: [criterion], dependsOn, profileId: "implementer", writes: [{ path, action }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "src/front-matter.ts", "create", "AC-001", "FR-001"), planned("T002", "src/front-matter.ts", "modify", "AC-002", "FR-002", ["T001"]), planned("T003", "src/site.ts", "create", "AC-002", "FR-002")];

type Finding = Review["findings"][number];
const finding = (id: string, file: string, criterion: string, severity: Finding["severity"]): Finding => ({ id, kind: "contradicts", severity, basis: "spec", requirementIds: [criterion === "AC-001" ? "FR-001" : "FR-002"], criterionIds: [criterion], file, symbol: null, evidenceIds: [], claim: `${id} does not hold`, impact: "The page is wrong", suggestedFix: `Fix ${id}` });

class ScriptedExecutor implements AgentExecutor {
  corrections: Task[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { dimension?: string; evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: ["AC-001", "AC-002"].map((criterionId) => ({ criterionId, verdict: "pass", evidenceIds, explanation: "Checks pass" })), findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task && task.origin !== "planned") this.corrections.push(task);
        for (const write of task?.writes ?? []) writeFileSync(join(this.root, write.path), task?.origin === "planned" ? `draft ${task.id}` : "fixed");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote the files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        const fixed = readFileSync(join(this.root, "src/front-matter.ts"), "utf8") === "fixed";
        if (data.extra.dimension !== "correctness" || fixed) { output = pass; break; }
        // F001-F004 as md-site raised them: three in the parser under both criteria, one in the site.
        const findings = [finding("F001", "src/front-matter.ts", "AC-001", "medium"), finding("F002", "src/front-matter.ts", "AC-002", "high"), finding("F003", "src/site.ts", "AC-002", "medium"), finding("F004", "src/front-matter.ts", "AC-002", "low")].map((f) => ({ ...f, evidenceIds }));
        output = { ...pass, verdict: "changes_requested", findings };
        break;
      }
      case "convergence": output = pass; break;
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

describe("scenario: md-site 23c03a8e, review findings in one file (#994)", () => {
  test("findings in one file become one corrective task, most severe first", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-mdsite-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse front matter", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const byFile = executor.corrections.map((t) => [t.findingIds, t.writes.map((w) => w.path).sort()]);
    expect(byFile).toEqual([
      [["F002", "F001", "F004"], ["src/front-matter.ts"]],
      [["F003"], ["src/site.ts"]],
    ]);
    // The task carries both planned tasks' criteria, so each finding keeps its acceptance item.
    expect(executor.corrections[0]?.criterionIds.sort()).toEqual(["AC-001", "AC-002"]);
    expect(executor.corrections[0]?.description.indexOf("Finding F002")).toBe(0);
  });
});
