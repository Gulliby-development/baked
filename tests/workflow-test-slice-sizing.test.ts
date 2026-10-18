import { describe, expect, test } from "bun:test";
import { criterionCases, type SpecText } from "../src/core/verification/criteria-cases.js";
import { hostSplitParts } from "../src/core/workflows/analysis-notes.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { TaskGraphSchema, type TaskGraph } from "../src/core/workflows/schemas.js";
import { caseRate, perFileRates, plannerSizing, sizePlan, splitNote, splitTestTasks, type SizingSample } from "../src/core/workflows/sizing.js";
import { failureOwner } from "../src/core/workflows/task-graph.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import type { Task } from "../src/core/workflows/types.js";

const ids = Array.from({ length: 6 }, (_, i) => `AC-${String(i + 1).padStart(3, "0")}`);
const task = (id: string, path: string, criterionIds = ids): Task => ({
  id, title: id, description: id, requirementIds: ["FR-001"], criterionIds, dependsOn: [],
  profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: id,
});
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const policy = { ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 600_000 } };
const sample = (more: Partial<SizingSample> = {}): SizingSample => ({
  runId: "history", taskId: "T001", kind: "test", action: "create", source: "project", files: 4, tokens: 800_000, model: "m", criteria: 8, cases: 20, ...more,
});
const history = [sample(), sample()];
const spec = (rows: number): SpecText => ({ criteria: ids.map((id, index) => ({
  id, requirementIds: ["FR-001"], method: "automated", given: "a CLI input", when: "it runs",
  then: `input | expected\n--- | ---\n${Array.from({ length: Math.floor(rows / 6) + (index < rows % 6 ? 1 : 0) }, (_, i) => `value-${index}-${i} | ok`).join("\n")}`,
})) });
const size = (g: TaskGraph, samples = history, text?: SpecText) => sizePlan({ graph: g, policy, samples, spent: 0, spec: text });

