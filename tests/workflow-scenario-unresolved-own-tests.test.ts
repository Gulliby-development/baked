import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownCheckFailures } from "../src/core/workflows/scheduler.js";
import type { Task } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 22, keeplint-update ada519a3 (#1110): T004 wrote its test file and
// reported two of its own new tests failing as unresolved. The host rejected the result, restarted
// the task, got the same report and blocked the run at 4 of 5 tasks after 1.83M tokens.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OWN_TEST_FAILS = "test_value_ready fails: AssertionError, value.txt holds partial instead of ready";

/** Every attempt of T001 writes `partial` and reports its own test failing; a corrective task writes `ready`. */
class OwnFailureExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    this.implementations++;
    if (request.task?.id !== "T001") return super.execute(request);
    writeFileSync(join(this.dir, "value.txt"), "partial");
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [OWN_TEST_FAILS] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

describe("scenario: keeplint ada519a3, a task reports its own tests failing (#1110)", () => {
  test("the failure becomes a finding and a corrective task instead of a second attempt and a blocked run", async () => {
    const fixture = workflowFixture({ executor: (root) => new OwnFailureExecutor(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    const executor = fixture.executor as OwnFailureExecutor;
    const store = fixture.service.store;
    expect(store.latestArtifact(run.runId, "tasks/restarts/T001.json")).toBeNull();
    const finding = store
      .findings(run.runId)
      .map((f) => JSON.parse(f.body_json) as { claim: string; file: string | null })
      .find((f) => f.claim.includes("reported unresolved in its own files"));
    expect(finding).toMatchObject({ file: "value.txt" });
    expect(finding?.claim).toContain(OWN_TEST_FAILS);
    expect(store.latestArtifact(run.runId, "tasks/T001/unresolved.json")).not.toBeNull();
    expect(outcome.status).toBe("completed");
    // T001 once, then its corrective task; no second full attempt of T001.
    expect(executor.implementations).toBe(2);
  }, 60000);

  test("only failing tests or lint findings of a task that changed its files count", () => {
    const task = { id: "T004", writes: [{ path: "tests/test_github_format.py", action: "create" }] } as unknown as Task;
    const implemented = (unresolved: string[]) => ({ taskId: "T004", outcome: "implemented", unresolved });
    const changed = ["tests/test_github_format.py"];
    expect(ownCheckFailures(task, implemented(["Ruff ISC004 on adjacent string literals", "test_changelog_example fails: CHANGELOG.md is never created"]), changed)).toBe(true);
    expect(ownCheckFailures(task, implemented(["test_readme fails because README.md lacks the KL003 section"]), changed)).toBe(true);
    expect(ownCheckFailures(task, implemented(["The CLI flag is not implemented yet"]), changed)).toBe(false);
    expect(ownCheckFailures(task, implemented(["test_x fails"]), [])).toBe(false);
    expect(ownCheckFailures(task, { taskId: "T004", outcome: "blocked", unresolved: ["test_x fails"] }, changed)).toBe(false);
  });
});
