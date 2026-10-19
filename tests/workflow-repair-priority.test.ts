import { describe, expect, test } from "bun:test";
import type { Task, TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { failureOwner, readyTasks, sameFailureAsOpenFinding } from "../src/core/workflows/task-graph.js";
import { planBatch } from "../src/core/workflows/parallel.js";
import { ASSERTION_FAILURES } from "./helpers/assertion-failures.js";

const task = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "modify" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Fixture" });
const source = task("T001", "src/differ.ts");
const tests = task("T003", "tests/command.test.ts", [source.id]);
const other = task("T004", "src/unrelated.ts");
const repair: Task = { ...task("T006", "src/differ.ts"), origin: "repair", findingIds: ["F1"] };
const graph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [source, tests, other, repair] };
const rows = [{ id: source.id, status: "verified" }, ...[tests, other, repair].map((t) => ({ id: t.id, status: "pending" }))] as TaskRow[];

describe("task repair priority (#1612)", () => {
  test("serial and parallel batches repair before downstream tasks while unrelated tasks remain ready", () => {
    const ready = readyTasks(graph, rows, {}, {}, { F1: source.id });
    expect(ready.map((t) => t.id)).toEqual([repair.id, other.id]);
    expect(planBatch(ready, 1, false, () => true).batch.map((t) => t.id)).toEqual([repair.id]);
    expect(planBatch(ready, 3, false, () => true).batch.map((t) => t.id)).toEqual([repair.id, other.id]);
    expect(readyTasks(graph, rows.map((r) => r.id === repair.id ? { ...r, status: "running" } : r), {}, {}, { F1: source.id }).map((t) => t.id)).toEqual([other.id]);
    expect(readyTasks(graph, rows.map((r) => r.id === repair.id ? { ...r, status: "verified" } : r), {}, {}, { F1: source.id }).map((t) => t.id)).toEqual([tests.id, other.id]);
  });
  test("does not delay a repair's own prerequisite or prioritize review convergence", () => {
    const dependent = { ...repair, dependsOn: [tests.id] };
    expect(readyTasks({ ...graph, tasks: [source, tests, other, dependent] }, rows, {}, {}, { F1: source.id }).map((t) => t.id)).toEqual([tests.id, other.id]);
    expect(readyTasks({ ...graph, tasks: [source, tests, { ...repair, origin: "convergence" }] }, rows, {}, {}, { F1: source.id }).map((t) => t.id)).toEqual([tests.id, repair.id]);
  });
  test("matching keeps assertion values, ignores ANSI and line numbers, and rejects mixed failures", () => {
    const open = [{ taskId: repair.id, output: "Expected: 2\nReceived: 1" }];
    expect(sameFailureAsOpenFinding("other.test.ts:900: Expected: 2\nReceived: 1", open)).toEqual([repair.id]);
    expect(sameFailureAsOpenFinding("Expected: 2\nReceived: 3", open)).toEqual([]);
    expect(sameFailureAsOpenFinding("Expected: 2\nReceived: 1\nAssertionError: unrelated defect", open)).toEqual([]);
    expect(sameFailureAsOpenFinding("\u001b[31mExpected: 2\u001b[0m\nReceived: 1", open)).toEqual([repair.id]);
    expect(sameFailureAsOpenFinding("other_test.go:9: got: 1, want: 2", [{ taskId: repair.id, output: "first_test.go:2: got: 1, want: 2" }])).toEqual([repair.id]);
    expect(sameFailureAsOpenFinding('Expected: "a b"\nReceived: "c"', [{ taskId: repair.id, output: 'Expected: "a  b"\nReceived: "c"' }])).toEqual([]);
    const options = { pendingFindings: [{ taskId: repair.id, output: ASSERTION_FAILURES.bun("Differ") }] };
    const withoutGate = rows.map((r) => r.id === repair.id ? { ...r, status: "implemented" } : r);
    expect(failureOwner(graph, withoutGate, {}, tests, ASSERTION_FAILURES.bun("Caller"), options).kind).toBe("pending");
    expect(failureOwner(graph, rows, {}, repair, ASSERTION_FAILURES.bun("Caller"), options).kind).not.toBe("pending");
  });
  test("multiline values must match in full and truncated headers never identify a failure", () => {
    const output = 'Expected: [\n  "removed",\n  "changed",\n]\nReceived: [\n  "changed",\n  "removed",\n]';
    const open = [{ taskId: repair.id, output }];
    expect(sameFailureAsOpenFinding(output, open)).toEqual([repair.id]);
    expect(sameFailureAsOpenFinding(output.replaceAll("changed", "added"), open)).toEqual([]);
    expect(sameFailureAsOpenFinding("Expected: [\n  1,", open)).toEqual([]);
    expect(sameFailureAsOpenFinding("Expected:\nReceived:", [{ taskId: repair.id, output: "Expected:\nReceived:" }])).toEqual([]);
  });
  test("identical assertion values in unrelated tasks do not claim a repair", () => {
    const options = { pendingFindings: [{ taskId: repair.id, output: "Expected: true\nReceived: false" }] };
    expect(failureOwner(graph, rows, {}, other, "Expected: true\nReceived: false", options).kind).not.toBe("pending");
    expect(failureOwner(graph, rows, {}, tests, "Expected: true\nReceived: false", options).kind).toBe("pending");
    expect(failureOwner(graph, rows, {}, { ...other, readHints: [source.writes[0]!.path] }, "Expected: true\nReceived: false", options).kind).toBe("pending");
  });
  for (const [stack, failure] of Object.entries(ASSERTION_FAILURES)) test(`${stack} waits for an open repair despite different test names`, () => {
    const options = { pendingFindings: [{ taskId: repair.id, output: failure("Differ") }] };
    expect(failureOwner(graph, rows, {}, tests, failure("Command"), options)).toMatchObject({ kind: "pending", owners: [repair.id] });
    expect(sameFailureAsOpenFinding(failure("Command"), options.pendingFindings)).toEqual([repair.id]);
    expect(failureOwner(graph, rows.map((r) => r.id === repair.id ? { ...r, status: "verified" } : r), {}, tests, failure("Command"), options).kind).not.toBe("pending");
    expect(failureOwner({ ...graph, tasks: [source, tests, { ...repair, dependsOn: [tests.id] }] }, rows, {}, tests, failure("Command"), options).kind).not.toBe("pending");
    expect(failureOwner(graph, rows, {}, tests, failure("Command"), { ...options, waitingFor: { [repair.id]: [tests.id] } }).kind).not.toBe("pending");
    expect(sameFailureAsOpenFinding(failure("Command").replaceAll("removed", "deleted"), options.pendingFindings)).toEqual([]);
    expect(sameFailureAsOpenFinding("1 test failed", options.pendingFindings)).toEqual([]);
  });
});