describe("literal case pricing and sequential test slices (#1562)", () => {
  test("six criteria with forty table rows cost more than six criteria with six rows", () => {
    const g = graph(task("T001", "tests/cli.test.ts"));
    const small = size(g, history, spec(6));
    const large = size(g, history, spec(40));
    expect(small.tasks[0]!.cases).toBe(6);
    expect(large.tasks[0]!.cases).toBe(40);
    expect(large.tasks[0]!.estimate.high).toBe(1_600_000);
    expect(large.tasks[0]!.estimate.high).toBeGreaterThan(small.tasks[0]!.estimate.high);
    expect(large.tasks[0]!.attemptTokens).toBe(600_000);
    expect(large.decision).toBe("split-tasks");
    const split = splitTestTasks(g, large, spec(40))!;
    const sized = size(split, history, spec(40));
    expect(split.tasks.length).toBeGreaterThan(1);
    expect(sized.tasks.every((t) => !t.oversized && t.estimate.high <= 600_000)).toBe(true);
    expect(split.tasks.flatMap((t) => t.criterionIds)).toEqual(ids);
    expect(sized.tasks.reduce((n, t) => n + (t.cases ?? 0), 0)).toBe(40);
    expect(TaskGraphSchema.safeParse(split).success).toBe(true);
  });

  test("case rates use project and model history and leave old history usable", () => {
    expect(caseRate([sample({ cases: undefined }), sample({ cases: 0 })])).toBeNull();
    expect(caseRate([sample()])).toBeNull();
    const samples = [...history, sample({ source: "shared", tokens: 8_000_000 }), sample({ source: "shared", tokens: 8_000_000 })];
    expect(caseRate(samples)).toMatchObject({ basis: "project", perCase: { low: 40_000, high: 40_000 }, samples: 2 });
    samples.push(sample({ model: "other", tokens: 1_600_000 }), sample({ model: "other", tokens: 1_600_000 }));
    expect(caseRate(samples, "other")).toMatchObject({ model: "other", perCase: { low: 80_000, high: 80_000 } });
    expect(perFileRates(history).test.create.perFile.high).toBe(200_000);
    expect(size(graph(task("T001", "src/cli.ts")), history, spec(40)).tasks[0]!.estimate.high).toBe(100_000);
  });

  test("a modified single file above 1.39M splits without a case rate and preserves deletes once", () => {
    const original = { ...task("T002", "internal/cli/cli_test.go"), dependsOn: ["T001"], writes: [{ path: "internal/cli/cli_test.go", action: "modify" as const }, { path: "tests/old_test.go", action: "delete" as const }] };
    const g = graph(task("T001", "internal/cli/cli.go"), original, { ...task("T003", "README.md"), dependsOn: ["T002"] });
    const samples = [sample({ action: "modify", files: 1, tokens: 1_390_000, criteria: undefined, cases: undefined }), sample({ action: "modify", files: 1, tokens: 1_390_000, criteria: undefined, cases: undefined })];
    const report = size(g, samples);
    expect(report.tasks.find((t) => t.taskId === "T002")!.oversized).toBe(true);
    const split = splitTestTasks(g, report)!;
    const parts = split.tasks.filter((t) => t.sizingSlice);
    expect(parts).toHaveLength(3);
    expect(parts.every((t) => t.writes[0]!.action === "modify")).toBe(true);
    expect(parts.flatMap((t) => t.writes).filter((w) => w.action === "delete")).toHaveLength(1);
    expect(parts.every((t) => t.checkIds.includes("tests") && t.dependsOn.includes("T001"))).toBe(true);
    expect(hostSplitParts(split)).toEqual({ T002: parts.map((t) => t.id) });
    expect(size(split, samples).tasks.filter((t) => t.kind === "test").every((t) => !t.oversized)).toBe(true);
    expect(splitTestTasks(split, size(split, samples))).toBeNull();
  });

  test("file splitting continues into slices and different files remain independent", () => {
    const g = graph({ ...task("T001", "tests/a.test.ts"), writes: [{ path: "tests/a.test.ts", action: "create" }, { path: "tests/b.test.ts", action: "create" }] });
    const split = splitTestTasks(g, size(g, history, spec(40)), spec(40))!;
    const first = split.tasks.filter((t) => t.writes[0]!.path === "tests/a.test.ts");
    const second = split.tasks.filter((t) => t.writes[0]!.path === "tests/b.test.ts");
    expect(first.length).toBeGreaterThan(1);
    expect(second.length).toBeGreaterThan(1);
    expect(first[0]!.dependsOn).toEqual([]);
    expect(second[0]!.dependsOn).toEqual([]);
    expect(split.tasks.flatMap((t) => t.writes).filter((w) => w.action === "create")).toHaveLength(2);
    expect(size(split, history, spec(40)).tasks.every((t) => !t.oversized)).toBe(true);
  });

  test("an indivisible criterion keeps its cases and asks for batches within the attempt", () => {
    const text: SpecText = { criteria: [{ ...spec(6).criteria[0]!, then: Array.from({ length: 40 }, (_, i) => `"input-${i}"`).join(" ") }] };
    const g = graph(task("T001", "tests/test_cli.py", [ids[0]!]));
    const report = size(g, history, text);
    const split = splitTestTasks(g, report, text)!;
    expect(split.tasks).toHaveLength(1);
    expect(split.tasks[0]!.criterionIds).toEqual([ids[0]!]);
    expect(criterionCases(text, split.tasks[0]!).length).toBe(40);
    expect(split.tasks[0]!.description).toContain("small batches inside this attempt");
    expect(report.tasks[0]!.sliceCount).toBe(1);
    expect(plannerSizing(policy, history).note).toContain("Each literal test case");
    expect(plannerSizing(policy, history).note).toContain("create it first, then modify it");
    expect(splitNote(report, 2)).toContain("sequential criterion slices");
  });

  test("new-file slices wait for every existing-file slice and retain failure ownership", () => {
    const source = task("T001", "src/cli.ts");
    const tests = { ...task("T002", "tests/new.test.ts"), dependsOn: [source.id], writes: [
      { path: "tests/new.test.ts", action: "create" as const },
      { path: "tests/old.test.ts", action: "modify" as const, reason: "Update legacy expectations" },
    ] };
    const g = graph(source, tests, { ...task("T003", "README.md"), dependsOn: [tests.id] });
    const split = splitTestTasks(g, size(g, history, spec(40)), spec(40))!;
    const fresh = split.tasks.filter((t) => t.writes[0]?.path === "tests/new.test.ts");
    const updates = split.tasks.filter((t) => t.writes[0]?.path === "tests/old.test.ts");
    expect(fresh.length).toBeGreaterThan(1);
    expect(updates.length).toBeGreaterThan(1);
    for (const [index, part] of fresh.entries()) {
      expect(part.dependsOn).toEqual([source.id, ...(index ? [fresh[index - 1]!.id] : []), ...updates.map((t) => t.id)]);
    }
    for (const [index, part] of updates.entries()) {
      expect(part.dependsOn).toEqual([source.id, ...(index ? [updates[index - 1]!.id] : [])]);
    }
    expect(split.tasks.find((t) => t.id === "T003")!.dependsOn).toEqual([...fresh, ...updates].map((t) => t.id));
    const rows = split.tasks.map((t) => ({ id: t.id, status: t.id === source.id ? "verified" : "pending" }) as TaskRow);
    expect(failureOwner(split, rows, {}, source, "tests/old.test.ts:1: error")).toMatchObject({ kind: "test-update", owners: updates.map((t) => t.id) });
    for (const part of [...fresh, ...updates]) {
      expect(failureOwner(split, rows, {}, part, "at cli (/work/src/cli.ts:4:1)")).toMatchObject({ kind: "finished", owners: [source.id] });
      expect(failureOwner(split, rows, {}, part, `${part.writes[0]!.path}:1: error`)).toMatchObject({ kind: "self", owners: [] });
    }
    expect(TaskGraphSchema.safeParse(split).success).toBe(true);
    expect(size(split, history, spec(40)).tasks.filter((t) => t.kind === "test").every((t) => !t.oversized)).toBe(true);
  });

  test("a file that fits after splitting by file needs no modification slices", () => {
    const samples = [
      sample({ files: 1, tokens: 400_000, criteria: undefined, cases: undefined }),
      sample({ files: 1, tokens: 400_000, criteria: undefined, cases: undefined }),
      sample({ action: "modify", files: 1, tokens: 2_000_000, criteria: undefined, cases: undefined }),
      sample({ action: "modify", files: 1, tokens: 2_000_000, criteria: undefined, cases: undefined }),
    ];
    const g = graph({ ...task("T001", "tests/a.test.ts"), writes: [{ path: "tests/a.test.ts", action: "create" }, { path: "tests/b.test.ts", action: "create" }] });
    const split = splitTestTasks(g, size(g, samples))!;
    expect(split.tasks).toHaveLength(2);
    expect(split.tasks.every((t) => !t.sizingSlice && t.writes[0]!.action === "create")).toBe(true);
    expect(size(split, samples).tasks.every((t) => !t.oversized)).toBe(true);
  });
});
