import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hardenPlanProblems, hardenTargets } from "../src/core/workflows/quality/harden.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { builtinPresets } from "../src/core/workflows/v2/definitions.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const SIGN = "export const sign = (n: number) => (n < 0 ? -1 : 1);\n";
const weakTest = 'import { expect, test } from "bun:test";\nimport { sign } from "../src/sign";\ntest("sign", () => {\n  expect(sign(-5)).toBe(-1);\n});\n';
const strongTest = 'import { expect, test } from "bun:test";\nimport { sign } from "../src/sign";\ntest("sign", () => {\n  expect(sign(-5)).toBe(-1);\n  expect(sign(0)).toBe(1);\n  expect(sign(5)).toBe(1);\n});\n';

describe("harden plans", () => {
  test("tasks write only test files and manifests and name the module in their read hints", () => {
    const task = (writes: string[], readHints: string[]) => ({
      id: "T001",
      writes: writes.map((path) => ({ path, action: "modify" })),
      readHints,
    });
    expect(hardenPlanProblems([task(["tests/sign.test.ts", "package.json"], ["src/sign.ts"])])).toEqual([]);
    expect(hardenPlanProblems([task(["src/sign.ts"], ["src/sign.ts"])])).toEqual([
      "A harden run writes only test files and manifests: T001 writes src/sign.ts",
    ]);
    expect(hardenPlanProblems([task(["tests/sign.test.ts"], ["tests/sign.test.ts"])])[0]).toContain("readHints");
    expect(hardenTargets([{ readHints: ["src/b.ts", "tests/b.test.ts", "README.md", "src/a.ts"] }])).toEqual(["src/a.ts", "src/b.ts"]);
    expect(builtinPresets.get("harden")?.preset).toBe("harden");
  });
});

describe("harden run", () => {
  class HardenExecutor extends FixtureExecutor {
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as {
          taskGraph: { tasks: { writes: { path: string; action: string }[]; readHints: string[] }[] };
        };
        const task = plan.taskGraph.tasks[0];
        if (task) {
          task.writes = [{ path: "tests/sign.test.ts", action: "modify" }];
          task.readHints = ["src/sign.ts"];
        }
        return result;
      }
      if (request.profile.output === "implementation") {
        writeFileSync(join(this.dir, "tests/sign.test.ts"), strongTest);
        return {
          output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Pinned sign", evidenceIds: [], unresolved: [] },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      return super.execute(request);
    }
  }

  test("a harden run raises the module's mutation score without touching it", async () => {
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    const policy = { ...fixturePolicy, checks: [{ ...first, id: "unit", args: ["test", "tests/"] }] };
    const fixture = workflowFixture({
      policy,
      executor: (root) => {
        mkdirSync(join(root, "src"), { recursive: true });
        mkdirSync(join(root, "tests"), { recursive: true });
        writeFileSync(join(root, "src/sign.ts"), SIGN);
        writeFileSync(join(root, "tests/sign.test.ts"), weakTest);
        return new HardenExecutor(root);
      },
    });
    try {
      const { service, executor } = fixture;
      const run = await service.start({
        commandId: newId(),
        featureId: "fixture",
        workflowId: "harden",
        prompt: "Harden the tests of src/sign.ts",
        ownerLabel: "test",
        policy,
      });
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      expect(executor.prompts.plan?.[0]).toContain("hardens the tests of existing code");
      expect(readFileSync(join(fixture.root, "src/sign.ts"), "utf8")).toBe(SIGN);
      const report = runReport(service.store, run.runId);
      expect(report).toContain("Mutation gate (`required`): score 100%");
      expect(report).toMatch(/Mutation score before the run: \d+% -> after: 100%\./);
      expect(report).not.toContain("Mutation score before the run: 100%");
    } finally {
      await fixture.dispose();
    }
  });
});
