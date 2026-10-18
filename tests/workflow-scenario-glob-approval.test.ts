import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { featurePolicy } from "../src/core/workflows/initiatives/service.js";
import { InitiativeSettingsSchema } from "../src/core/workflows/initiatives/store.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #1504, merged in #1509: a glob permits an open set of files. The feature's plan must
// pass tiered approval beyond the initiative's original counts, but remain inside its paths.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const inside = ["src/feature/value.txt", "src/feature/nested/detail.txt"];
const outside = "src/feature-neighbor/value.txt";

class ScriptedExecutor extends FixtureExecutor {
  implemented: string[] = [];
  constructor(private dir: string, private escape: boolean) {
    super(dir);
  }

  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const { taskGraph } = result.output as { taskGraph: TaskGraph };
      const template = taskGraph.tasks[0];
      if (!template) throw new Error("No template task");
      taskGraph.tasks = [...inside, ...(this.escape ? [outside] : [])].map((path, index) => ({
        ...template,
        id: `T00${index + 1}`,
        title: `Create ${path}`,
        description: `Write ready to ${path}`,
        writes: [{ path, action: "create" }],
      }));
      return result;
    }
    if (request.profile.output === "implementation") {
      if (!request.task) throw new Error("No implementation task");
      this.implemented.push(request.task.id);
      for (const write of request.task.writes) {
        mkdirSync(dirname(join(this.dir, write.path)), { recursive: true });
        writeFileSync(join(this.dir, write.path), "ready");
      }
      return {
        output: { schemaVersion: 1, taskId: request.task.id, outcome: "implemented", summary: "Wrote ready", evidenceIds: [], unresolved: [] },
        inputTokens: 25, outputTokens: 25,
      };
    }
    return super.execute(request);
  }
}

async function run(escape: boolean) {
  const settings = InitiativeSettingsSchema.parse({
    workflowId: "sdd", basePolicy: {
      ...fixturePolicy,
      checks: [{ ...fixturePolicy.checks[0], args: ["-e", `for (const p of ${JSON.stringify(inside)}) if (await Bun.file(p).text() !== 'ready') process.exit(1)`] }],
    },
    budget: null, featureAutoApproval: { maxTasks: 1, maxFiles: 1 }, model: null, ownerLabel: "test",
  });
  const policy = featurePolicy(settings, { tokens: 2_000_000, calls: 200, activeMs: 3_600_000 }, {
    id: "fixture", title: "Feature values", boundary: { scope: "Feature files", paths: ["src/feature/**"] },
    contract: "Values are ready", dependsOn: [], mandatory: true,
  }, false);
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, escape) });
  cleanups.push(fixture.dispose);
  const started = await fixture.start();
  const done = await fixture.service.drive(started.runId, new AbortController().signal);
  const approvals = fixture.service.store.requests(started.runId).filter((r) => r.kind === "approval");
  return { fixture, done, approvals };
}

describe("scenario: tiered approval of a feature with a glob boundary (#1504, #1509)", () => {
  test("a plan above the original counts writes inside the glob and completes without a person", async () => {
    const { fixture, done, approvals } = await run(false);
    expect(done.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "accepted", actor: "auto-approval" });
    expect(JSON.parse(approvals[0]?.body_json ?? "{}").autoApproval.mode).toBe("limits");
    expect(fixture.executor.implemented).toEqual(["T001", "T002"]);
    for (const path of inside) expect(readFileSync(join(fixture.root, path), "utf8")).toBe("ready");
  }, 60000);

  test("adding a neighboring path outside the glob leaves approval pending and executes no writes", async () => {
    const { fixture, done, approvals } = await run(true);
    expect(done.reason).toBe("approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "pending", actor: null });
    expect(JSON.parse(approvals[0]?.body_json ?? "{}").autoApproval.declined).toContain(`Limits: ${outside} is outside the allowed paths`);
    expect(fixture.executor.implemented).toEqual([]);
    for (const path of [...inside, outside]) expect(existsSync(join(fixture.root, path))).toBe(false);
  }, 60000);
});
