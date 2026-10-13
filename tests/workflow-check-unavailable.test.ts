import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_PREFLIGHT_ARTIFACT,
  failFastUnavailable,
  smokeChecks,
  unresolvedChecks,
} from "../src/core/workflows/check-preflight.js";
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

/** A check executable that resolves but cannot be spawned, as `mvn.cmd` was in R8 propdrift. */
const unspawnable: Partial<Check> =
  // cmd.exe would expand the percent sign, so the batch launch refuses the line.
  process.platform === "win32" ? { executable: "./tool.cmd", args: ["100%"] } : { executable: "./tool", args: [] };
function writeUnspawnable(dir: string): void {
  const file = join(dir, process.platform === "win32" ? "tool.cmd" : "tool");
  writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "not a program\n");
  if (process.platform !== "win32") chmodSync(file, 0o644);
}

describe("the start-time check smoke", () => {
  test("starts each check once outside the workspace and reports what could not start", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-smoke-"));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    writeUnspawnable(root);
    const checks = [
      check({ id: "runs", executable: process.execPath, args: ["-e", "await Bun.write('touched.txt', 'x'); await Bun.sleep(60000)"] }),
      check({ id: "broken", ...unspawnable }),
      check({ id: "gone", executable: "baked-fixture-command-does-not-exist", required: false }),
      check({ id: "generated", executable: "./gradlew" }),
      check({ id: "runtime", executable: "bun" }),
    ];
    const started = performance.now();
    const smoke = await smokeChecks(checks, root);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(Object.fromEntries(smoke.map((s) => [s.checkId, s.status]))).toEqual({
      runs: "started",
      broken: "cannot_start",
      gone: "not_found",
      generated: "not_probed",
      runtime: "not_probed",
    });
    expect(smoke.find((s) => s.checkId === "broken")?.detail).toBeTruthy();
    expect(existsSync(join(root, "touched.txt"))).toBe(false);
  });

  test("a required check that cannot start refuses the run before it begins; the smoke is recorded", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    fixture.service.providerReady = async () => ({ known: true, ready: true });
    const refused = workflowFixture({
      policy: { ...fixturePolicy, checks: [check({ id: "broken", ...unspawnable })] },
    });
    cleanups.push(refused.dispose);
    refused.service.providerReady = async () => ({ known: true, ready: true });
    writeUnspawnable(refused.root);
    await expect(refused.start()).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "check_unavailable" },
    });
    expect((await refused.service.list({ limit: 10 })).items).toHaveLength(0);

    const run = await fixture.start();
    const row = fixture.service.store.latestArtifact(run.runId, CHECK_PREFLIGHT_ARTIFACT);
    expect(row).toBeTruthy();
    const recorded = JSON.parse(fixture.service.store.readArtifact(run.runId, row?.id ?? "")) as {
      checks: { checkId: string; status: string }[];
    };
    expect(recorded.checks).toEqual([expect.objectContaining({ checkId: "check", status: "not_probed" })]);
  });
});
