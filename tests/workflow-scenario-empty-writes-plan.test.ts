import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { type TaskGraph, validateTaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #3066, smoke 2026-11-16 java-maven-palindrome trial 1 (claude-code/haiku, quick). The planner
// returned two tasks, "Write Palindromes class and JUnit tests" and "Write README.md", both with
// `writes: []`. The plan was approved, the host marked each task implemented without a session
// (a task with no writes has nothing for a model to do), the build passed on the seed pom.xml,
// review found all three deliverables missing, and the run blocked: nothing was ever written.

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const MARKDOWN =
  "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
const task = (id: string, title: string, writes: { path: string; action: "create" }[]) => ({
  id,
  title,
  description: title,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes,
  readHints: [],
  checkIds: [],
  origin: "planned" as const,
  findingIds: [],
  rationale: "Required behavior",
});
const graph = (tasks: ReturnType<typeof task>[]): TaskGraph =>
  ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(MARKDOWN), tasks }) as TaskGraph;
const EMPTY = graph([task("T001", "Write the value", []), task("T002", "Write README.md", [])]);
const WRITING = graph([task("T001", "Write the value", [{ path: "value.txt", action: "create" }])]);

/** The planner first submits tasks with no writes, then corrects them when the host says so. */
class EmptyWritesPlanner extends FixtureExecutor {
  planErrors: string[][] = [];
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "plan") return super.execute(request);
    this.calls.push("plan");
    let output: unknown = { schemaVersion: 1, markdown: MARKDOWN, taskGraph: EMPTY };
    for (let i = 0; i < 3; i++) {
      const errors = request.validate?.(output) ?? [];
      this.planErrors.push(errors);
      if (!errors.length) break;
      output = { schemaVersion: 1, markdown: MARKDOWN, taskGraph: WRITING };
    }
    return { output, inputTokens: 25, outputTokens: 25 };
  }
}

describe("scenario: a plan whose tasks write no files (#3066)", () => {
  test("validateTaskGraph refuses a planned task with no writes, naming it", () => {
    const errors = validateTaskGraph(fixtureSpec, EMPTY);
    expect(errors).toContain(
      "task T001 writes no files: list every file it creates, modifies or deletes in writes, or merge it into a task that does",
    );
    expect(errors.filter((e) => e.includes("writes no files"))).toHaveLength(2);
    expect(errors).toContain("no planned task writes a file: every file the request needs must be in some task's writes");
    expect(validateTaskGraph(fixtureSpec, WRITING)).toEqual([]);
    // A verification task closed by its checks writes nothing, beside a task that writes.
    const verify = graph([task("T001", "Write the value", [{ path: "value.txt", action: "create" }]), { ...task("T002", "Verify value", []), checkIds: ["check"] }]);
    expect(validateTaskGraph(fixtureSpec, verify)).toEqual([]);
    // Checks alone never make a plan that writes nothing acceptable.
    const checksOnly = graph([{ ...task("T001", "Write the value", []), checkIds: ["check"] }]);
    expect(validateTaskGraph(fixtureSpec, checksOnly)).toContain("no planned task writes a file: every file the request needs must be in some task's writes");
    // A repair or convergence task is the host's, not the planner's: not judged here.
    const repair = graph([{ ...task("T001", "Write the value", [{ path: "value.txt", action: "create" }]) }, { ...task("T002", "Fix", []), origin: "repair" as never }]);
    expect(validateTaskGraph(fixtureSpec, repair).filter((e) => e.includes("writes no files"))).toEqual([]);
  });

  test("the plan goes back to the planner before approval, and the corrected plan is implemented by a session", async () => {
    const fixture = workflowFixture({ executor: (root) => new EmptyWritesPlanner(root) });
    disposals.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const run = await fixture.start();
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.planErrors[0]?.some((e) => e.includes("task T001 writes no files"))).toBe(true);
    expect(executor.planErrors.at(-1)).toEqual([]);
    const pending = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!pending) throw new Error("no approval request");
    const current = await service.get(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "approve", requestId: pending.id, digest: pending.digest });
    const final = await service.drive(run.runId, new AbortController().signal);
    expect(final.status).toBe("completed");
    expect(executor.calls).toContain("implementation");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  });
});
