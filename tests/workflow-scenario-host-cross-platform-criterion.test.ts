import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { crossPlatformAnalysisNote, crossPlatformNote } from "../src/core/workflows/cross-platform.js";
import {
  addHostRequiredCriteria,
  CROSS_PLATFORM_CRITERION,
  HOST_REQUIRED_ANALYSIS_RULE,
  HOST_REQUIRED_CRITERIA,
  hostWrittenIds,
} from "../src/core/workflows/host-required-criteria.js";
import { hostBoundCriteria, repairHostBoundCriteria, type Spec, validateSpecCoverage } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench rounds 60 and 61 (#1943). In every sdd update of a project with a CI workflow (taskplan,
// Java; tplfill and sketchfold, Rust) the spec author was asked to write the criterion that the
// product's tests pass on Windows, macOS and Linux. It left it out, analysis blocked the spec for
// it, and specify, plan and analyze ran again (78k to 157k tokens). In taskplan the rewrite was an
// automated criterion that "each corresponding CI job provides evidence that all 284 project tests
// pass"; it named .github/workflows/ci.yml, so the host-bound repair skipped it, and convergence
// stopped no_progress on evidence no check of the run produces. The host now writes the criterion.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REQUEST = "Update the parser so blank lines are kept. Keep the existing tests passing.";
const CI_YAML = "name: ci\non: [push]\njobs:\n  test:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest, windows-latest]\n    runs-on: ${{ matrix.os }}\n";
/** The projects of the issue: one manifest each, and the CI workflow that makes the criterion required. */
const projects = [
  { language: "java", files: { "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n", "src/main/java/app/Parser.java": "package app;\n\nclass Parser {}\n" } },
  { language: "rust", files: { "Cargo.toml": '[package]\nname = "tplfill"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn parse() {}\n" } },
  { language: "go", files: { "go.mod": "module example.com/taskplan\n\ngo 1.22\n", "parser.go": "package taskplan\n" } },
] as const;

/** taskplan's AC-006 after the author's rewrite (run d585a257), with the fixture's requirement. */
const TASKPLAN_AC006: Spec["criteria"][number] = {
  id: "AC-002",
  requirementIds: ["FR-001"],
  given: "the delivered revision and the existing .github/workflows/ci.yml matrix on ubuntu-latest, macos-latest and windows-latest",
  when: "the CI workflow runs",
  then: "each corresponding CI job provides evidence that all 284 project tests pass; unavailable CI results are reported as missing evidence, not a pass",
  method: "automated",
};
const required = HOST_REQUIRED_CRITERIA.filter((c) => c.written);

describe("the host writes the cross-platform criterion (#1943)", () => {
  test("a spec without it gets a post-release criterion and a requirement of its own, once", () => {
    const { spec, added } = addHostRequiredCriteria(fixtureSpec, required);
    expect(added).toEqual(["NFR-001", "AC-002"]);
    expect(spec.requirements.at(-1)).toMatchObject({ id: "NFR-001", verification: "post-release", priority: "must" });
    expect(spec.criteria.at(-1)).toMatchObject({ id: "AC-002", requirementIds: ["NFR-001"], method: "post-release" });
    expect(validateSpecCoverage(spec)).toEqual([]);
    expect(CROSS_PLATFORM_CRITERION.matches(`${spec.criteria.at(-1)?.when}`)).toBe(true);
    expect(addHostRequiredCriteria(spec, required).added).toEqual([]);
    expect([...hostWrittenIds(spec, required)].sort()).toEqual(["AC-002", "NFR-001"]);
    expect(addHostRequiredCriteria(fixtureSpec, []).added).toEqual([]);
  });

  test("an author's post-release criterion on the three systems counts, and nothing is added", () => {
    const own: Spec = { ...fixtureSpec, criteria: [...fixtureSpec.criteria, { ...TASKPLAN_AC006, method: "post-release" }] };
    expect(addHostRequiredCriteria(own, required).added).toEqual([]);
  });

  test("an automated criterion that names the workflow file but asks for the CI jobs' results is repaired to post-release", () => {
    const spec: Spec = { ...fixtureSpec, criteria: [...fixtureSpec.criteria, TASKPLAN_AC006] };
    expect(hostBoundCriteria(spec)).toEqual(["AC-002"]);
    const repaired = repairHostBoundCriteria(spec).spec;
    expect(repaired.criteria.find((c) => c.id === "AC-002")?.method).toBe("post-release");
    // Then the host has nothing to add.
    expect(addHostRequiredCriteria(repaired, required).added).toEqual([]);
  });

  test("a criterion that reads the workflow file's matrix stays automated", () => {
    const reading: Spec["criteria"][number] = {
      ...TASKPLAN_AC006,
      given: "the repository",
      when: "the reviewer reads .github/workflows/ci.yml",
      then: "its matrix lists ubuntu-latest, macos-latest and windows-latest and runs-on uses it",
    };
    expect(hostBoundCriteria({ ...fixtureSpec, criteria: [...fixtureSpec.criteria, reading] })).toEqual([]);
  });

  test("the author is told the host writes it, and the reviewer that it is never a finding", () => {
    const ci = "Keep the existing tests passing. The project's CI runs on three operating systems.";
    expect(crossPlatformNote(ci, "/nonexistent")).toContain("the host adds a post-release criterion");
    expect(crossPlatformNote(ci, "/nonexistent")).toContain("do not write one");
    expect(crossPlatformAnalysisNote(ci, "/nonexistent")).toContain("writes it itself after specify");
    expect(HOST_REQUIRED_ANALYSIS_RULE).toContain("the host writes it after specify, method post-release");
  });

  async function scenario(files: Record<string, string>, prompt = REQUEST, authored: Spec = fixtureSpec) {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(fixture.root, path, ".."), { recursive: true });
      writeFileSync(join(fixture.root, path), text);
    }
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    let runId = "";
    let analyses = 0;
    let specs = 0;
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") {
        specs++;
        return { output: authored, inputTokens: 25, outputTokens: 25 };
      }
      if (request.profile.output === "analysis") {
        analyses++;
        // The R61 reviewer: a spec without a criterion on all three systems is blocked.
        const spec = service.store.state(runId).spec as Spec;
        const three = spec.criteria.some((c) => [/windows/, /macos/, /linux|ubuntu/].every((os) => os.test(`${c.given} ${c.when} ${c.then}`.toLowerCase())));
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: three ? "pass" : "needs_revision",
            findings: three ? [] : [{ id: "F-001", kind: "coverage", refs: ["spec.json"], description: "The required cross-platform passing-tests criterion is missing.", blocking: true }],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string } };
        plan.taskGraph.specHash = service.store.state(runId).manifest.specHash ?? "";
        plan.taskGraph.planHash = hashBytes(plan.markdown);
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: fixture.policy });
    runId = run.runId;
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    const repair = service.store.latestArtifact(run.runId, "spec-repairs/host-required.json");
    return {
      snapshot,
      analyses,
      specs,
      spec: service.store.state(run.runId).spec as Spec,
      added: repair ? (JSON.parse(service.store.readArtifact(run.runId, repair.id)) as { added: string[] }).added : null,
    };
  }

  for (const project of projects)
    test(`${project.language} update with a CI workflow: one specify and one analysis, with the host's criterion`, async () => {
      const { snapshot, analyses, specs, spec, added } = await scenario({ ...project.files, ".github/workflows/ci.yml": CI_YAML });
      expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
      expect(specs).toBe(1);
      expect(analyses).toBe(1);
      expect(added).toEqual(["NFR-001", "AC-002"]);
      expect(spec.criteria.find((c) => c.id === "AC-002")).toMatchObject({ method: "post-release", requirementIds: ["NFR-001"] });
    }, 60_000);

  test("taskplan's automated CI-results criterion becomes post-release, and the host adds no second one", async () => {
    const authored: Spec = { ...fixtureSpec, criteria: [...fixtureSpec.criteria, TASKPLAN_AC006] };
    const { snapshot, analyses, spec, added } = await scenario({ ...projects[0].files, ".github/workflows/ci.yml": CI_YAML }, REQUEST, authored);
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(analyses).toBe(1);
    expect(added).toBeNull();
    expect(spec.criteria.find((c) => c.id === "AC-002")?.method).toBe("post-release");
    expect(spec.criteria.filter((c) => c.method === "post-release")).toHaveLength(1);
  }, 60_000);

  test("without CI, or when the request turns CI down, the host adds nothing", async () => {
    const plain = await scenario({ ...projects[1].files });
    expect(plain.added).toBeNull();
    expect(plain.spec.criteria).toHaveLength(fixtureSpec.criteria.length);
    const refused = await scenario({ ...projects[2].files, ".github/workflows/ci.yml": CI_YAML }, `${REQUEST} It must run on Windows and Linux. No CI workflow is wanted.`);
    expect(refused.added).toBeNull();
  }, 60_000);
});
