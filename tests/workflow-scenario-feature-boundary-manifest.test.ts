import { describe, expect, test } from "bun:test";
import { evaluateAutoApproval } from "../src/core/workflows/auto-approval.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import {
  featurePolicy,
  featurePrompt,
  type InitiativeSettings,
} from "../src/core/workflows/initiatives/service.js";
import { fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";

type Graph = Parameters<typeof evaluateAutoApproval>[3];
type Row = Parameters<typeof featurePrompt>[0];

// vtsnap R33: the split gave the cli feature src/Vtsnap/Vtsnap.csproj, the person approved the
// split, and tiered approval still sent the feature's plan to a person for that one edit.
const csproj = "src/Vtsnap/Vtsnap.csproj";
const cli = {
  id: "cli",
  title: "Command line",
  boundary: { scope: "The console app; add only AssemblyName to the console project", paths: ["src/Vtsnap/**", csproj] },
  contract: "vtsnap runs from the command line",
  dependsOn: [],
  mandatory: true,
};
const plan: InitiativePlan = {
  schemaVersion: 1,
  title: "vtsnap",
  goals: ["A snapshot tool"],
  completionCriteria: ["vtsnap prints a snapshot"],
  features: [cli],
};
const settings = {
  basePolicy: fixturePolicy,
  featureAutoApproval: { maxTasks: 5, maxFiles: 10 },
} as unknown as InitiativeSettings;
const share = { tokens: 2_000_000, calls: 200, activeMs: 3_600_000 };
const graph = (path: string, action: "modify" | "delete" = "modify"): Graph =>
  ({
    tasks: [
      {
        id: "T-001",
        title: "Name the assembly",
        description: "Set AssemblyName",
        dependsOn: [],
        writes: [
          { path, action },
          { path: "src/Vtsnap/Program.cs", action: "modify" },
        ],
        reads: [],
        criteria: ["AC-001"],
        verification: [],
      },
    ],
  }) as unknown as Graph;
const request = featurePrompt({ id: "vtsnap", prompt: "Build vtsnap" } as Row, plan, cli, []);
const decide = (g: Graph, exists = true) =>
  evaluateAutoApproval(
    featurePolicy(settings, share, cli, false),
    {} as Parameters<typeof evaluateAutoApproval>[1],
    { ...fixtureSpec, deliverables: [{ quote: "vtsnap runs from the command line", requirementIds: ["FR-001"] }] },
    g,
    [],
    [],
    { request, exists: () => exists },
  );

describe("tiered approval of a manifest in the feature boundary (#1328)", () => {
  test("a feature that edits a project file its approved boundary names is approved without a person", () => {
    const result = decide(graph(csproj));
    expect(result.reasons).toEqual([]);
    expect(result.approval?.mode).toBe("limits");
  });

  test("deleting that project file still needs a person", () => {
    expect(decide(graph(csproj, "delete")).approval).toBeNull();
  });

  test("a manifest outside the boundary still needs a person", () => {
    const result = decide(graph("src/Other/Other.csproj"));
    expect(result.approval).toBeNull();
    expect(result.reasons.join("\n")).toContain("src/Other/Other.csproj");
  });
});
