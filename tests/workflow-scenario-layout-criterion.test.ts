import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { type Check, layoutCriteria, prescribedLayoutCss, repairLayoutCriteria, type RunPolicy, type Spec, SpecSchema, specCoverageProblems, validateSpecCoverage } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 28 (#1247). zoneslot-update 129e4cd7: the spec author added the default
// "pages fit a 1280 px wide viewport" criterion as AC-008 with method manual. The sdd workflow
// renders no page, so the run waited on a manual_evidence request until a person measured
// scrollWidth in a browser. md-site 630b42cc turned the same criterion into prescribed CSS
// (max-width 80rem, padding 1rem, white-space pre-wrap) and analysis sent the plan back twice.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = "Add the slot count to the zone page.";
const layout = { id: "AC-002", requirementIds: ["FR-002"], given: "the zone page", when: "an acceptance walker opens it in a 1280 px wide viewport", then: "the page has no horizontal scrolling outside the slot grid", method: "manual" as const };
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Slot count", problem: "The count is missing", outcome: "The page shows the count", inScope: ["Show the count"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The page shows the slot count", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "The page fits a 1280 px viewport", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a zone", when: "the page renders", then: "page.html shows the slot count", method: "automated" }, layout], dependencies: [] };
const markdown = "# Plan\n## Context\nOne page.\n## Decisions\nDEC-001: FR-001 adds the count.\n## Components\npage.html\n## Data\nText\n## Verification\nThe page check\n## Risks\nNone for fixture";
const check: Check = { id: "page", executable: "bun", args: ["-e", "if (!(await Bun.file('page.html').text()).includes('slots')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [check] };

class ScriptedExecutor implements AgentExecutor {
  service?: NativeWorkflowService;
  runId = "";
  constructor(private root: string) {}
  /** The spec the run stored, so the plan and the reviewers follow whatever the host made of it. */
  private spec(): Spec {
    const stored = this.service?.store.latestArtifact(this.runId, "spec.json");
    return SpecSchema.parse(JSON.parse(this.service?.store.readArtifact(this.runId, stored?.id ?? "") ?? "{}"));
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["page.html"] }; break;
      case "spec": output = spec; break;
      case "plan": {
        const current = this.spec();
        const criteria = current.criteria.filter((c) => c.method !== "post-release").map((c) => c.id);
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(current), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Show the count", description: "Write page.html", requirementIds: ["FR-001", "FR-002"], criterionIds: criteria, dependsOn: [], profileId: "implementer", writes: [{ path: "page.html", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        writeFileSync(join(this.root, "page.html"), "<main>4 slots</main>\n");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote page.html", evidenceIds: [], unresolved: [] };
        break;
      case "review":
      case "convergence": {
        // Reading files proves the count; nothing in the run can observe a page in a browser.
        const coverage = this.spec().criteria.map((c) => c.method === "post-release" ? { criterionId: c.id, verdict: "deferred", evidenceIds: [], explanation: "After release" } : (c.method === "manual" ? { criterionId: c.id, verdict: "inconclusive", evidenceIds: [], explanation: "Needs a browser" } : { criterionId: c.id, verdict: "pass", evidenceIds: evidence, explanation: "The page shows it" }));
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: zoneslot-update 129e4cd7, a manual 1280 px criterion in sdd (#1247)", () => {
  test("the run completes without asking a person to measure the page", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-layout-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const executor = new ScriptedExecutor(root);
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
    executor.service = service;
    executor.runId = run.runId;
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "").toBe("");
    expect(service.store.requests(run.runId).filter((r) => r.kind === "manual_evidence")).toEqual([]);
    expect(done.status).toBe("completed");
    const stored = service.store.latestArtifact(run.runId, "spec.json");
    const saved = SpecSchema.parse(JSON.parse(service.store.readArtifact(run.runId, stored?.id ?? "")));
    expect(saved.criteria.find((c) => c.id === "AC-002")?.method).toBe("post-release");
    expect(saved.criteria.find((c) => c.id === "AC-003")).toMatchObject({ requirementIds: ["FR-002"], method: "automated" });
    expect(validateSpecCoverage(saved)).toEqual([]);
    expect(service.store.latestArtifact(run.runId, "spec-repairs/layout.json")).toBeTruthy();
  }, 60000);
});

describe("layout criteria", () => {
  test("are found by viewport and horizontal scrolling", () => {
    const other = { ...layout, id: "AC-003", given: "a list", when: "it scrolls", then: "it scrolls vertically" };
    expect(layoutCriteria({ criteria: [layout, other] })).toEqual(["AC-002"]);
  });
  test("a browser test or a browser gate keeps an automated criterion", () => {
    const measured = { ...layout, method: "automated" as const, when: "the Playwright test opens it in a 1280 px wide viewport" };
    expect(repairLayoutCriteria({ ...spec, criteria: [spec.criteria[0]!, measured] }).repaired).toEqual([]);
    expect(repairLayoutCriteria(spec, { browser: true }).repaired).toEqual([]);
    expect(repairLayoutCriteria({ ...spec, criteria: [spec.criteria[0]!, { ...layout, method: "automated" }] }).repaired).toEqual(["AC-002"]);
  });
  test("prescribed CSS goes back to the author unless the request names it", () => {
    // md-site 630b42cc, AC-008.
    const css = { ...layout, method: "automated" as const, then: "body has width: 100%, max-width 80rem and padding 1rem, pre uses white-space pre-wrap, and the page has no horizontal scrolling" };
    const withCss = { ...spec, criteria: [spec.criteria[0]!, css] };
    expect(prescribedLayoutCss(withCss, REQUEST)).toEqual(["AC-002"]);
    expect(specCoverageProblems(withCss, undefined, { request: REQUEST }).join(" ")).toContain("criterion AC-002 prescribes CSS");
    expect(prescribedLayoutCss(spec, REQUEST)).toEqual([]);
    expect(prescribedLayoutCss(withCss, "Center the page: width: 100%, max-width 80rem, padding 1rem, pre with white-space pre-wrap.")).toEqual([]);
  });
});
