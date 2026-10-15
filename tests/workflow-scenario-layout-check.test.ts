import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { type LayoutProbe, type LayoutResult, layoutVerdict } from "../src/core/workflows/layout-check.js";
import { type Check, type LayoutCheck, PolicySchema, repairLayoutCriteria, type RunPolicy, type Spec, SpecSchema } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// The broader option of #1247 (#1262). zoneslot-update 129e4cd7 AC-008 asked a person to measure
// the zone page at 1280 px; the orchestrator read document scrollWidth 1265 equal to clientWidth.
// With the policy's layoutCheck the host serves the app, reads the same numbers in a headless
// browser and records them as the criterion's evidence, so no person is asked.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = "Add the slot count to the zone page.";
const layout = { id: "AC-002", requirementIds: ["FR-002"], given: "the zone page", when: "it is opened in a 1280 px wide viewport", then: "the page has no horizontal scrolling outside the slot grid", method: "manual" as const };
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Slot count", problem: "The count is missing", outcome: "The page shows the count", inScope: ["Show the count"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The page shows the slot count", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "The page fits a 1280 px viewport", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a zone", when: "the page renders", then: "page.html shows the slot count", method: "automated" }, layout], dependencies: [] };
const markdown = "# Plan\n## Context\nOne page.\n## Decisions\nDEC-001: FR-001 adds the count.\n## Components\npage.html\n## Data\nText\n## Verification\nThe page check\n## Risks\nNone for fixture";
const check: Check = { id: "page", executable: "bun", args: ["-e", "if (!(await Bun.file('page.html').text()).includes('slots')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const layoutCheck: LayoutCheck = { start: { executable: "bun", args: ["serve.ts"], cwd: ".", envNames: [] }, url: "http://127.0.0.1:4173", pages: ["/"], width: 1280, height: 800, timeoutMs: 30000 };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [check], layoutCheck };

const measured = (scrollWidth: number): LayoutResult => ({ status: "measured", width: 1280, height: 800, pages: [{ path: "/", httpStatus: 200, scrollWidth, clientWidth: 1265, overflowing: scrollWidth > 1265 ? [{ element: "table.slots", right: scrollWidth }] : [] }], screenshot: "iVBORw0KGgo=" });

class FakeProbe implements LayoutProbe {
  calls: LayoutCheck[] = [];
  constructor(private result: LayoutResult) {}
  async measure(_workspace: string, check: LayoutCheck) {
    this.calls.push(check);
    return this.result;
  }
}

class ScriptedExecutor implements AgentExecutor {
  service?: NativeWorkflowService;
  runId = "";
  constructor(private root: string) {}
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
        // Reading files proves the count; no agent of the run can observe the page in a browser.
        const coverage = this.spec().criteria.map((c) => c.method === "post-release" ? { criterionId: c.id, verdict: "deferred", evidenceIds: [], explanation: "After release" } : c.method === "manual" ? { criterionId: c.id, verdict: "inconclusive", evidenceIds: [], explanation: "Needs a browser" } : { criterionId: c.id, verdict: "pass", evidenceIds: evidence, explanation: "The page shows it" });
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(runPolicy: RunPolicy, probe: FakeProbe) {
  const root = mkdtempSync(join(tmpdir(), "baked-layout-check-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: runPolicy } };
  const executor = new ScriptedExecutor(root);
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  service.scheduler.layoutProbe = probe;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy: runPolicy });
  executor.service = service;
  executor.runId = run.runId;
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const manual = service.store.requests(run.runId).filter((r) => r.kind === "manual_evidence");
  return { done, service, runId: run.runId, manual };
}

describe("scenario: zoneslot-update 129e4cd7 AC-008 with a layout check (#1262)", () => {
  test("a page that fits settles the criterion without asking a person", async () => {
    const probe = new FakeProbe(measured(1265));
    const { done, service, runId, manual } = await runScenario(policy, probe);
    expect(manual).toEqual([]);
    expect(done.status).toBe("completed");
    expect(probe.calls).toEqual([layoutCheck]);
    const stored = service.store.latestArtifact(runId, "spec.json");
    expect(SpecSchema.parse(JSON.parse(service.store.readArtifact(runId, stored?.id ?? ""))).criteria.find((c) => c.id === "AC-002")?.method).toBe("manual");
    const record = service.store.artifacts(runId).find((a) => a.logical_path.startsWith("layout/") && a.logical_path.endsWith(".json"));
    expect(JSON.parse(service.store.readArtifact(runId, record?.id ?? ""))).toMatchObject({ criteria: ["AC-002"], passed: true, measurement: { pages: [{ path: "/", scrollWidth: 1265, clientWidth: 1265 }] } });
    expect(service.store.artifacts(runId).some((a) => a.logical_path.endsWith(".png.b64"))).toBe(true);
  }, 60000);

  test("a page wider than the viewport goes to a person with the measurement", async () => {
    const { done, manual } = await runScenario(policy, new FakeProbe(measured(1540)));
    expect(done.reason).toBe("manual_evidence");
    expect(manual).toHaveLength(1);
    expect(JSON.parse(manual[0]?.body_json ?? "{}")).toMatchObject({ criterionId: "AC-002", layoutCheck: { passed: false, reason: "/ is 1540 px wide in a 1265 px viewport (widest: table.slots to 1540 px)" } });
  }, 60000);

  test("without the layout check a person is asked as before", async () => {
    const { layoutCheck: _, ...plain } = policy;
    const probe = new FakeProbe(measured(1265));
    const { manual } = await runScenario({ ...plain, clarification: "assume" }, probe);
    // Without layoutCheck the #1247 repair defers the criterion; no measurement runs either way.
    expect(probe.calls).toEqual([]);
    expect(manual).toEqual([]);
  }, 60000);
});

describe("the layout check", () => {
  test("keeps or makes a layout criterion manual so the host measures it", () => {
    const automated = { ...spec, criteria: [spec.criteria[0]!, { ...layout, method: "automated" as const }] };
    expect(repairLayoutCriteria(automated, { measured: true })).toMatchObject({ repaired: ["AC-002"], method: "manual" });
    expect(repairLayoutCriteria(automated, { measured: true }).spec.criteria[1]?.method).toBe("manual");
    expect(repairLayoutCriteria(spec, { measured: true }).repaired).toEqual([]);
  });
  test("accepts only loopback addresses and page paths", () => {
    const parse = (patch: Partial<LayoutCheck>) => PolicySchema.safeParse({ ...policy, layoutCheck: { ...layoutCheck, ...patch } }).success;
    expect(parse({})).toBe(true);
    expect(parse({ url: "http://localhost:3000/app" })).toBe(true);
    expect(parse({ url: "https://example.com" })).toBe(false);
    expect(parse({ url: "http://10.0.0.5:80" })).toBe(false);
    expect(parse({ pages: ["about"] })).toBe(false);
  });
  test("an unavailable browser or an error page does not pass", () => {
    expect(layoutVerdict({ status: "unavailable", reason: "missing dependency: install playwright" })).toEqual({ passed: false, reason: "missing dependency: install playwright" });
    const error = measured(1265);
    if (error.status === "measured" && error.pages[0]) error.pages[0].httpStatus = 404;
    expect(layoutVerdict(error).passed).toBe(false);
  });
});
