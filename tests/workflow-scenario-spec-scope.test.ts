import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { contradictoryScope, domainExclusions, inventedBounds, narrowingBounds, type RunPolicy, type Spec, specCoverageProblems } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 22 (#1120, split out of #1113). cfgtrace b4dc83b2 listed a CI workflow in inScope and
// kept it in outOfScope; analysis returned the spec for it three times, implement started with the
// finding open, and review raised it against spec.json at the end, so the run blocked
// `input_changed` after 5.84M tokens. keeplint ada519a3 wrote 50 files and 4,096 characters as
// bounds against the brief's non-narrowing rule, raised by analysis on its fourth return.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const requirement = (id: string, text: string) => ({ id, text, priority: "must" as const, verification: "automated" as const, sourceRefs: [] });
const criterion = (id: string, requirementIds: string[], then: string) => ({ id, requirementIds, given: "the workspace", when: "the task completes", then, method: "automated" as const });
const fixed: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value", "Add a GitHub Actions CI workflow that runs the checks"], outOfScope: ["Release automation"], assumptions: [], openQuestions: [], requirements: [requirement("FR-001", "value.txt holds ready")], criteria: [criterion("AC-001", ["FR-001"], "value.txt holds ready")], dependencies: [] };

describe("deterministic scope checks at spec acceptance (#1120)", () => {
  test("an outOfScope line that excludes what an inScope line includes", () => {
    expect(contradictoryScope({ ...fixed, outOfScope: ["CI workflows", "Release automation"] })).toEqual(["CI workflows"]);
    expect(contradictoryScope({ ...fixed, outOfScope: ["Values to create"] })).toEqual(["Values to create"]);
    // Narrower exclusions that add a word of their own are not contradictions.
    expect(contradictoryScope({ ...fixed, outOfScope: ["CI on macOS", "Deploy workflow", "Release automation"] })).toEqual([]);
  });

  test("numeric bounds as exclusions only when the request calls limits non-narrowing", () => {
    const bounded: Spec = {
      ...fixed,
      outOfScope: ["Inputs with more than 50 files", "Release automation"],
      criteria: [
        ...fixed.criteria,
        criterion("AC-002", ["FR-001"], "lines up to 4,096 characters are linted; longer lines are outside the checked domain"),
        criterion("AC-003", ["FR-001"], "a 10,000-line file is linted"),
      ],
    };
    const request = "Lint the files. Any limit you need is a non-narrowing assumption.";
    expect(narrowingBounds(bounded, request)).toEqual({ outOfScope: ["Inputs with more than 50 files"], criteria: ["AC-002"] });
    expect(narrowingBounds(bounded, "Lint the files.")).toEqual({ outOfScope: [], criteria: [] });
  });

  test("a contradictory spec goes back to the spec author before the planner sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-scope-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor({ ...fixed, outOfScope: ["CI workflows", "Inputs with more than 50 files"] });
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const prompt = "Create ready value with a CI workflow. Any limit you need is a non-narrowing assumption.";
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const errors = executor.specErrors[0]?.join("\n") ?? "";
    expect(errors).toContain('outOfScope line "CI workflows" excludes what inScope includes');
    expect(errors).toContain('outOfScope line "Inputs with more than 50 files" states a numeric bound');
    expect(service.store.state(run.runId).spec?.outOfScope).toEqual(["Release automation"]);
  });
});

// Bench round 24 (#1161). stmtsplit-update cae4291d ended the Given of AC-001 to AC-004 with
// "...; larger inputs are outside this criterion's checked domain", which the request never stated,
// and analysis returned no finding; cfgtrace a657dc4d needed three analyze returns for the same shape.
describe("domain exclusions in a criterion at spec acceptance (#1161)", () => {
  const given = (id: string, text: string) => ({ ...criterion(id, ["FR-001"], "the statements are split"), given: text });
  const excluded: Spec = {
    ...fixed,
    criteria: [
      ...fixed.criteria,
      given("AC-002", "a script with up to 100 statements; larger inputs are outside this criterion's checked domain"),
      given("AC-003", "a call with up to 20 arguments; more arguments are not covered"),
      given("AC-004", "a script of 5,000 statements"),
    ],
  };

  test("are found whatever the request says about limits, unless the request sets the bound", () => {
    expect(domainExclusions(excluded, "Split the statements of a script.")).toEqual(["AC-002", "AC-003"]);
    expect(domainExclusions(excluded, "Split scripts of up to 100 statements.")).toEqual(["AC-003"]);
  });

  test("send the spec back to its author before the planner sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-domain-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor(excluded);
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value with a CI workflow.", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const errors = executor.specErrors[0] ?? [];
    expect(errors.filter((e) => e.includes("with a domain exclusion the request does not state")).map((e) => e.split(" ")[1])).toEqual(["AC-002", "AC-003"]);
    // The request names CI, so the host adds its cross-platform criterion after the author's (#1943).
    expect(service.store.state(run.runId).spec?.criteria.map((c) => [c.id, c.method])).toEqual([
      ["AC-001", "automated"],
      ["AC-002", "post-release"],
    ]);
  });
});

