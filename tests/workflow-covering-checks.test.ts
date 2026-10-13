import { describe, expect, test } from "bun:test";
import {
  coveringChecks,
  isStaticCheck,
  isWholeUnitCheck,
  isWholeUnitFormatter,
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

// Bench round 08, commitbump cd842f0f: `cargo clippy` ran in the worktree of T001, whose lib.rs
// declared modules that T002 writes, and failed with E0583 until 2.2M tokens of repairs ran out.
describe("whole-unit checks are not covering checks", () => {
  const cargo = (id: string, args: string[]): Check => ({
    ...check(id, args, "feature"),
    executable: "cargo",
  });
  const rust: RunPolicy = {
    ...fixturePolicy,
    checks: [
      { ...cargo("cargo-fmt", ["fmt", "--check"]), fix: { executable: "cargo", args: ["fmt"] } },
      cargo("cargo-clippy", ["clippy", "--all-targets", "--", "-D", "warnings"]),
      cargo("cargo-check", ["check"]),
      cargo("cargo-test", ["test"]),
    ],
  };

  test("clippy, cargo check, cargo fmt, go vet, tsc, mypy and pyright are whole-unit", () => {
    for (const [executable, args] of [
      ["cargo", ["clippy"]],
      ["cargo", ["fmt", "--check"]],
      ["rustfmt", ["--check", "src/lib.rs"]],
      ["cargo", ["check", "--all-targets"]],
      ["go", ["vet", "./..."]],
      ["bun", ["x", "tsc", "--noEmit"]],
      ["bun", ["run", "typecheck"]],
      ["python", ["-m", "mypy", "."]],
      ["pyright", []],
    ] as const)
      expect(isWholeUnitCheck({ ...check("c", [...args], "feature"), executable })).toBe(true);
  });

  test("cargo fmt and rustfmt are whole-unit formatters; clippy, cargo check and gofmt are not (#842)", () => {
    const run = (executable: string, args: string[]) =>
      isWholeUnitFormatter({ ...check("c", args, "feature"), executable });
    expect(run("cargo", ["fmt", "--check"])).toBe(true);
    expect(run("rustfmt", ["--check", "src/lib.rs"])).toBe(true);
    expect(run("cargo", ["clippy"])).toBe(false);
    expect(run("cargo", ["check"])).toBe(false);
    expect(run("bun", ["x", "tsc", "--noEmit"])).toBe(false);
    expect(run("gofmt", ["-l", "."])).toBe(false);
  });

  test("other formatters and file-local linters stay per task", () => {
    expect(isWholeUnitCheck(check("gofmt", ["-l", "."], "feature", true))).toBe(false);
    expect(isWholeUnitCheck(check("lint", ["x", "biome", "check", "."], "feature", true))).toBe(false);
    expect(isWholeUnitCheck(check("ruff", ["-m", "ruff", "check", "."], "feature"))).toBe(false);
    expect(isWholeUnitCheck(cargo("cargo-test", ["test"]))).toBe(false);
  });

  // Bench round 11, mdrefs: `cargo fmt --check` in the skeleton task's worktree failed on the
  // `mod check;` whose file a later task writes, and blocked the ten planned tasks behind it.
  test("a Rust code task runs no cargo check per task; fmt, clippy and cargo check wait for the checks stage", () => {
    const lib = task("T001", ["src/lib.rs"], []);
    expect(coveringChecks(rust, lib).map((c) => c.id)).toEqual([]);
    const graph = { tasks: [lib, task("T002", ["src/parse.rs"], ["cargo-clippy"])] } as unknown as TaskGraph;
    expect(withCoveringChecks(graph, rust).tasks.map((t) => t.checkIds)).toEqual([[], ["cargo-clippy"]]);
    // A feature check the planner named is still not run per task: only covering ones are.
    expect(
      taskCheckList(rust, task("T002", ["src/parse.rs"], ["cargo-clippy", "cargo-fmt"])).map((c) => c.id),
    ).toEqual([]);
  });
});
