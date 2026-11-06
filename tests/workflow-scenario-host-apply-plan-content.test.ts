import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { HOST_PLAN_CONTENT_DIR, hostApplyInputs } from "../src/core/workflows/host-apply.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { planContentDrifts, suppliedDriftSummary } from "../src/core/workflows/supplied-drift.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2472, R79 trailspin-update (Go): the brief gave `internal/cli/summary_top_test.go` as a new
// file's `-U0` diff, the planner retyped it into T003's `content` with one extra blank line after
// `ties :=`, and the host wrote that copy with no session (`content-written`). `supplied_drift` read
// only host apply records and never compared it. Now the host compares a host-written task's plan
// content with the request's block before writing it: shadow records the drift, and under
// `hostApply: "on"` the host writes the request's bytes. One case per kind of block: a new file's
// diff (Go) and a whole fenced file (Scala, R78/R79 pairwick cli's verbatim `Main.scala`).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const GO_PATH = "internal/cli/summary_top_test.go";
const GO = [
  "package cli",
  "",
  'import "testing"',
  "",
  "func TestSummaryTopTies(t *testing.T) {",
  '\tties := []string{"a", "b"}',
  "\tif len(ties) != 2 {",
  '\t\tt.Fatalf("ties = %v", ties)',
  "\t}",
  "}",
  "",
].join("\n");
/** The planner's copy: one extra blank line after `ties :=`, still gofmt-clean. */
const GO_PLAN = GO.replace("ties := []string{\"a\", \"b\"}\n", "ties := []string{\"a\", \"b\"}\n\n");
const GO_DIFF = [
  `diff --git a/${GO_PATH} b/${GO_PATH}`,
  "new file mode 100644",
  "index 0000000..3b18e51",
  "--- /dev/null",
  `+++ b/${GO_PATH}`,
  `@@ -0,0 +1,${GO.split("\n").length - 1} @@`,
  ...GO.split("\n")
    .slice(0, -1)
    .map((line) => `+${line}`),
  "",
].join("\n");
const GO_BRIEF = `Add the test file exactly as this diff gives it:\n\n\`\`\`diff\n${GO_DIFF}\`\`\`\n`;

const SCALA_PATH = "src/main/scala/Main.scala";
const SCALA = ["object Main:", "  def main(args: Array[String]): Unit =", '    println("pairwick")', ""].join("\n");
const SCALA_PLAN = SCALA.replace('println("pairwick")', 'println( "pairwick" )');
const SCALA_BRIEF = `Create \`${SCALA_PATH}\` with exactly this content (the whole file):\n\n\`\`\`scala\n${SCALA}\`\`\`\n`;

/** A required check that passes: the plan approval needs one. */
const present: Check = { id: "present", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] };

