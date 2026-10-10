import { afterEach, expect, test } from "bun:test";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
type Extra = { evidence?: { id: string; kind: string; content: string }[]; unresolvedMeans?: string };
const extraOf = (prompt: string): Extra => (JSON.parse(prompt.split("\n").at(-1) ?? "{}") as { extra: Extra }).extra;

test("the implementer does not receive the research-phase file reads, reviewers still receive the check evidence", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  // Evidence of a file read during research, valid for the current snapshot.
  const state = service.store.state(run.runId);
  const artifact = service.store.artifact(run.runId, "read", "reads/fixture/long-read.json", JSON.stringify({ tool: "read", result: "x".repeat(15000) }));
  const readId = service.store.addEvidence(run.runId, "read", state.snapshotId as string, artifact.id);
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  expect((await service.get(run.runId)).status).toBe("completed");

  const implement = extraOf(executor.prompts.implementation?.[0] ?? "{}");
  expect(implement.evidence?.some((e) => e.kind === "read")).toBe(false);
  expect(JSON.stringify(implement)).not.toContain("xxxxxxxxxx");
  expect(implement.unresolvedMeans).toContain("only parts of THIS task");

  const review = extraOf(executor.prompts.review?.[0] ?? "{}");
  // Evidence is tied to a snapshot: the read belongs to the one before the edit, the checks to the one after.
  expect(review.evidence?.some((e) => e.kind === "command")).toBe(true);
  expect(readId).toBeTruthy();
});

test("reviewers and the auditor get the task's patch, and earlier reads only by path and size", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  // A reviewer reads a file on the final snapshot; the auditor after it should not get the content again.
  const execute = executor.execute.bind(executor);
  executor.execute = async (request) => {
    if (request.profile.output === "review" && !executor.prompts.review) {
      const state = service.store.state(request.runId);
      const artifact = service.store.artifact(request.runId, "read", "reads/review/value.json", JSON.stringify({ tool: "read", input: { files: [{ path: "value.txt" }] }, result: "y".repeat(15000) }));
      service.store.addEvidence(request.runId, "read", state.snapshotId as string, artifact.id);
    }
    return execute(request);
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  expect((await service.get(run.runId)).status).toBe("completed");

  const review = extraOf(executor.prompts.review?.[0] ?? "{}");
  const diff = review.evidence?.find((e) => e.kind === "diff");
  expect(JSON.parse(diff?.content ?? "{}").patch).toContain("+ready");

  const convergence = extraOf(executor.prompts.convergence?.[0] ?? "{}");
  expect(JSON.stringify(convergence)).not.toContain("yyyyyyyyyy");
  const read = convergence.evidence?.find((e) => e.kind === "read") as { read?: { tool: string; targets: string[]; bytes: number } } | undefined;
  expect(read?.read).toMatchObject({ tool: "read", targets: ["value.txt"] });
  expect(read?.read?.bytes).toBeGreaterThan(15000);
});
