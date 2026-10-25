import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { hostSettledOmission, OMITTED_DEFERRED } from "../src/core/verification/review.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { type Check, type Review, type RunPolicy, type Spec, SpecSchema } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// Scenario of bench round 69 (#2190). commitbump-update 0894df2d (claude-code, Opus reviewer):
// every task verified, the tree matched the reference, and the convergence reviewer answered
// pass with AC-001 to AC-008 covered but left out AC-009, the host-written post-release
// criterion the approval had deferred. The converge stage listed it inconclusive, set
// changes_requested with no finding, and the run stopped invalid_output twice (125k tokens, two
// interventions). A criterion the host settles itself is now deferred when the reviewer omits it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Method = Spec["criteria"][number]["method"];
const REQUEST = "Add the bump command to the CLI.";
const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 adds the command.\n## Components\nbump.txt\n## Data\nText\n## Verification\nThe bump check\n## Risks\nNone for fixture";
const check: Check = { id: "bump", executable: "bun", args: ["-e", "if (!(await Bun.file('bump.txt').text()).includes('bumped')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [check] };

function specWith(method: Method): Spec {
  return {
    schemaVersion: 1, featureId: "fixture", revision: 1, title: "Bump", problem: "No bump command", outcome: "The CLI bumps", inScope: ["Bump"], outOfScope: [], assumptions: [], openQuestions: [],
    requirements: [
      { id: "FR-001", text: "The CLI bumps the version", priority: "must", verification: "automated", sourceRefs: [] },
      { id: "NFR-001", text: "The tests pass on every supported system", priority: "must", verification: method, sourceRefs: [] },
    ],
    criteria: [
      { id: "AC-001", requirementIds: ["FR-001"], given: "a project", when: "bump runs", then: "bump.txt says bumped", method: "automated" },
      { id: "AC-002", requirementIds: ["NFR-001"], given: "the delivered revision", when: "a maintainer runs the tests on another system after the run", then: "the tests pass there", method },
    ],
    dependencies: [],
  };
}

class ScriptedExecutor implements AgentExecutor {
  service?: NativeWorkflowService;
  runId = "";
  converges = 0;
  constructor(private root: string, private authored: Spec, private omit: (call: number) => string[]) {}
  private spec(): Spec {
    const stored = this.service?.store.latestArtifact(this.runId, "spec.json");
    return SpecSchema.parse(JSON.parse(this.service?.store.readArtifact(this.runId, stored?.id ?? "") ?? "{}"));
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["bump.txt"] }; break;
      case "spec": output = this.authored; break;
      case "plan": {
        const current = this.spec();
        const criteria = current.criteria.filter((c) => c.method === "automated").map((c) => c.id);
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(current), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Bump", description: "Write bump.txt", requirementIds: ["FR-001", "NFR-001"], criterionIds: criteria, dependsOn: [], profileId: "implementer", writes: [{ path: "bump.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        writeFileSync(join(this.root, "bump.txt"), "bumped\n");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote bump.txt", evidenceIds: [], unresolved: [] };
        break;
      case "review":
      case "convergence": {
        const omitted = request.profile.output === "convergence" ? this.omit(this.converges++) : [];
        // The dimension reviewers cover every criterion; the convergence reviewer of the scenario
        // leaves some out of an otherwise passing answer.
        const coverage = this.spec().criteria
          .filter((c) => !omitted.includes(c.id))
          .map((c) => c.method === "automated" ? { criterionId: c.id, verdict: "pass", evidenceIds: evidence, explanation: "bump.txt says bumped" } : { criterionId: c.id, verdict: "deferred", evidenceIds: [], explanation: "After the run" });
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage, findings: [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function scenario(method: Method, omit: (call: number) => string[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-converge-omit-"));
  cleanups.push(() => removeTempDir(root));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const executor = new ScriptedExecutor(root, specWith(method), omit);
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
  const state = service.store.state(run.runId);
  return {
    done,
    executor,
    errors: errors.map((e) => service.store.readArtifact(run.runId, e.id)).join("\n"),
    convergence: state.convergence as Review | null,
    requests: service.store.requests(run.runId),
    tasks: state.graph?.tasks ?? [],
  };
}

describe("scenario: commitbump-update 0894df2d, a convergence report that leaves out a criterion (#2190)", () => {
  test("an omitted post-release criterion the approval deferred is deferred, and the run completes", async () => {
    const { done, errors, convergence } = await scenario("post-release", () => ["AC-002"]);
    expect(errors).toBe("");
    expect(done.status).toBe("completed");
    expect(convergence?.verdict).toBe("pass");
    expect(convergence?.findings).toEqual([]);
    expect(convergence?.coverage.find((c) => c.criterionId === "AC-002")).toMatchObject({ verdict: "deferred", explanation: OMITTED_DEFERRED["post-release"] });
  }, 60_000);

  test("an omitted manual criterion is deferred and the run asks a person for its evidence", async () => {
    const { done, errors, convergence, requests } = await scenario("manual", () => ["AC-002"]);
    expect(errors).toBe("");
    expect(done).toMatchObject({ status: "waiting", reason: "manual_evidence" });
    expect(requests.filter((r) => r.kind === "manual_evidence" && r.status === "pending")).toHaveLength(1);
    expect(convergence?.coverage.find((c) => c.criterionId === "AC-002")).toMatchObject({ verdict: "deferred", explanation: OMITTED_DEFERRED.manual });
  }, 60_000);

  test("an omitted automated criterion still gets its missing finding and a corrective", async () => {
    // The fixture's corrective rewrites the same file, so how the run ends is not the point here.
    const { errors, tasks } = await scenario("post-release", (call) => (call === 0 ? ["AC-001"] : []));
    expect(errors).not.toContain("without an actionable finding");
    expect(tasks.filter((t) => t.origin !== "planned").map((t) => t.criterionIds)).toEqual([["AC-001"]]);
  }, 60_000);
});

describe("hostSettledOmission", () => {
  const criterion = (method: Method) => ({ ...specWith(method).criteria[1]! });
  test("settles a manual criterion and a deferred post-release one, never an automated one", () => {
    expect(hostSettledOmission(criterion("manual"), [])).toBe(true);
    expect(hostSettledOmission(criterion("post-release"), ["AC-002"])).toBe(true);
    expect(hostSettledOmission(criterion("post-release"), [])).toBe(false);
    expect(hostSettledOmission(criterion("automated"), ["AC-002"])).toBe(false);
  });
});
