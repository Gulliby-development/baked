import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { SizingReport } from "../src/core/workflows/sizing.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R47 idpeek (#1597): each sequential test task owns one row of the same criterion.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const rows = ["--ascending", "--descending", "--stdin"];
const spec: Spec = { ...fixtureSpec, criteria: [
  { ...fixtureSpec.criteria[0]!, given: "CLI options", when: "the option is passed",
    then: `input | expected\n--- | ---\n${rows.map((row) => `${row} | ready`).join("\n")}` },
  { ...fixtureSpec.criteria[0]!, id: "AC-002", given: "a workspace" },
] };

const planned = (id: string, path: string, criterionIds = ["AC-001"], dependsOn: string[] = []): Task => ({
  id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds,
  dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [],
  checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
});

class ScriptedExecutor extends FixtureExecutor {
  missing: { id: string; errors: string[] }[] = [];
  absent: string[] = [];
  constructor(private workspace: string, private mode: "named" | "remainder" | "slices") { super(workspace); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const response = await super.execute(request);
      const plan = response.output as { markdown: string; taskGraph: TaskGraph };
      plan.markdown += "\nTests in tests/options.test.ts. Documentation in docs/one.md, docs/two.md, docs/three.md, docs/four.md.";
      const tests = rows.map((row, index) => ({
        ...planned(`T00${index + 2}`, "tests/options.test.ts", ["AC-001"], [`T00${index + 1}`]),
        description: this.mode === "slices" ? `Add slice ${index + 1} of the option tests` :
          this.mode === "remainder" && index === 2 ? "Complete the remaining row" : `Test only ${row}`,
        writes: [{ path: "tests/options.test.ts", action: index ? "modify" as const : "create" as const }],
        ...(this.mode === "slices" ? { sizingSlice: { taskId: "T002", index, count: 3, share: 1 / 3 } } : {}),
      }));
      plan.taskGraph = { ...plan.taskGraph, specHash: hashJson(spec), planHash: hashBytes(plan.markdown), tasks: [
        planned("T001", "value.txt", ["AC-001", "AC-002"]), ...tests,
        ...["one", "two", "three", "four"].map((name, i) => planned(`T00${i + 5}`, `docs/${name}.md`, ["AC-002"], ["T004"])),
      ] };
      return response;
    }
    if (request.profile.output === "implementation" && request.task?.id !== "T001") {
      const own = request.task!;
      const root = request.root ?? this.workspace;
      const path = join(root, own.writes[0]!.path);
      mkdirSync(dirname(path), { recursive: true });
      if (path.endsWith(".test.ts")) {
        const index = Number(own.id.slice(1)) - 2;
        if (index === 0) writeFileSync(path, 'import { expect, test } from "bun:test";\n');
        if (index === 2) this.absent = await request.caseCheck?.(root) ?? [];
        const row = rows[index]!;
        appendFileSync(path, `test(${JSON.stringify(row)}, () => expect(${JSON.stringify(row)}.startsWith("--")).toBe(true));\n`);
        this.missing.push({ id: own.id, errors: await request.caseCheck?.(root) ?? [] });
      } else writeFileSync(path, "# Options\nThe CLI accepts options.\n");
      return { output: { schemaVersion: 1, taskId: own.id, outcome: "implemented", summary: "Wrote assigned row", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    const response = await super.execute(request);
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const output = response.output as { coverage: { criterionId: string }[] };
      output.coverage = spec.criteria.map((c) => ({ ...output.coverage[0]!, criterionId: c.id }));
    }
    return response;
  }
}

for (const mode of ["named", "remainder", "slices"] as const) {
  test(`scenario: shared criterion ${mode} walks and prices each row once (#1597)`, async () => {
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, clarification: "assume", sizing: { maxAttemptTokens: 2_000_000, historyStores: [] } },
      executor: (root) => new ScriptedExecutor(root, mode),
    });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const waiting = await fixture.service.drive(run.runId, new AbortController().signal);
    if (waiting.reason !== "approval") throw new Error(fixture.service.store.artifacts(run.runId)
      .filter((a) => a.kind === "diagnostic").map((a) => fixture.service.store.readArtifact(run.runId, a.id)).join("\n"));
    const store = fixture.service.store;
    const artifact = store.latestArtifact(run.runId, "sizing/plan-0.json")!;
    const report = JSON.parse(store.readArtifact(run.runId, artifact.id)) as SizingReport;
    await fixture.approve(run.runId);
    expect((await fixture.service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    expect(fixture.executor.missing).toEqual(["T002", "T003", "T004"].map((id) => ({ id, errors: [] })));
    expect(fixture.executor.absent).toHaveLength(1);
    expect(fixture.executor.absent[0]).toContain('AC-001 names "--stdin"');
    expect(report.tasks.filter((t) => t.kind === "test").map((t) => t.cases)).toEqual([1, 1, 1]);
    expect(store.state(run.runId).graph!.tasks).toHaveLength(8);
  }, 120_000);
}