const spec: Spec = { schemaVersion: 1, featureId: "cli", revision: 1, title: "CLI", problem: "No test", outcome: "A test", inScope: ["CLI"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The file exists", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the tree", when: "read", then: "the file is there", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nWrite the brief's file.\n## Decisions\nDEC-001: FR-001.\n## Components\nThe file\n## Data\nNone\n## Verification\nNone\n## Risks\nNone for fixture";

/** Plans one host-written task that carries `content` for `path`; no model session should run. */
class PlanContentExecutor implements AgentExecutor {
  implementations: string[] = [];
  constructor(
    private path: string,
    private content: string,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    const task: Task = { id: "T003", title: `write ${this.path}`, description: `write ${this.path} as the brief gives it`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: this.path, action: "create", content: this.content }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "cli", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        this.implementations.push(request.task?.id ?? "");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Nothing to do", evidenceIds: [], unresolved: [] };
        break;
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The file is there" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function scenario(brief: string, path: string, content: string, hostApply?: "on") {
  const root = mkdtempSync(join(tmpdir(), "baked-plan-content-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [present], ...(hostApply ? { hostApply } : {}) };
  const executor = new PlanContentExecutor(path, content);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "cli", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const stops = service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; mode: string; key: string; summary: string; inputs: Record<string, unknown> })
    .filter((p) => p.reason === "supplied_drift");
  const artifact = service.store.latestArtifact(run.runId, `${HOST_PLAN_CONTENT_DIR}T003.json`);
  const record = artifact ? (JSON.parse(service.store.readArtifact(run.runId, artifact.id)) as { mode: string; written: string[]; drifts: unknown[] }) : null;
  return { delivered: readFileSync(join(root, path), "utf8"), done, executor, stops, record };
}

describe("planContentDrifts: a host-written task's plan content against the request's block (#2472)", () => {
  test("R79 trailspin: the plan's copy of a new file's diff with one extra blank line is a moved hunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-plan-content-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const task = { id: "T003", writes: [{ path: GO_PATH, action: "create" as const, content: GO_PLAN }] };
    const inputs = await hostApplyInputs(root, GO_BRIEF, task);
    expect(inputs).toMatchObject([{ path: GO_PATH, diffs: 1, files: 0, exists: false, applies: true }]);
    const graph = { tasks: [{ ...task, origin: "planned" }] } as never;
    const [drift] = planContentDrifts(GO_BRIEF, task, inputs ?? [], graph);
    expect(drift).toMatchObject({ task: "T003", path: GO_PATH, block: "diff", hunk: 1, problem: "moved", line: 1 });
    expect(suppliedDriftSummary(drift!, "plan")).toBe(
      `T003's plan content for ${GO_PATH}, which the host writes with no session, does not hold the new lines of the request's verbatim diff (hunk 1) as consecutive lines from line 1. Under hostApply "on" the host writes the request's bytes instead.`,
    );
    const same = { id: "T003", writes: [{ path: GO_PATH, action: "create" as const, content: GO }] };
    expect(planContentDrifts(GO_BRIEF, same, inputs ?? [], graph)).toEqual([]);
  });
});

describe("scenario: a host-written task whose plan content leaves the request's verbatim block (#2472)", () => {
  test("Go create diff, shadow: supplied_drift is recorded from the plan's content, and the plan's copy is written", async () => {
    const { delivered, done, executor, stops, record } = await scenario(GO_BRIEF, GO_PATH, GO_PLAN);
    expect(executor.implementations).toEqual([]);
    expect(delivered).toBe(GO_PLAN);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ mode: "shadow", key: `T003#${GO_PATH}`, inputs: { task: "T003", path: GO_PATH, block: "diff", problem: "moved", source: "plan" } });
    expect(record).toMatchObject({ mode: "shadow", written: [] });
    expect(done.status).toBe("completed");
  });

  test("Go create diff, hostApply on: the host writes the request's bytes and records no drift", async () => {
    const { delivered, done, executor, stops, record } = await scenario(GO_BRIEF, GO_PATH, GO_PLAN, "on");
    expect(executor.implementations).toEqual([]);
    expect(delivered).toBe(GO);
    expect(stops).toEqual([]);
    expect(record).toMatchObject({ mode: "on", written: [GO_PATH] });
    expect(done.status).toBe("completed");
  });

  test("Scala whole file: shadow records the differing line, on writes the request's file", async () => {
    const shadow = await scenario(SCALA_BRIEF, SCALA_PATH, SCALA_PLAN);
    expect(shadow.delivered).toBe(SCALA_PLAN);
    expect(shadow.stops).toHaveLength(1);
    expect(shadow.stops[0]?.inputs).toMatchObject({ block: "file", problem: "differs", line: 3, expected: '    println("pairwick")', source: "plan" });
    const on = await scenario(SCALA_BRIEF, SCALA_PATH, SCALA_PLAN, "on");
    expect(on.delivered).toBe(SCALA);
    expect(on.stops).toEqual([]);
  });

  test("plan content that keeps the block records nothing, in either mode", async () => {
    for (const mode of [undefined, "on"] as const) {
      const { delivered, stops, record } = await scenario(GO_BRIEF, GO_PATH, GO, mode);
      expect(delivered).toBe(GO);
      expect(stops).toEqual([]);
      expect(record).toBeNull();
    }
  });
});
