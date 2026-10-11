import { afterEach, describe, expect, test } from "bun:test";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;

/** A fixture run waiting at its approval request. */
async function waitingForApproval() {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, signal());
  const request = fixture.service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending")!;
  const revision = (await fixture.service.get(run.runId)).revision;
  return { fixture, runId: run.runId, request, revision };
}
const approveArgs = (s: Awaited<ReturnType<typeof waitingForApproval>>, ...extra: string[]) =>
  ["approve", s.runId, "--request", s.request.id, "--digest", s.request.digest, "--expected-revision", String(s.revision), ...extra];

describe("headless decisions continue the run", () => {
  test("approve, answer and evidence resume by default and --no-resume keeps the old behavior", () => {
    for (const command of ["approve", "answer", "evidence"]) {
      expect(parseWorkflowArgs([command, "r", "--request", "q", "--expected-revision", "1"]).flags.resume).toBe(true);
      const kept = parseWorkflowArgs([command, "r", "--request", "q", "--expected-revision", "1", "--no-resume"]);
      expect(kept.flags.resume).toBeUndefined();
      expect(kept.flags["no-resume"]).toBe(true);
    }
    expect(() => parseWorkflowArgs(["approve", "r", "--resume", "--no-resume"])).toThrow("exclude each other");
    expect(() => parseWorkflowArgs(["approve", "r", "--no-resume", "--events"])).toThrow("--events and --after need --resume");
    expect(() => parseWorkflowArgs(["reject", "r", "--no-resume"])).toThrow("not valid");
    expect(parseWorkflowArgs(["resume", "r", "--expected-revision", "1"]).flags.resume).toBeUndefined();
  });
  test("an approval through the terminal drives the run past the approval", async () => {
    const s = await waitingForApproval();
    const result = await executeWorkflowCommand(s.fixture.service, parseWorkflowArgs(approveArgs(s)), signal()) as { status: string };
    expect(result.status).toBe("completed");
    expect(s.fixture.service.store.requests(s.runId).find((r) => r.id === s.request.id)?.status).toBe("accepted");
  });
  test("--no-resume only records the decision", async () => {
    const s = await waitingForApproval();
    const result = await executeWorkflowCommand(s.fixture.service, parseWorkflowArgs(approveArgs(s, "--no-resume")), signal()) as { status: string };
    expect(result.status).toBe("paused");
  });
  test("a decision API caller that sets no resume flag keeps the recorded-only behavior", async () => {
    const s = await waitingForApproval();
    const args = { command: "approve" as const, positional: [s.runId], flags: { request: s.request.id, digest: s.request.digest, "expected-revision": String(s.revision) } };
    const result = await executeWorkflowCommand(s.fixture.service, args, signal()) as { status: string };
    expect(result.status).toBe("paused");
  });
});
