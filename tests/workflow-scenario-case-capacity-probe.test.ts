import { describe, expect, test } from "bun:test";
import type { SpecText } from "../src/core/verification/criteria-cases.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import { CAPACITY_PROBE, plannerSizing, sizePlan, splitTestTasks, type SizingSample } from "../src/core/workflows/sizing.js";
import type { Task } from "../src/core/workflows/types.js";

// Bench round 53 (#1789): the controls' history held finished test tasks of at most 4 literal
// cases priced 132k-429k tokens. Splitting every test file above 4 cases cut url-shortener's 8
// planned tasks into 20 slices and spent 5.78M tokens against 3.42M. A file within
// CAPACITY_PROBE times the capacity whose price fits one attempt now stays whole.
const ids = Array.from({ length: 6 }, (_, i) => `AC-${String(i + 1).padStart(3, "0")}`);
const task = (id: string, path: string): Task => ({
  id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ids, dependsOn: [],
  profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: id,
});
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "url-shortener", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const policy = { ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 600_000 } };
const history: SizingSample[] = [132_000, 210_000, 280_000, 340_000, 390_000, 429_000].map((tokens, index) => ({
  runId: `control-${index}`, taskId: "T004", kind: "test", action: "create", source: "project", files: 1, tokens, model: "m", criteria: 2, cases: 2 + (index % 3),
}));
const spec = (rows: number): SpecText => ({ criteria: ids.map((id, index) => ({
  id, requirementIds: ["FR-001"], method: "automated", given: "a short URL", when: "it is resolved",
  then: `input | expected\n--- | ---\n${Array.from({ length: Math.floor(rows / 6) + (index < rows % 6 ? 1 : 0) }, (_, i) => `slug-${index}-${i} | ok`).join("\n")}`,
})) });
const size = (g: TaskGraph, rows: number, samples = history) => sizePlan({ graph: g, policy, samples, spent: 0, spec: spec(rows) });

// One test path per supported toolchain: the decision depends on the case count and price, not the language.
const paths = [
  "tests/shortener.test.ts", "tests/test_shortener.py", "shortener/shortener_test.go", "tests/shortener.rs",
  "tests/ShortenerTests.cs", "src/test/java/app/ShortenerTest.java", "spec/shortener_spec.rb", "test/shortener_test.exs",
];

describe("test tasks keep whole above the observed case capacity (#1789)", () => {
  test("the history holds a capacity of 4 cases and a price within one attempt", () => {
    const report = size(graph(task("T004", paths[0]!)), 15);
    expect(report.testTaskLimit?.cases).toBe(4);
    expect(report.tasks[0]!.estimate.high).toBeLessThan(600_000);
  });

  for (const path of paths)
    test(`a 15-case file stays one task at capacity 4: ${path}`, () => {
      const g = graph(task("T004", path));
      const report = size(g, 15);
      expect(report.tasks[0]!.kind).toBe("test");
      expect(report.tasks[0]!.cases).toBe(15);
      expect(report.tasks[0]!.oversized).toBe(false);
      expect(report.decision).not.toBe("split-tasks");
      expect(splitTestTasks(g, report, spec(15))).toBeNull();
    });

  for (const path of paths)
    test(`a file above ${CAPACITY_PROBE} times the capacity still splits: ${path}`, () => {
      const g = graph(task("T004", path));
      const report = size(g, 4 * CAPACITY_PROBE + 2);
      expect(report.tasks[0]!.oversized).toBe(true);
      expect(report.reasons.join("\n")).toContain(`above ${CAPACITY_PROBE} times the observed capacity of 4`);
      const split = splitTestTasks(g, report, spec(4 * CAPACITY_PROBE + 2))!;
      expect(split.tasks.length).toBe(2);
      expect(size(split, 4 * CAPACITY_PROBE + 2).tasks.every((t) => !t.oversized)).toBe(true);
    });

  test("a file within the probe still splits when its price is above one attempt", () => {
    const costly = history.map((s) => ({ ...s, tokens: s.tokens * 3 }));
    const g = graph(task("T004", paths[0]!));
    const report = size(g, 15, costly);
    expect(report.tasks[0]!.oversized).toBe(true);
    expect(report.reasons.join("\n")).toContain("above one attempt's 600000");
    expect(splitTestTasks(g, report, spec(15))).not.toBeNull();
  });

  test("the planner is told to keep test files whole up to the probe", () => {
    const note = plannerSizing(policy, history).note;
    expect(note).toContain(`Keep a test task whole up to ${4 * CAPACITY_PROBE} literal cases`);
    expect(note).not.toContain("Split test tasks proactively only above 4 cases");
  });
});
