import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { failedOwnEdits } from "../src/core/workflows/retry.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 19, cfgtrace b8544e36 (#1036): after its restart, a corrective task
// submitted `implemented` with one edit of its own test file listed as unresolved ("the attempted
// edit did not apply"), and the run stopped at 13 of 14 tasks after 6.9M tokens. One line was
// left; a fresh attempt from the applied edits finishes it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NOT_APPLIED = "value.txt: change the remaining text to ready; the attempted edit did not apply";

/** Implementation attempts write `partial` and report the rest unresolved, then the base writes `ready`. */
class UnappliedEditExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(
    private dir: string,
    private unresolved: string[][],
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    const unresolved = this.unresolved[this.implementations++];
    if (unresolved === undefined) return super.execute(request);
    writeFileSync(join(this.dir, "value.txt"), "partial");
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Most of it", evidenceIds: [], unresolved },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

async function drive(policy: RunPolicy, unresolved: string[][]) {
  const fixture = workflowFixture({ policy, executor: (root) => new UnappliedEditExecutor(root, unresolved) });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  return { fixture, run, outcome, executor: fixture.executor as UnappliedEditExecutor };
}

describe("scenario: cfgtrace b8544e36, an edit of the task's own file did not apply (#1036)", () => {
  test("after the restart under clarification assume, the failed edit gets one more attempt", async () => {
    const { outcome, executor, fixture, run } = await drive({ ...fixturePolicy, clarification: "assume" }, [
      ["value.txt is not finished yet"],
      [NOT_APPLIED],
    ]);
    expect(executor.implementations).toBe(3);
    expect(outcome.status).toBe("completed");
    const restart = fixture.service.store.latestArtifact(run.runId, "tasks/restarts/T001.json");
    expect(fixture.service.store.readArtifact(run.runId, restart?.id ?? "")).toContain("an edit of its own file did not apply: value.txt");
  }, 60000);

  test("without clarification assume the failed edit gets one attempt, and a second failure blocks", async () => {
    const once = await drive(fixturePolicy, [[NOT_APPLIED]]);
    expect(once.outcome.status).toBe("completed");
    const twice = await drive(fixturePolicy, [[NOT_APPLIED], [NOT_APPLIED]]);
    expect(twice.executor.implementations).toBe(2);
    expect(twice.outcome.status).toBe("blocked");
  }, 60000);

  test("only unresolved edits of the task's own files count", () => {
    const writes = [{ path: "tests/test_cli.py", action: "modify" }];
    const implemented = (unresolved: string[]) => ({ outcome: "implemented", unresolved });
    expect(failedOwnEdits(implemented(["tests/test_cli.py: the attempted edit did not apply"]), writes)).toEqual(["tests/test_cli.py"]);
    expect(failedOwnEdits(implemented(["src/other.py: the attempted edit did not apply"]), writes)).toEqual([]);
    expect(failedOwnEdits(implemented(["tests/test_cli.py conflicts with FR-002"]), writes)).toEqual([]);
    expect(failedOwnEdits({ outcome: "blocked", unresolved: ["tests/test_cli.py: edit failed"] }, writes)).toEqual([]);
  });
});