// Bench round 27 (#1227). expenses-py 617fef26 wrote "up to 100,000 rows", "source lines up to
// 1 MiB" and "files up to 100 MiB" into criteria for a brief that names no size; reviewers tested
// those extremes, three correctives (1.63M tokens) chased them and the run blocked no_progress.
describe("size bounds a criterion invents at spec acceptance (#1227)", () => {
  const given = (id: string, text: string) => ({ ...criterion(id, ["FR-001"], "the expenses are summarized"), given: text });
  const bounded: Spec = {
    ...fixed,
    criteria: [
      ...fixed.criteria,
      given("AC-002", "a CSV of up to 100,000 rows whose source lines are up to 1 MiB"),
      given("AC-003", "an input file up to 100 MiB"),
      given("AC-004", "a category name of 1 through 256 characters"),
      given("AC-005", "a CSV with 3 rows"),
      given("AC-006", "files up to 10 MB"),
    ],
  };

  test("are found unless the request names the number", () => {
    expect(inventedBounds(bounded, "Summarize the expenses in a CSV file.")).toEqual(["AC-002", "AC-003", "AC-004", "AC-006"]);
    expect(inventedBounds(bounded, "Summarize the expenses. Accept files up to 10 MB.")).toEqual(["AC-002", "AC-003", "AC-004"]);
  });

  // Audit of 2026-10-17 (#1413): a request that says "10k rows" states the 10,000 rows a criterion names.
  test("read a thousands or millions suffix in the request as its number", () => {
    const rows: Spec = { ...fixed, criteria: [...fixed.criteria, given("AC-002", "a CSV of up to 10,000 rows"), given("AC-003", "up to 2,000,000 lines")] };
    expect(inventedBounds(rows, "Summarize the expenses; it handles 10k rows and 2M lines.")).toEqual([]);
    expect(inventedBounds(rows, "Summarize the expenses; it handles 10 rows.")).toEqual(["AC-002", "AC-003"]);
    expect(domainExclusions({ criteria: [given("AC-002", "up to 10,000 rows; larger inputs are outside this criterion's checked domain")] }, "It handles 10k rows.")).toEqual([]);
  });

  // Audit of 2026-10-17 (#1413): the spec asked for the largest input and a person answered; the
  // next spec states that bound, which the check must not send back as invented.
  test("a bound a person gave in a clarification answer is stated, not invented", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-answered-bound-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const asking: Spec = { ...fixed, openQuestions: [{ id: "Q-1", question: "What is the largest input file?", blocking: true }] };
    const answered: Spec = { ...fixed, criteria: [...fixed.criteria, given("AC-003", "an input file up to 100 MiB")] };
    const executor = new SpecExecutor(asking, answered);
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Summarize the expenses in a CSV file.", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    const current = service.store.run(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: request?.id ?? "", answers: { "Q-1": "Files up to 100 MiB" } });
    await service.drive(run.runId, new AbortController().signal);
    expect(executor.specErrors.length).toBeGreaterThan(1);
    expect(executor.specErrors.at(-1)?.filter((e) => e.includes("states a size or count bound"))).toEqual([]);
    expect(service.store.state(run.runId).spec?.criteria.map((c) => c.id)).toEqual(["AC-001", "AC-003"]);
  });

  test("send the spec back to its author before the planner sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-bounds-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor(bounded);
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Summarize the expenses in a CSV file.", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const errors = executor.specErrors[0] ?? [];
    expect(errors.filter((e) => e.includes("states a size or count bound")).map((e) => e.split(" ")[1])).toEqual(["AC-002", "AC-003", "AC-004", "AC-006"]);
    expect(service.store.state(run.runId).spec?.criteria.map((c) => c.id)).toEqual(["AC-001"]);
  });
});

