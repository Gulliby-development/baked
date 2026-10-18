import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diagnostics } from "../src/core/verification/task-end-check.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { Review, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Exercise Unicode paths and Location text through workflow artifacts and the report, alongside
// the Location-related bench findings #1532 and #1536. All non-ASCII fixtures use escapes.
const path = "src/caf\u00e9/\u65e5\u672c.ts";
const location = "https://example.test/caf\u00e9/\u65e5\u672c/\ud83c\udf5e";
const claim = `Location must preserve ${location}`;
const diagnostic = `${path}(3,7): error TS2322: ${claim}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Source = "diagnostic" | "review";
interface ReviewInput {
  snapshotHash: string;
  extra: { dimension?: string; evidence?: { id: string }[]; finding?: { id: string } };
}
class ScriptedExecutor extends FixtureExecutor {
  corrections: Task[] = [];
  constructor(private dir: string, private source: Source) {
    super(dir);
  }

  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const { taskGraph } = result.output as { taskGraph: TaskGraph };
      const template = taskGraph.tasks[0];
      if (!template) throw new Error("No template task");
      // Both tasks share criterion refs. Attribution must use the Unicode file, not the first task.
      taskGraph.tasks.push({ ...template, id: "T002", title: `Write ${path}`, description: "Write the Location value", writes: [{ path, action: "create" }], dependsOn: ["T001"] });
      return result;
    }
    if (request.profile.output === "implementation" && request.task?.id !== "T001") {
      const task = request.task;
      if (!task) throw new Error("No implementation task");
      if (task.origin !== "planned") this.corrections.push(task);
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      if (task.writes.some((write) => write.path === path))
        writeFileSync(join(this.dir, path), task.origin === "planned" ? "export const location = 'draft';\n" : `export const location = ${JSON.stringify(location)};\n`);
      return {
        output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: `Wrote ${path}`, evidenceIds: [], unresolved: [] },
        inputTokens: 25, outputTokens: 25,
      };
    }
    if (request.profile.output === "review" && this.source === "review") {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as ReviewInput;
      if (data.extra.dimension === "correctness" && !readFileSync(join(this.dir, path), "utf8").includes(location)) {
        const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
        return {
          output: {
            schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested",
            coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: claim }],
            findings: [{ id: "F-UNICODE", kind: "contradicts", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: path, symbol: null, evidenceIds, claim, impact: "The Location value is lost", suggestedFix: "Preserve the URL in the stored value" }],
          },
          inputTokens: 25, outputTokens: 25,
        };
      }
    }
    if (request.profile.output === "refutation") {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as ReviewInput;
      return { output: { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: claim }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

async function run(source: Source) {
  const policy = {
    ...fixturePolicy,
    maxRepairRounds: 2,
    checks: [...fixturePolicy.checks, ...(source === "diagnostic" ? [{
      id: "typecheck", executable: "bun", args: ["-e", `const f = Bun.file(${JSON.stringify(path)}); if (await f.exists() && !(await f.text()).includes(${JSON.stringify(location)})) { console.log(${JSON.stringify(diagnostic)}); process.exit(1) }`],
      cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [],
    }] : [])],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, source) });
  cleanups.push(fixture.dispose);
  const started = await fixture.start();
  await fixture.service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  const done = await fixture.service.drive(started.runId, new AbortController().signal);
  return { fixture, runId: started.runId, done };
}

describe("scenario: Unicode Location paths and text", () => {
  for (const source of ["diagnostic", "review"] as const) {
    test(`a Unicode ${source} reaches its file's corrective task and the rendered report`, async () => {
      const { fixture, runId, done } = await run(source);
      expect(done.status).toBe("completed");
      expect(fixture.executor.corrections).toHaveLength(1);
      expect(fixture.executor.corrections[0]?.writes.map((write) => write.path)).toEqual([path]);
      expect(readFileSync(join(fixture.root, path), "utf8")).toContain(location);
      expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
      const findings = fixture.service.store.findings(runId).map((row) => JSON.parse(row.body_json) as Review["findings"][number]);
      expect(findings.some((finding) => finding.file === path)).toBe(true);
      const report = runReport(fixture.service.store, runId);
      expect(report).toContain(`\`${path}\``);
      if (source === "review") {
        expect(findings.find((finding) => finding.id === "F-UNICODE")?.claim).toBe(claim);
        expect(report).toContain(claim);
      } else {
        const outputs = fixture.service.store.artifacts(runId)
          .filter((row) => row.kind === "check")
          .map((row) => (JSON.parse(fixture.service.store.readArtifact(runId, row.id)) as { output: string }).output);
        expect(outputs.some((output) => diagnostics(output).some((d) => d.path === path && d.text === `error TS2322: ${claim}`))).toBe(true);
      }
      expect(report).not.toContain("\ufffd");
    }, 60000);
  }
});
