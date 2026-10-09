import { describe, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { evaluateAutoApproval } from "../src/core/workflows/auto-approval.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  type InputManifest,
  PolicySchema,
  type RunPolicy,
  type Spec,
  type TaskGraph,
} from "../src/core/workflows/schemas.js";
import type { RequestRow } from "../src/core/workflows/store.js";

const hash = "a".repeat(64);
const manifest: InputManifest = {
  schemaVersion: 1,
  featureId: "fixture",
  workflowHash: hash,
  policyHash: hash,
  profileHashes: { implementer: hash },
  skillHashes: {},
  instructionHashes: [],
  constitutionHash: null,
  specHash: hash,
  planHash: hash,
  rootGraphHash: hash,
  effectiveGraphHash: hash,
  correctionHashes: [],
  baselineSnapshotId: null,
  dependencyContracts: [],
};
const spec: Spec = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  title: "Fixture",
  problem: "Missing value",
  outcome: "Value exists",
  inScope: ["Create value"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  requirements: [
    { id: "FR-001", text: "Value", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    {
      id: "AC-001",
      requirementIds: ["FR-001"],
      given: "a workspace",
      when: "the task completes",
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the acceptance-criterion contract.
      then: "value is ready",
      method: "automated",
    },
  ],
  dependencies: [],
};
type Write = TaskGraph["tasks"][number]["writes"][number];
function graph(...writes: Write[][]): TaskGraph {
  return {
    schemaVersion: 1,
    featureId: "fixture",
    revision: 1,
    specHash: hash,
    planHash: hash,
    tasks: writes.map((w, index) => ({
      id: `T00${index + 1}`,
      title: "Task",
      description: "Task",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: "implementer",
      writes: w,
      readHints: [],
      checkIds: [],
      origin: "planned",
      findingIds: [],
      rationale: "Required",
    })),
  };
}
const limits = {
  maxTasks: 2,
  maxFiles: 3,
  allowedPaths: ["src/**", "tests/**"],
  allowDelete: false,
  allowNewDependencies: false as const,
  maxTotalTokens: 400000,
};
const limited: RunPolicy = { ...defaultWorkflowPolicy, autoApproval: { renewal: false, limits } };
const renewing: RunPolicy = { ...defaultWorkflowPolicy, autoApproval: { renewal: true, limits: null } };
const modify = (path: string): Write => ({ path, action: "modify" });
function approved(policy: RunPolicy, writes: Write[], actor = "user"): RequestRow {
  return {
    id: "request",
    kind: "approval",
    status: "accepted",
    digest: hash,
    body_json: canonical({ manifest, writes, checks: policy.checks, policy }),
    answer_json: null,
    actor,
  };
}

describe("auto approval", () => {
  test("is off without a policy setting", () => {
    expect(evaluateAutoApproval(defaultWorkflowPolicy, manifest, spec, graph([modify("src/a.ts")]), [])).toEqual({ approval: null, reasons: [] });
  });
  test("the schema rejects auto approval without limits or with new dependencies", () => {
    expect(PolicySchema.safeParse({ ...defaultWorkflowPolicy, autoApproval: { renewal: false, limits: null } }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...defaultWorkflowPolicy, autoApproval: { renewal: false, limits: { ...limits, allowNewDependencies: true } } }).success).toBe(false);
    expect(PolicySchema.parse(limited).autoApproval?.limits?.maxTasks).toBe(2);
  });
  test("approves a package inside the limits", () => {
    const result = evaluateAutoApproval(limited, manifest, spec, graph([modify("src/a.ts")], [modify("tests/a.test.ts")]), []);
    expect(result.approval?.mode).toBe("limits");
    expect(result.approval?.limitsHash).toHaveLength(64);
  });
  const outside: [string, RunPolicy, TaskGraph, string][] = [
    ["too many tasks", limited, graph([modify("src/a.ts")], [modify("src/b.ts")], [modify("src/c.ts")]), "3 tasks exceed 2"],
    ["too many files", limited, graph([modify("src/a.ts"), modify("src/b.ts"), modify("src/c.ts"), modify("src/d.ts")]), "4 files exceed 3"],
    ["a path outside the globs", limited, graph([modify("scripts/run.ts")]), "scripts/run.ts is outside"],
    ["a delete", limited, graph([{ path: "src/a.ts", action: "delete" }]), "src/a.ts would be deleted"],
    ["a larger token budget", { ...limited, maxTotalTokens: 500000 }, graph([modify("src/a.ts")]), "token budget"],
    ["a package manifest", { ...limited, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] } } }, graph([modify("package.json")]), "always needs a person"],
    ["a lock file", { ...limited, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] } } }, graph([modify("bun.lock")]), "always needs a person"],
    ["CI configuration", { ...limited, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] } } }, graph([modify(".github/workflows/ci.yml")]), "always needs a person"],
    ["project instructions in any case", { ...limited, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] } } }, graph([modify("src/agents.md")]), "always needs a person"],
    ["a workflow definition", { ...limited, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] } } }, graph([modify("baked/workflows/sdd.json")]), "always needs a person"],
  ];
  for (const [name, policy, tasks, reason] of outside)
    test(`falls back to a person for ${name}`, () => {
      const result = evaluateAutoApproval(policy, manifest, spec, tasks, []);
      expect(result.approval).toBeNull();
      expect(result.reasons.join("\n")).toContain(reason);
    });
  test("glob matching ignores case like Windows paths", () => {
    expect(evaluateAutoApproval(limited, manifest, spec, graph([modify("SRC/A.ts")]), []).approval?.mode).toBe("limits");
  });
  test("ordinary names that contain lock are not treated as lock files", () => {
    expect(evaluateAutoApproval(limited, manifest, spec, graph([modify("src/block.ts"), modify("src/clock.ts")]), []).approval?.mode).toBe("limits");
  });
  test("deferring post-release criteria needs a person", () => {
    const deferred = { ...spec, criteria: spec.criteria.map((c) => ({ ...c, method: "post-release" as const })) };
    expect(evaluateAutoApproval(limited, manifest, deferred, graph([modify("src/a.ts")]), []).approval).toBeNull();
  });
  test("renews within the last human approval", () => {
    const previous = approved(renewing, [modify("src/a.ts"), modify("src/b.ts")]);
    const result = evaluateAutoApproval(renewing, manifest, spec, graph([modify("src/a.ts")]), [previous]);
    expect(result.approval?.mode).toBe("renewal");
    const lower = { ...renewing, maxTotalTokens: 300000, maxAgentSteps: 10 };
    expect(evaluateAutoApproval(lower, manifest, spec, graph([modify("src/a.ts")]), [previous]).approval?.mode).toBe("renewal");
  });
  const widened: [string, RunPolicy, TaskGraph, RequestRow[], string][] = [
    ["no earlier approval", renewing, graph([modify("src/a.ts")]), [], "no earlier human approval"],
    ["an earlier automatic approval only", renewing, graph([modify("src/a.ts")]), [approved(renewing, [modify("src/a.ts")], "auto-approval")], "no earlier human approval"],
    ["a new file", renewing, graph([modify("src/c.ts")]), [approved(renewing, [modify("src/a.ts")])], "modify src/c.ts was not approved"],
    ["a new delete", renewing, graph([{ path: "src/a.ts", action: "delete" }]), [approved(renewing, [modify("src/a.ts")])], "delete src/a.ts was not approved"],
    ["a larger budget", { ...renewing, maxTotalTokens: 900000 }, graph([modify("src/a.ts")]), [approved(renewing, [modify("src/a.ts")])], "maxTotalTokens grew"],
    ["changed checks", { ...renewing, checks: [{ id: "lint", executable: "bun", args: ["run", "lint"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] }, graph([modify("src/a.ts")]), [approved(renewing, [modify("src/a.ts")])], "checks, tools or other policy settings changed"],
    ["auto approval enabled after the human approval", renewing, graph([modify("src/a.ts")]), [approved(defaultWorkflowPolicy, [modify("src/a.ts")])], "checks, tools or other policy settings changed"],
    ["an approval without a recorded policy", renewing, graph([modify("src/a.ts")]), [{ ...approved(renewing, [modify("src/a.ts")]), body_json: canonical({ manifest, writes: [modify("src/a.ts")] }) }], "does not record its scope"],
  ];
  for (const [name, policy, tasks, requests, reason] of widened)
    test(`does not renew after ${name}`, () => {
      const result = evaluateAutoApproval(policy, manifest, spec, tasks, requests);
      expect(result.approval).toBeNull();
      expect(result.reasons.join("\n")).toContain(reason);
    });
  test("does not renew when the frozen profiles changed", () => {
    const previous = approved(renewing, [modify("src/a.ts")]);
    const changed = { ...manifest, profileHashes: { implementer: "b".repeat(64) } };
    expect(evaluateAutoApproval(renewing, changed, spec, graph([modify("src/a.ts")]), [previous]).reasons).toContain("Renewal: profileHashes changed");
  });
});
