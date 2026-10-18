import { afterEach, expect, test } from "bun:test";
import { errorRecovery } from "../src/core/workflows/remedies.js";
import { expectRecovery } from "./helpers/workflow-remedies.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fillHostConstants } from "../src/core/workflows/host-constants.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;

test("the host binds the analysis to its manifest whatever hash the model copied", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  // d0f55591: the analyzer transposed two characters of the 64-hex input hash.
  executor.execute = async (request: ExecutionRequest) =>
    request.profile.output === "analysis"
      ? { output: { schemaVersion: 1, inputHash: "ab".repeat(32), verdict: "pass", findings: [] }, inputTokens: 25, outputTokens: 25 }
      : original(request);
  const run = await fixture.start();
  const snapshot = await service.drive(run.runId, signal());
  expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
});

test("resuming after invalid output gives the stage the diagnostic as a correction note, once", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  let analyses = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "analysis") return original(request);
    analyses++;
    // The first analysis submits a verdict the schema does not know.
    if (analyses === 1)
      return { output: { schemaVersion: 1, verdict: "maybe", findings: [] }, inputTokens: 25, outputTokens: 25 };
    return original(request);
  };
  const run = await fixture.start();
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  await fixture.resume(run.runId);
  const note = "The previous attempt of this stage was rejected as invalid output";
  const prompt = service.store.state(run.runId).prompt;
  expect(prompt).toContain(note);
  expect(prompt).toContain("verdict");
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "waiting", reason: "approval" });
  expect(executor.prompts.analysis?.at(-1)).toContain(note);
  expect(service.store.state(run.runId).prompt.split(note)).toHaveLength(2);
});

// narrowfit 3c2e3629 (#1348): the run stopped with the same diagnostic after a resume, and two more
// resumes and an extension repeated the same attempt until a replan.
test("a resume after the same invalid output stopped the run again is refused with the ways out", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) =>
    request.profile.output === "analysis"
      ? { output: { schemaVersion: 1, verdict: "maybe", findings: [] }, inputTokens: 25, outputTokens: 25 }
      : original(request);
  const run = await fixture.start();
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  const refused = await fixture.resume(run.runId).then(() => null, (error: Error) => error);
  expect(refused?.message).toContain("stopped again with the same diagnostic");
  expect(refused?.message).toContain("initiative replan");
  expectRecovery(refused?.message ?? "", errorRecovery(refused), "revise");
  expect(service.store.run(run.runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
});

test("an analysis submission without a well-formed input hash is not rejected for it", () => {
  const filled = fillHostConstants("analysis", 1, { verdict: "pass", findings: [] }) as { inputHash: string; schemaVersion: number };
  expect(filled.inputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(filled.schemaVersion).toBe(1);
  const kept = fillHostConstants("analysis", 1, { inputHash: "c".repeat(64) }) as { inputHash: string };
  expect(kept.inputHash).toBe("c".repeat(64));
});
