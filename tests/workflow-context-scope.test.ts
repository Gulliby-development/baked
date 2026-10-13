import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("the implementer's prompt holds the files it modifies and leaves out research, other tasks' details and check logs", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  writeFileSync(join(root, "value.txt"), "old\nvalue\n");
  const execute = executor.execute.bind(executor);
  executor.execute = async (request) => {
    const result = await execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } }).taskGraph;
      for (const task of graph.tasks) task.writes = task.writes.map((w) => ({ ...w, action: "modify" }));
    }
    return result;
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  // A check log of the snapshot the task starts from.
  const state = service.store.state(run.runId);
  const log = service.store.artifact(run.runId, "command", "checks/fixture/log.json", JSON.stringify({ stdout: "z".repeat(5000) }));
  service.store.addEvidence(run.runId, "command", state.snapshotId as string, log.id);
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  expect((await service.get(run.runId)).status).toBe("completed");

  const prompt = executor.prompts.implementation?.[0] ?? "";
  const implement = extraOf(prompt) as Extra & { taskFiles?: { content: string } };
  expect(implement.taskFiles?.content).toStartWith("--- value.txt\n   1  old\n   2  value\n");
  expect(implement.evidence?.some((e) => e.kind === "command")).toBe(false);
  expect(prompt).not.toContain("A fixture workspace");
  // The task's rationale arrives once, in the task itself; the graph lists tasks by what they write.
  expect(prompt.split("Required behavior").length).toBe(2);
  expect(executor.prompts.spec?.[0]).toContain("A fixture workspace");
});

test("reviewers are told when the run started from a workspace without source code", async () => {
  const reviewBaseline = async (source: boolean) => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    if (source) writeFileSync(join(root, "main.ts"), "export const value = 1;\n");
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
      await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    expect((await service.get(run.runId)).status).toBe("completed");
    return (extraOf(executor.prompts.review?.[0] ?? "{}") as { baseline?: { greenfield: boolean } }).baseline;
  };
  expect(await reviewBaseline(false)).toEqual({ greenfield: true });
  expect(await reviewBaseline(true)).toBeUndefined();
});
