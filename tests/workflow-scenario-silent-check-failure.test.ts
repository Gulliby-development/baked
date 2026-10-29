import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { SWIFT_TEST_SILENT_EXIT_4 } from "./fixtures/swiftpm-crash-outputs.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 76 (#2418). hintsieve's `swift-test` exited 4 at the checks stage with
// SwiftPM progress lines only (a toolchain crash under parallel builds), and the stage opened
// corrective T004: 440,339 tokens, 13 minutes, an empty diff. The next run of the same tree passed.
// Here the required check fails once that way after the code is correct, then passes.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A check that crashes once, silently, on the first run that sees correct code. */
function crashingOnce(): { policy: RunPolicy; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "baked-silent-check-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "crashed");
  const progress = join(dir, "progress.txt");
  const count = join(dir, "runs");
  writeFileSync(progress, SWIFT_TEST_SILENT_EXIT_4);
  const script = `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(count)}, "x");
const value = fs.existsSync("value.txt") ? fs.readFileSync("value.txt", "utf8") : "";
if (value !== "ready") { console.log("AssertionError: value.txt is not ready"); process.exit(1); }
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, "");
  process.stdout.write(fs.readFileSync(${JSON.stringify(progress)}, "utf8"));
  process.exit(4);
}`;
  const policy: RunPolicy = {
    ...fixturePolicy,
    checks: [{ ...fixturePolicy.checks[0], id: "swift-test", args: ["-e", script] } as RunPolicy["checks"][number]],
  };
  return { policy, runs: () => (existsSync(count) ? Bun.file(count).size : 0) };
}

async function scenario(policy: RunPolicy) {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { executor, service } = fixture;
  const corrections: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") corrections.push(request.task?.id ?? "");
    return original(request);
  };
  const { runId } = await fixture.start();
  await service.drive(runId, new AbortController().signal);
  const waiting = await service.get(runId);
  const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const run = await service.drive(runId, new AbortController().signal);
  const store = service.store;
  return {
    run,
    corrections,
    checks: store.checks(runId).filter((c) => c.check_id === "swift-test"),
    wouldRerun: store.eventsOfType(runId, "decision.would_rerun").flatMap((e) => (e.type === "decision.would_rerun" ? [e.payload] : [])),
    reruns: store.artifacts(runId).filter((a) => a.logical_path.startsWith("checks/swift-test/rerun-")).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as Record<string, unknown>),
  };
}

describe("scenario: hintsieve R76, a required check fails with no failure line (#2418)", () => {
  test("enforced, the host runs it once more, it passes and no corrective opens", async () => {
    const { policy, runs } = crashingOnce();
    const result = await scenario({ ...policy, stopModes: { silent_check_failure: "enforce" } });
    expect(result.corrections).toEqual([]);
    expect(result.run.status).toBe("completed");
    expect(result.checks.map((c) => c.status)).toContain("failed");
    expect(result.reruns).toHaveLength(1);
    expect(result.reruns[0]).toMatchObject({ checkId: "swift-test", stage: "checks", first: { status: "inconclusive", reason: "silent_failure" }, rerun: { status: "passed" } });
    expect(result.wouldRerun).toEqual([]);
    expect(runs()).toBeGreaterThan(1);
  });

  test("in shadow (the default) it records decision.would_rerun and corrects as before", async () => {
    const { policy } = crashingOnce();
    const result = await scenario(policy);
    expect(result.wouldRerun).toHaveLength(1);
    expect(result.wouldRerun[0]).toMatchObject({ reason: "silent_check_failure", mode: "shadow", inputs: { checkId: "swift-test", stage: "checks" } });
    expect(String(result.wouldRerun[0]?.inputs.outputTail)).toContain("HintSieveCoreTests-test-runner");
    expect(result.corrections.length).toBeGreaterThan(0);
    expect(result.reruns).toEqual([]);
  });
});