describe("a blocking spec finding that survives the last analysis return (#1120)", () => {
  test("is settled by a spec amendment that every later agent reads", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const finding = { id: "F-001", kind: "scope", refs: ["spec.json", "AC-001"], description: "outOfScope still lists the CI workflow that the request does not ask to exclude", blocking: true };
    let analyses = 0;
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        analyses += 1;
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [finding] }, inputTokens: 25, outputTokens: 25 };
      }
      return original(request);
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(analyses).toBeGreaterThanOrEqual(2);
    const amendment = service.store.latestArtifact(run.runId, "amendments/analysis-F-001.json");
    expect(amendment).toBeTruthy();
    expect(JSON.parse(service.store.readArtifact(run.runId, amendment?.id ?? ""))).toMatchObject({ authority: "request", source: "analysis", criterionIds: ["AC-001"] });
    const note = "analysis found that the approved spec still disagrees with the request after its last revision";
    expect(executor.prompts.implementation?.at(-1)).toContain(note);
    expect(executor.prompts.review?.at(-1) ?? executor.prompts.convergence?.at(-1)).toContain(note);
  });

  test("a finding about the plan or tasks records no amendment", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const finding = { id: "F-001", kind: "scope", refs: ["plan.md", "T001"], description: "T001 restricts value.txt to one line, which the request does not ask for", blocking: true };
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [finding] }, inputTokens: 25, outputTokens: 25 };
      }
      return original(request);
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    expect(service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("amendments/"))).toEqual([]);
  });
});

class SpecExecutor implements AgentExecutor {
  specErrors: string[][] = [];
  private specs = 0;
  constructor(
    private first: Spec,
    private later: Spec = first,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
        break;
      case "spec": {
        output = this.specs++ ? this.later : this.first;
        const errors = request.validate?.(output) ?? [];
        this.specErrors.push(errors);
        if (errors.length) output = fixed;
        break;
      }
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixed), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

// Bench rounds 41 to 43 (#1520): the spec-author profile told the author to write a criterion's
// input domain into the criterion ("amounts up to 1e9 with two decimals") and to say that larger
// inputs are outside the checked domain; domainExclusions and inventedBounds send exactly that
// back, so 28 first submissions were rejected and written again (about 30k tokens each).
describe("the spec author's instructions agree with the spec checks (#1520)", () => {
  const instructions = builtinProfiles.find((p) => p.id === "spec-author")?.instructions ?? "";
  const request = "Summarize the expenses in a CSV file.";

  test("the instructions never ask for a domain exclusion or a bound in a criterion", () => {
    expect(instructions).not.toContain("outside the checked domain");
    expect(instructions).not.toMatch(/state its input domain in the criterion/);
  });

  test("a spec written the way the instructions prescribe passes the checks", () => {
    const assumption = instructions.match(/"(Amounts Assumed: [^"]+)"/)?.[1] ?? "";
    expect(assumption).toContain("1e9");
    const spec: Spec = {
      ...fixed,
      inScope: ["Summarize expenses"],
      assumptions: [assumption],
      criteria: [
        criterion("AC-001", ["FR-001"], "the summary prints the total of the amounts with two decimals"),
        // The instructions' other examples the checks read: a CI matrix and a layout outcome.
        criterion("AC-002", ["FR-001"], "a CI workflow file runs the checks on a matrix of ubuntu-latest, macos-latest, windows-latest"),
        { ...criterion("AC-003", ["FR-001"], "the pages fit a 1280 px wide viewport without horizontal scrolling"), method: "post-release" },
      ],
    };
    expect(specCoverageProblems(spec, undefined, { request })).toEqual([]);
  });

  test("the domain the old instructions prescribed is sent back", () => {
    const spec: Spec = {
      ...fixed,
      criteria: [
        criterion("AC-001", ["FR-001"], "amounts up to 1e9 with two decimals are summed; inputs beyond it are outside the checked domain"),
        criterion("AC-002", ["FR-001"], "files of up to 100,000 rows are summarized"),
      ],
    };
    expect(domainExclusions(spec, request)).toEqual(["AC-001"]);
    expect(inventedBounds(spec, request)).toEqual(["AC-002"]);
  });
});
