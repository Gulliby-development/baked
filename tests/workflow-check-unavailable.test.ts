import { afterEach, describe, expect, test } from "bun:test";
import { failFastUnavailable, unresolvedChecks } from "../src/core/workflows/check-preflight.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { Check } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const check = (patch: Partial<Check> = {}): Check => ({
  ...(fixturePolicy.checks[0] as Check),
  ...patch,
});

describe("a required check that cannot be started", () => {
  test("failFastUnavailable stops on a spawn_error of a required check only", () => {
    const required = check({ id: "mvn-test", executable: "mvn", args: ["test"] });
    expect(() => failFastUnavailable(required, { reason: "spawn_error", output: "spawn mvn EINVAL" })).toThrow(
      WorkflowFault,
    );
    expect(() => failFastUnavailable(required, { reason: "timeout" })).not.toThrow();
    expect(() => failFastUnavailable(required, { reason: "exit" })).not.toThrow();
    expect(() =>
      failFastUnavailable({ ...required, required: false }, { reason: "spawn_error" }),
    ).not.toThrow();
    try {
      failFastUnavailable(required, { reason: "spawn_error", output: "spawn mvn EINVAL" });
    } catch (error) {
      expect((error as WorkflowFault).details).toMatchObject({
        reason: "check_unavailable",
        checkId: "mvn-test",
      });
      expect((error as WorkflowFault).message).toContain("mvn test");
    }
  });

  test("the start smoke finds bare executables that do not resolve", () => {
    const checks = [
      check({ id: "ok", executable: "cargo" }),
      check({ id: "gone", executable: "nope-tool" }),
      check({ id: "generated", executable: "./gradlew" }),
      check({ id: "runtime", executable: "bun" }),
    ];
    const found = unresolvedChecks(checks, process.cwd(), (command) =>
      command === "cargo" ? "/usr/bin/cargo" : null,
    );
    expect(found).toEqual([{ checkId: "gone", executable: "nope-tool", required: true }]);
  });

  test("a run blocks at the first spawn_error with check_unavailable, before review", async () => {
    const fixture = workflowFixture({
      policy: {
        ...fixturePolicy,
        checks: [check({ executable: "baked-fixture-command-does-not-exist" })],
      },
    });
    cleanups.push(fixture.dispose);
    const signal = new AbortController().signal;
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const snapshot = await fixture.service.drive(run.runId, signal);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.reason).toBe("check_unavailable");
    expect(fixture.executor.calls).not.toContain("review");
    const results = fixture.service.store.checkDetails(run.runId);
    expect(results.filter((r) => r.reason === "spawn_error")).toHaveLength(1);
  });
});
