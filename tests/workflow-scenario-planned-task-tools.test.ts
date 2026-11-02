import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { writesDocumentation } from "../src/core/verification/repro.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import { plannedTaskToolsRule, TASK_TOOLS, taskToolProblems, toolsOfferedTo } from "../src/core/workflows/task-tools.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 87, slackbar (feature run 0559fa3a, #2643): the spec author settled AC-009 (raw
// bytes [255] and a BOM on standard input) with "a non-persistent run_probe verification", and the
// planner wrote T005, a planned task writing src/main.ts, as "use the accepted non-persistent
// run_probe". The executor offers run_probe only to corrections and documentation tasks, so three
// implementer sessions (1,329,584 tokens) each reported "run_probe is not available in this
// environment" and the run blocked invalid_output, its message naming the `format` check.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const base = { requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", readHints: [], checkIds: [], findingIds: [], rationale: "Required behavior" };
const code = { origin: "planned" as const, writes: [{ path: "src/main.ts", action: "modify" as const }], findingIds: [] };
const docs = { origin: "planned" as const, writes: [{ path: "src/main.ts", action: "modify" as const }, { path: "README.md", action: "create" as const }], findingIds: [] };
const correction = { origin: "repair" as const, writes: code.writes, findingIds: [] };
const findingCorrection = { origin: "repair" as const, writes: code.writes, findingIds: ["F1"] };

describe("toolsOfferedTo (#2643)", () => {
  // The conditions the executor and the scheduler held inline before the table.
  const oldRunProbe = (t: typeof code | typeof correction) => t.origin !== "planned" || writesDocumentation(t.writes);
  const oldRunRepro = (t: typeof code | typeof correction) => !(t.origin === "planned" || !t.findingIds.length);

  test("grants match the executor's old conditions for planned code, planned docs, a correction and a correction with findings", () => {
    for (const task of [code, docs, correction, findingCorrection, { ...code, origin: "convergence" as const }]) {
      const offered = toolsOfferedTo(task);
      expect(offered.has("run_probe")).toBe(oldRunProbe(task));
      expect(offered.has("run_repro")).toBe(oldRunRepro(task));
      expect(offered.has("write_test")).toBe(false);
    }
    expect([...toolsOfferedTo(code)]).toEqual([]);
    expect([...toolsOfferedTo(docs)]).toEqual(["run_probe"]);
    expect([...toolsOfferedTo(findingCorrection)].sort()).toEqual(["run_probe", "run_repro"]);
    // A deleted README is no documentation task.
    expect(toolsOfferedTo({ ...code, writes: [{ path: "README.md", action: "delete" }] }).has("run_probe")).toBe(false);
  });

  test("the planning instructions list every tool a planned code task lacks, from the same table", () => {
    const rule = plannedTaskToolsRule();
    for (const row of TASK_TOOLS) expect(rule.includes(row.name)).toBe(!row.offered(code));
    expect(rule).toContain("a check the plan documents, or an open question");
    for (const id of ["planner", "quick-planner", "spec-author", "spec-reviewer"])
      expect(builtinProfiles.find((p) => p.id === id)?.instructions).toContain(rule);
  });

  test("a task whose text names a tool it will not be offered is a plan problem; a documentation task may name run_probe", () => {
    const t005 = { ...base, ...code, id: "T005", title: "Entry point", description: "Read standard input; for AC-009 use the accepted non-persistent run_probe." };
    const problems = taskToolProblems({ tasks: [t005] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Task T005 tells its implementer to use run_probe, which it will not be offered");
    expect(problems[0]).toContain("put the case it was for in a test row that starts the program, a check the plan documents, or an open question");
    expect(taskToolProblems({ tasks: [{ ...t005, ...docs }] })).toEqual([]);
    expect(taskToolProblems({ tasks: [{ ...t005, description: "Use run_repro after editing" }] })[0]).toContain("run_repro");
    // A word that only contains the name, or a plain "write tests", is not the tool.
    expect(taskToolProblems({ tasks: [{ ...t005, description: "Write tests; keep my_run_probes intact" }] })).toEqual([]);
  });
});

const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";

/** The R87 planner: its first draft tells the code task to use run_probe; it applies the remedy it is given. */
class ToolPlanExecutor extends FixtureExecutor {
  corrective: string[] = [];
  missingTool: string[] = [];
  instructions: Record<string, string> = {};
  constructor(private dir: string) {
    super(dir);
  }
  private plan(description: string) {
    const task: Task = { ...base, ...code, id: "T001", title: "Create value", description, writes: [{ path: "value.txt", action: "create" }] };
    const taskGraph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks: [task] };
    return { schemaVersion: 1, markdown, taskGraph };
  }
  override async execute(request: ExecutionRequest) {
    this.instructions[request.profile.output] = request.profile.instructions;
    if (request.profile.output === "plan") {
      let output = this.plan("Write ready; verify the raw bytes with the accepted non-persistent run_probe");
      const problems = request.validate?.(output) ?? [];
      this.corrective.push(...problems);
      if (problems.some((p) => p.includes("tells its implementer to use run_probe")))
        output = this.plan("Write ready; a test row that starts the program covers the raw bytes");
      expect(request.validate?.(output) ?? []).toEqual([]);
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") {
      const task = request.task;
      // The executor's grant as it was: a planned task that writes no documentation has no run_probe.
      if (task && /\brun_probe\b/.test(task.description) && task.origin === "planned" && !writesDocumentation(task.writes)) {
        this.missingTool.push(task.id);
        return { output: { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: "Cannot verify", evidenceIds: [], unresolved: ["run_probe is not available in this environment"] }, inputTokens: 25, outputTokens: 25 };
      }
      writeFileSync(join(this.dir, "value.txt"), "ready");
    }
    return super.execute(request);
  }
}

describe("scenario: R87 slackbar, a planned code task told to use run_probe (#2643)", () => {
  test("the plan is refused with the remedy, and the corrected plan runs without a missing tool", async () => {
    const fixture = workflowFixture({ executor: (root) => new ToolPlanExecutor(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    expect(fixture.executor.corrective.some((p) => p.includes("Task T001 tells its implementer to use run_probe, which it will not be offered"))).toBe(true);
    expect(fixture.executor.instructions.plan).toContain(plannedTaskToolsRule());
    expect(fixture.executor.instructions.spec).toContain(plannedTaskToolsRule());
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(fixture.executor.missingTool).toEqual([]);
    expect(outcome.status).toBe("completed");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
    expect(fixture.service.store.state(run.runId).graph?.tasks[0]?.description).not.toContain("run_probe");
  }, 60000);
});
