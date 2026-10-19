import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { requestedWrittenTests } from "../src/core/workflows/agent-executor.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 37 (#1373). md-site T008 and ranktally T011: a correction may write the
// files of every related planned task, the sibling test files included, so its tests-written
// check ran 8 to 10 test files. A sibling's test that failed on its own defect failed the
// correction, which opened a correction of itself (md-site T009, 4.31M tokens, 58% of the run).
// Here T002's render test fails on a defect in src/slug.ts and T003's slug test fails on its own
// wrong expectation. The correction of T002 may write tests/slug.test.ts too, but its check runs
// only the test its finding points at.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const RENDER_TEST = `import { expect, test } from "bun:test";
import { render } from "../src/render.ts";
test("render lowercases headings", () => { expect(render("A")).toBe("a"); });
`;
const SLUG_TEST = (expected: string) => `import { expect, test } from "bun:test";
import { slug } from "../src/slug.ts";
test("slug keeps plain words", () => { expect(slug("b")).toBe("${expected}"); });
`;

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Site", problem: "Headings are wrong", outcome: "Headings render", inScope: ["Render headings"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Headings render", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a heading", when: "it is rendered", then: "it is lowercase", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA renderer, a slug helper and their tests.\n## Decisions\nDEC-001: FR-001 in the renderer.\n## Components\nsrc/render.ts, src/slug.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const planned = (id: string, paths: string[], dependsOn: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
// T002 asks for generated inputs: its finding is an assertion failure, not a timeout, so it does
// not get the note about keeping them within the check's timeout.
const tasks = [planned("T001", ["src/render.ts", "src/slug.ts"]), { ...planned("T002", ["tests/render.test.ts"], ["T001"]), description: "Write tests/render.test.ts with at least 3 generated inputs" }, planned("T003", ["tests/slug.test.ts"], ["T001"])];
const tests: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 15000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, checks: [tests] };

class ScriptedExecutor implements AgentExecutor {
  corrections: { writes: string[]; written: string[] }[] = [];
  constructor(private root: string) {}
  private write(path: string, text: string) {
    mkdirSync(join(this.root, path, ".."), { recursive: true });
    writeFileSync(join(this.root, path), text);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/render.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        const writes = task.writes.map((w) => w.path);
        if (task.id === "T001") {
          this.write("src/render.ts", 'import { slug } from "./slug.ts";\nexport const render = (h: string) => slug(h);\n');
          this.write("src/slug.ts", "export const slug = (h: string) => h; // bug\n");
        } else if (task.id === "T002") this.write("tests/render.test.ts", RENDER_TEST);
        else if (task.id === "T003") this.write("tests/slug.test.ts", SLUG_TEST("c"));
        else {
          this.corrections.push({ writes: [...writes].sort(), written: (request.writtenTests ?? task.writes).map((w) => w.path).sort() });
          // The render test's correction fixes the slug; the slug test's correction fixes its
          // wrong expectation.
          if (writes.includes("tests/render.test.ts")) this.write("src/slug.ts", "export const slug = (h: string) => h.toLowerCase();\n");
          else this.write("tests/slug.test.ts", SLUG_TEST("b"));
        }
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: md-site T008, a correction's tests-written check (#1373)", () => {
  test("runs the tests its finding points at, not a sibling's failing test", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-correction-written-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Render lowercase headings", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    const runs = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("checks/tests-written/")).map((a) => (JSON.parse(service.store.readArtifact(run.runId, a.id)) as { definition: { args: string[] } }).definition.args);
    // Each test task continues once on its own assertion (#1518), then its repair runs before
    // the next test task (#1612). A repair checks only the test its finding points at.
    const render = ["test", "./tests/render.test.ts"];
    const slug = ["test", "./tests/slug.test.ts"];
    expect(runs).toEqual([render, render, render, slug, slug, slug]);
    expect(executor.corrections).toEqual([
      { writes: ["src/render.ts", "src/slug.ts", "tests/render.test.ts"], written: ["tests/render.test.ts"] },
      { writes: ["src/slug.ts", "tests/slug.test.ts"], written: ["tests/slug.test.ts"] },
    ]);
    const findings = service.store.findings(run.runId).map((f) => JSON.parse(f.body_json) as { claim: string; suggestedFix: string });
    expect(findings.map((f) => f.claim)).toEqual(["Task T002 required check tests-written failed", "Task T003 required check tests-written failed"]);
    expect(findings[0]?.suggestedFix).not.toContain("generated inputs");
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "src/slug.ts"), "utf8")).toContain("toLowerCase");
  }, 120000);
});

describe("requestedWrittenTests (#1421)", () => {
  const correction = { ...planned("T004", ["src/slug.ts", "tests/render.test.ts", "tests/slug.test.ts", "tests/regression.test.ts"]), origin: "repair" as const, findingIds: ["F1"] };
  const given = [{ path: "tests/render.test.ts", action: "create" as const }];
  test("adds the task's test files the attempt edited, which the host's check after it runs too", () => {
    expect(requestedWrittenTests(correction, given, new Set(["tests/regression.test.ts", "src/slug.ts", "tests/other.test.ts"])).map((w) => w.path)).toEqual(["tests/render.test.ts", "src/slug.ts", "tests/regression.test.ts"]);
  });
  test("keeps the given list without edits, and a planned task's writes without a list", () => {
    expect(requestedWrittenTests(correction, given, new Set()).map((w) => w.path)).toEqual(["tests/render.test.ts"]);
    expect(requestedWrittenTests(correction, undefined, new Set())).toEqual(correction.writes);
  });
});
