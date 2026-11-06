import { afterEach, describe, expect, test } from "bun:test";
import { buildId, setRunningBuild } from "../src/core/build-info.js";
import {
  INVALID_OUTPUT_BUILD_CHANGE,
  INVALID_OUTPUT_KEY,
  invalidOutputInputs,
  repeatsInvalidOutput,
} from "../src/core/workflows/invalid-output-repeat.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 84, sseknit `tools` 9e40f4b8 (#2587). The run blocked `invalid_output`
// with "reported implemented but changed none of its files", was resumed, and blocked the same
// way. #2585 / PR #2586 then fixed the host check that produced that diagnostic, and the runner
// moved to the build with the fix (pin 1c434312e). The resume at rev 20 still exited 5 with
// STALE_DECISION `repeated_invalid_output`: the repeat key held the diagnostic and the run's
// inputs, never the build, so a fixed check could never be tried by resume. Here the analysis
// stands for the stage: the fixture model keeps submitting a verdict the schema does not know,
// and the same diagnostic comes back on every build.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  setRunningBuild(null);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const OLD = { version: "0.5.0", commit: "7d1e0a52c4b9f3e6a8d2c1b0e9f8a7d6c5b4a392" };
const NEW = { version: "0.5.0", commit: "1c434312e0b7a6f5d4c3b2a1908f7e6d5c4b3a29" };

function fixture() {
  const f = workflowFixture();
  cleanups.push(f.dispose);
  const original = f.executor.execute.bind(f.executor);
  let attempts = 0;
  f.executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "analysis") return original(request);
    attempts++;
    return { output: { schemaVersion: 1, verdict: "maybe", findings: [] }, inputTokens: 25, outputTokens: 25 };
  };
  return { ...f, attempts: () => attempts };
}

const refusal = (f: ReturnType<typeof fixture>, runId: string) =>
  f.resume(runId).then(
    () => null,
    (error: Error & { code?: string; details?: { reason?: string } }) => error,
  );

/** Blocked twice with one diagnostic on `OLD`, the second time after a resume. */
async function blockedTwiceOnOld(f: ReturnType<typeof fixture>): Promise<string> {
  setRunningBuild(OLD);
  const run = await f.start();
  expect(await f.service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  await f.resume(run.runId);
  expect(await f.service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  return run.runId;
}

describe("scenario: R84 sseknit tools 9e40f4b8, resume after the check that blocked it was fixed (#2587)", () => {
  test("blocked, refused on the same build, one resume on the new build, refused again on it", async () => {
    const f = fixture();
    const runId = await blockedTwiceOnOld(f);
    const store = f.service.store;
    expect(invalidOutputInputs(store, runId).build).toBe(buildId(OLD));

    // Same build, same diagnostic: the guard refuses, as before.
    const same = await refusal(f, runId);
    expect(same?.code).toBe("STALE_DECISION");
    expect(same?.message).toContain("stopped again with the same diagnostic");
    expect(repeatsInvalidOutput(store, runId)).toBe(true);
    expect(f.attempts()).toBe(2);

    // The runner moves to the build with the fix: the run views offer the retry again, and one
    // resume passes and records why.
    setRunningBuild(NEW);
    expect(repeatsInvalidOutput(store, runId)).toBe(false);
    expect(await refusal(f, runId)).toBeNull();
    const why = store.latestArtifact(runId, INVALID_OUTPUT_BUILD_CHANGE);
    expect(why).not.toBeNull();
    expect(JSON.parse(store.readArtifact(runId, why?.id ?? ""))).toMatchObject({
      from: buildId(OLD),
      to: buildId(NEW),
    });
    const key = store.latestArtifact(runId, INVALID_OUTPUT_KEY);
    expect(JSON.parse(store.readArtifact(runId, key?.id ?? "")).inputs.build).toBe(buildId(NEW));

    // The fix did not help this run: the same diagnostic on the new build is a repeat.
    expect(await f.service.drive(runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(f.attempts()).toBe(3);
    const again = await refusal(f, runId);
    expect(again?.code).toBe("STALE_DECISION");
    expect(f.attempts()).toBe(3);
    // The note went into the prompt once across all resumes.
    const note = "The previous attempt of this stage was rejected as invalid output";
    expect(store.state(runId).prompt.split(note)).toHaveLength(2);
  });

  test("a resume key from before #2587 has no build: one attempt passes, then the repeat is refused", async () => {
    const f = fixture();
    const runId = await blockedTwiceOnOld(f);
    const store = f.service.store;
    // The key the last resume recorded, as a build before the fix wrote it.
    const recorded = store.latestArtifact(runId, INVALID_OUTPUT_KEY);
    const legacy = JSON.parse(store.readArtifact(runId, recorded?.id ?? ""));
    delete legacy.inputs.build;
    store.artifact(runId, "recovery", INVALID_OUTPUT_KEY, JSON.stringify(legacy));
    expect(await refusal(f, runId)).toBeNull();
    const why = store.latestArtifact(runId, INVALID_OUTPUT_BUILD_CHANGE);
    expect(JSON.parse(store.readArtifact(runId, why?.id ?? ""))).toMatchObject({ from: null, to: buildId(OLD) });
    expect(await f.service.drive(runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect((await refusal(f, runId))?.code).toBe("STALE_DECISION");
  });
});
