import { expect, test } from "bun:test";
import { noteHostEdits } from "../src/core/workflows/analysis-notes.js";
import { hostOnlyEvidence, plannerGraph, recordGraphEdits, type HostEdit } from "../src/core/workflows/host-edits.js";
import { copiedTaskTexts, withCommandDependencies, withModuleDependencies, withReadDependencies } from "../src/core/workflows/plan-consistency.js";
import { withCoveringChecks } from "../src/core/workflows/check-policy.js";
import { codeTaskCheckProblems, sizePlan, splitTestTasks, withTestDependencies } from "../src/core/workflows/sizing.js";
import { withTestsFirstOrder } from "../src/core/workflows/tests-first.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

const task = (id: string, path: string): Task => ({ id, title: `Write ${path}`, description: `Implement the behavior in ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" });
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });

test("host evidence excludes mixed, planner and unrelated fields", () => {
  const edits: HostEdit[] = [{ task: "T002", field: "description", kind: "future-host-edit", before: "Planner instruction", after: "Planner instruction\nA new instruction from the host", text: "A new instruction from the host" }];
  const finding = { kind: "inconsistency", refs: ["tasks.json", "T002"], description: 'T002 adds "A new instruction from the host".' };
  expect(hostOnlyEvidence(finding, edits, "")).toEqual(edits);
  expect(hostOnlyEvidence({ ...finding, description: finding.description.replaceAll('"', "'") }, edits, "")).toEqual(edits);
  for (const changed of [
    { refs: ["spec.json", "T002"] },
    { refs: ["T002.description", "T003"] },
    { refs: ["T002.writes"] },
    { description: `${finding.description} This violates AC-001.` },
    { description: `${finding.description} The planner says "Planner instruction".` },
    { kind: "scope" },
  ]) expect(hostOnlyEvidence({ ...finding, ...changed }, edits, "")).toEqual([]);
  expect(hostOnlyEvidence(finding, edits, "A new instruction from the host")).toEqual([]);
  expect(hostOnlyEvidence({ ...finding, description: 'T002 adds "instruction".' }, edits, "")).toEqual([]);
});

for (const field of ["checkIds", "dependsOn"]) test(`precise ${field} references identify additions without taking ownership of planner values`, () => {
  const edits: HostEdit[] = [{ task: "T002", field, kind: "derived", before: ["planner-value"], after: ["planner-value", "host-value"], text: "" }];
  expect(hostOnlyEvidence({ kind: "inconsistency", refs: [`T002.${field}`], description: "Host field differs." }, edits, "")).toEqual(edits);
  expect(hostOnlyEvidence({ kind: "inconsistency", refs: [`T002.${field}`], description: 'The field contains "planner-value".' }, edits, "")).toEqual([]);
});

for (const [kind, input, transform] of [
  ["module", graph(task("T001", "src/index.ts"), task("T002", "src/value.ts")), withModuleDependencies],
  ["read", graph({ ...task("T001", "out.txt"), readHints: ["input.txt"] }, task("T002", "input.txt")), withReadDependencies],
  ["test", graph(task("T001", "tests/value.test.ts"), task("T002", "src/value.ts")), withTestDependencies],
  ["command", graph({ ...task("T001", "README.md"), description: "Run the CLI to capture example output" }, task("T002", "src/cli.ts")), withCommandDependencies],
  ["tests-first", graph(task("T001", "tests/value.test.ts"), task("T002", "src/value.ts")), withTestsFirstOrder],
] as const) test(`${kind} derivation records only the host delta and reverses to the planner graph`, () => {
  const edits: HostEdit[] = [];
  const changed = recordGraphEdits(input, transform(input), kind, edits);
  expect(edits.some((edit) => edit.field === "dependsOn")).toBe(true);
  expect(plannerGraph(changed, edits)).toEqual(input);
  expect(input.tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
});

test("covering check provenance does not hide the planner's missing typecheck", () => {
  const input = graph(task("T001", "src/value.ts"));
  const policy = { ...fixturePolicy, sizing: { maxAttemptTokens: 200_000 }, checks: ["lint", "typecheck"].map((id) => ({ ...fixturePolicy.checks[0]!, id, scope: id === "typecheck" ? "task" as const : "feature" as const, args: ["-e", "process.exit(0)"] })) };
  const edits: HostEdit[] = [];
  const changed = recordGraphEdits(input, withCoveringChecks(input, policy), "covering-checks", edits);
  expect(edits.some((edit) => edit.field === "checkIds")).toBe(true);
  expect(codeTaskCheckProblems(changed, policy, edits)).toHaveLength(1);
  expect(plannerGraph(changed, edits)).toEqual(input);
});

test("splits record inherited fields, host text and rewritten dependencies without duplicate descriptions", () => {
  const code = task("T001", "src/value.ts");
  const tests = { ...task("T002", "tests/one.test.ts"), writes: [{ path: "tests/one.test.ts", action: "modify" as const }, { path: "tests/two.test.ts", action: "create" as const }] };
  const input = graph(code, tests, { ...task("T003", "README.md"), dependsOn: ["T002"] });
  const policy = { ...fixturePolicy, sizing: { maxAttemptTokens: 200_000 } };
  const edits: HostEdit[] = [];
  const split = splitTestTasks(input, sizePlan({ graph: input, policy, samples: [], spent: 0 }), null, edits)!;
  expect(split.tasks.length).toBeGreaterThan(input.tasks.length);
  expect(edits.some((edit) => edit.field === "$task")).toBe(true);
  expect(edits.some((edit) => edit.text.includes("Existing-test updates"))).toBe(true);
  expect(plannerGraph(split, edits)).toEqual(input);
  expect(copiedTaskTexts(split, edits)).toEqual(copiedTaskTexts(input));
});

test("count notes attach the ledger entry", () => {
  const entry: HostEdit = { task: null, field: "hostCounts", kind: "counts", before: { tasks: 2, files: 2 }, after: { tasks: 3, files: 2 }, text: "" };
  const findings = [{ id: "COUNTS", kind: "inconsistency", refs: ["plan.md", "tasks.json"], description: "Plan says 2 tasks, graph has 3 tasks.", blocking: true }];
  expect(noteHostEdits(findings, [entry], "")).toEqual([{ findingId: "COUNTS", hostEdits: [entry] }]);
  expect(findings[0]!.blocking).toBe(false);
});
