import { describe, expect, test } from "bun:test";
import {
  coveringChecks,
  isStaticCheck,
  taskCheckList,
  withCoveringChecks,
} from "../src/core/workflows/check-policy.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { Check, Task } from "../src/core/workflows/types.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

const check = (id: string, args: string[], scope: Check["scope"], fix = false): Check => ({
  id,
  executable: "bun",
  args,
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope,
  envNames: [],
  writes: [],
  ...(fix ? { fix: { executable: "bun", args: ["x", "biome", "check", "--write"] } } : {}),
});

// Bench round 03, md-site 93fbee70: T001-T003 named typecheck only; the lint error in src/site.ts
// surfaced in test task T006, which cannot write that file.
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [
    check("typecheck", ["run", "typecheck"], "task"),
    check("lint", ["x", "biome", "check", "."], "feature", true),
    check("test", ["test"], "feature"),
  ],
};

const task = (id: string, paths: string[], checkIds: string[]): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })),
  readHints: [],
  checkIds,
  origin: "planned",
  findingIds: [],
  rationale: id,
});

describe("checks that cover a task's files", () => {
  test("static feature checks are recognized, test suites are not", () => {
    expect(isStaticCheck(policy.checks[1] as Check)).toBe(true);
    expect(isStaticCheck(policy.checks[2] as Check)).toBe(false);
    expect(isStaticCheck(check("ruff", ["-m", "ruff", "check", "."], "feature"))).toBe(true);
  });

  test("a code task gets lint, a docs-only task does not", () => {
    expect(coveringChecks(policy, task("T001", ["src/site.ts"], [])).map((c) => c.id)).toEqual([
      "lint",
    ]);
    expect(coveringChecks(policy, task("T002", ["README.md"], []))).toEqual([]);
  });

  test("the plan keeps the planner's checks and gains the covering ones", () => {
    const graph = {
      tasks: [
        task("T001", ["src/site.ts"], ["typecheck"]),
        task("T002", ["README.md"], []),
        task("T003", ["tests/site.test.ts"], ["lint"]),
      ],
    } as unknown as TaskGraph;
    const out = withCoveringChecks(graph, policy);
    expect(out.tasks.map((t) => t.checkIds)).toEqual([["typecheck", "lint"], [], ["lint"]]);
  });

  test("the host runs task-scope checks and covering feature checks only", () => {
    const code = task("T001", ["src/site.ts"], ["typecheck", "lint", "test"]);
    expect(taskCheckList(policy, code).map((c) => c.id)).toEqual(["typecheck", "lint"]);
    const docs = task("T002", ["README.md"], ["typecheck", "lint"]);
    expect(taskCheckList(policy, docs).map((c) => c.id)).toEqual(["typecheck"]);
  });
});
