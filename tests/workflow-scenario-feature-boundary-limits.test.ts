import { describe, expect, test } from "bun:test";
import { evaluateAutoApproval } from "../src/core/workflows/auto-approval.js";
import type { InitiativeFeature } from "../src/core/workflows/initiatives/plan.js";
import { boundaryLimits, featurePolicy, type InitiativeSettings } from "../src/core/workflows/initiatives/service.js";
import { fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";

type Graph = Parameters<typeof evaluateAutoApproval>[3];

// narrowfit R35 language 6215e3d5: the approved boundary named 11 files and the planner wrote one
// task per file; tiered approval with --max-tasks 5 --max-files 10 sent the plan to a person.
const files = [
  "build.go",
  "exprparse.go",
  "parse.go",
  "parse_test.go",
  "exprparse_test.go",
  "kind_range_test.go",
  "kind_enum_test.go",
  "kind_regex_test.go",
  "kind_len_test.go",
  "kind_required_test.go",
  "kind_unique_test.go",
];
const feature = (paths: string[]): InitiativeFeature => ({
  id: "language",
  title: "Constraint language",
  boundary: { scope: "The constraint parser and its tests", paths },
  contract: "Parse returns the constraints",
  dependsOn: [],
  mandatory: true,
});
const settings = {
  basePolicy: fixturePolicy,
  featureAutoApproval: { maxTasks: 5, maxFiles: 10 },
} as unknown as InitiativeSettings;
const share = { tokens: 2_000_000, calls: 200, activeMs: 3_600_000 };
const onePerFile = (paths: string[]): Graph =>
  ({
    tasks: paths.map((path, i) => ({
      id: `T${String(i + 1).padStart(3, "0")}`,
      title: `Write ${path}`,
      description: `Write ${path}`,
      dependsOn: [],
      writes: [{ path, action: "create" }],
      reads: [],
      criteria: ["AC-001"],
      verification: [],
    })),
  }) as unknown as Graph;
const decide = (boundary: string[], writes: string[]) =>
  evaluateAutoApproval(
    featurePolicy(settings, share, feature(boundary), false),
    {} as Parameters<typeof evaluateAutoApproval>[1],
    fixtureSpec,
    onePerFile(writes),
    [],
    [],
    { exists: () => false },
  );

describe("tiered approval limits follow the approved boundary (#1349)", () => {
  test("a plan writing the 11 boundary files, one task each, is approved without a person", () => {
    const result = decide(files, files);
    expect(result.reasons).toEqual([]);
    expect(result.approval?.mode).toBe("limits");
  });

  test("a write outside the boundary still needs a person", () => {
    const result = decide(files, [...files.slice(0, 10), "main.go"]);
    expect(result.approval).toBeNull();
    expect(result.reasons.join("\n")).toContain("main.go");
  });

  test("a glob boundary keeps the initiative's limits", () => {
    expect(boundaryLimits({ maxTasks: 5, maxFiles: 10 }, ["src/**", "README.md"])).toEqual({ maxTasks: 5, maxFiles: 10 });
    expect(boundaryLimits({ maxTasks: 5, maxFiles: 10 }, ["internal/**"])).toEqual({ maxTasks: 5, maxFiles: 10 });
    const result = decide(["internal/**"], files.map((f) => `internal/${f}`));
    expect(result.approval).toBeNull();
  });

  test("raised limits stay within what a definition accepts", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.go`);
    expect(boundaryLimits({ maxTasks: 5, maxFiles: 10 }, many)).toEqual({ maxTasks: 20, maxFiles: 20 });
    expect(boundaryLimits({ maxTasks: 5, maxFiles: 10 }, files)).toEqual({ maxTasks: 13, maxFiles: 11 });
  });
});
