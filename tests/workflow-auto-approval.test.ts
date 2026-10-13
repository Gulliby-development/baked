import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { canonical, hashJson } from "../src/core/specs/hash.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import {
  approvalReviewText,
  evaluateAutoApproval,
  planScopeAdvice,
  plannerApprovalLimits,
  policyDecisions,
} from "../src/core/workflows/auto-approval.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  type InputManifest,
  PolicySchema,
  type RunPolicy,
  type Spec,
  type TaskGraph,
} from "../src/core/workflows/schemas.js";
import { type ArtifactRow, newId, type RequestRow } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

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
  maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens,
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
    body_json: canonical({ manifest, writes, profiles: ["implementer"], checks: policy.checks, policy }),
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
    ["a larger token budget", { ...limited, maxTotalTokens: limits.maxTotalTokens + 100000 }, graph([modify("src/a.ts")]), "token budget"],
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
  const anywhere: RunPolicy = { ...limited, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] } } };
  const create = (path: string): Write => ({ path, action: "create" });
  test("creating a manifest that is not there yet is approved, modifying or overwriting one is not", () => {
    const absent = { exists: () => false };
    expect(evaluateAutoApproval(anywhere, manifest, spec, graph([create("pyproject.toml"), create("tsconfig.json")]), [], [], absent).approval?.mode).toBe("limits");
    expect(evaluateAutoApproval(anywhere, manifest, spec, graph([create("package.json")]), [], [], { exists: () => true }).reasons.join("\n")).toContain("package.json always needs a person");
    expect(evaluateAutoApproval(anywhere, manifest, spec, graph([modify("package.json")]), [], [], absent).approval).toBeNull();
    expect(evaluateAutoApproval(anywhere, manifest, spec, graph([create("package.json")]), []).approval).toBeNull();
  });
  test("editing a manifest of a scaffold baseline is approved, a source baseline still needs a person", () => {
    const present = { exists: () => true };
    const edits = graph([modify("package.json"), modify("tsconfig.json")]);
    expect(evaluateAutoApproval(anywhere, manifest, spec, edits, [], [], { ...present, scaffold: true }).approval?.mode).toBe("limits");
    expect(evaluateAutoApproval(anywhere, manifest, spec, edits, [], [], { ...present, scaffold: false }).reasons.join("\n")).toContain("package.json always needs a person");
    expect(evaluateAutoApproval(anywhere, manifest, spec, graph([{ path: "package.json", action: "delete" }]), [], [], { ...present, scaffold: true }).approval).toBeNull();
    expect(evaluateAutoApproval(anywhere, manifest, spec, graph([modify("bun.lock"), modify("AGENTS.md")]), [], [], { ...present, scaffold: true }).approval).toBeNull();
  });
  test("creating a lock file, a CI file or project instructions still needs a person", () => {
    for (const path of ["bun.lock", ".github/workflows/ci.yml", "AGENTS.md", ".env"])
      expect(evaluateAutoApproval(anywhere, manifest, spec, graph([create(path)]), [], [], { exists: () => false }).approval).toBeNull();
  });
  test("tasks the host added by splitting do not count against the task limit", () => {
    const three = graph([modify("src/a.ts")], [modify("src/b.ts")], [modify("src/c.ts")]);
    expect(evaluateAutoApproval(limited, manifest, spec, three, [], [], { hostSplitTasks: 1 }).approval?.mode).toBe("limits");
    expect(evaluateAutoApproval(limited, manifest, spec, three, [], [], { hostSplitTasks: 0 }).reasons.join("\n")).toContain("3 tasks exceed 2");
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
  test("under clarification assume post-release criteria are deferred without a person", () => {
    const deferred = { ...spec, criteria: spec.criteria.map((c) => ({ ...c, method: "post-release" as const })) };
    const assume = { ...limited, clarification: "assume" as const };
    expect(evaluateAutoApproval(assume, manifest, deferred, graph([modify("src/a.ts")]), []).approval?.mode).toBe("limits");
    // Paths that always need a person still do.
    expect(evaluateAutoApproval(assume, manifest, deferred, graph([modify(".github/ci.yml")]), []).approval).toBeNull();
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
    ["changed checks", { ...renewing, checks: [{ id: "lint", executable: "bun", args: ["run", "lint"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] }, graph([modify("src/a.ts")]), [approved(renewing, [modify("src/a.ts")])], "policy settings changed without an operator decision"],
    ["auto approval enabled after the human approval", renewing, graph([modify("src/a.ts")]), [approved(defaultWorkflowPolicy, [modify("src/a.ts")])], "policy settings changed without an operator decision"],
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

describe("renewal after operator policy decisions", () => {
  const scope = [modify("src/usage.ts"), { path: "tests/usage.test.ts", action: "create" as const }];
  const previous = approved(renewing, scope);
  const decided = (policy: RunPolicy) => [{ policyHash: hashJson(policy) }];
  const lint = { id: "lint", executable: "bun", args: ["run", "lint"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [] };
  const testCheck = { ...lint, id: "tests", args: ["test"] };
  test("after a human extend an unchanged scope renews", () => {
    const extended = { ...renewing, maxTotalTokens: 2_000_000, maxAgentCalls: 200 };
    expect(evaluateAutoApproval(extended, manifest, spec, graph(scope), [previous]).reasons.join("\n")).toContain("maxTotalTokens grew");
    expect(evaluateAutoApproval(extended, manifest, spec, graph(scope), [previous], decided(extended)).approval?.mode).toBe("renewal");
  });
  test("after a human revise that only changes a check command an unchanged scope renews", () => {
    const before = { ...renewing, checks: [testCheck] };
    const revised = { ...renewing, checks: [{ ...testCheck, args: ["test", "tests/usage.test.ts"] }] };
    const human = approved(before, scope);
    expect(evaluateAutoApproval(revised, manifest, spec, graph(scope), [human]).reasons.join("\n")).toContain("policy settings changed without an operator decision");
    expect(evaluateAutoApproval(revised, manifest, spec, graph(scope), [human], decided(revised)).approval?.mode).toBe("renewal");
  });
  test("an operator decision does not cover new writes, tools, network or review changes", () => {
    const wider: [string, RunPolicy, TaskGraph, string][] = [
      ["a new write path", renewing, graph([...scope, modify("src/other.ts")]), "modify src/other.ts was not approved"],
      ["a new tool", { ...renewing, allowedTools: [...renewing.allowedTools, "web_fetch"] }, graph(scope), "tool web_fetch was added"],
      ["network access", { ...renewing, network: "allow" }, graph(scope), "network widened from deny to allow"],
      ["another skeptic", { ...renewing, skepticProfileId: "other" }, graph(scope), "review profiles changed"],
    ];
    for (const [name, policy, tasks, reason] of wider) {
      const result = evaluateAutoApproval(policy, manifest, spec, tasks, [previous], decided(policy));
      expect(result.approval, name).toBeNull();
      expect(result.reasons.join("\n"), name).toContain(reason);
    }
    const reviewed = approved({ ...renewing, forceSecurityReview: true }, scope);
    expect(evaluateAutoApproval(renewing, manifest, spec, graph(scope), [reviewed], decided(renewing)).reasons).toContain("Renewal: forced security review was turned off");
    const narrower = { ...renewing, allowedTools: renewing.allowedTools.slice(1) };
    expect(evaluateAutoApproval(narrower, manifest, spec, graph(scope), [previous], decided(narrower)).approval?.mode).toBe("renewal");
  });
  test("a weaker OS sandbox needs a person, a stricter one renews", () => {
    const strict = approved({ ...renewing, sandbox: "required" }, scope);
    for (const [policy, reason] of [
      [{ ...renewing, sandbox: "auto" as const }, "sandbox weakened from required to auto"],
      [renewing, "sandbox weakened from required to off"],
    ] as const) {
      const result = evaluateAutoApproval(policy, manifest, spec, graph(scope), [strict], decided(policy));
      expect(result.approval).toBeNull();
      expect(result.reasons.join("\n")).toContain(reason);
    }
    const stricter = { ...renewing, sandbox: "required" as const };
    expect(evaluateAutoApproval(stricter, manifest, spec, graph(scope), [previous], decided(stricter)).approval?.mode).toBe("renewal");
  });
  test("a change that no operator decision names still needs a person", () => {
    const changed = { ...renewing, checks: [lint] };
    // A decision for another policy, or a policy-revision record without a user approver, is not consent.
    const records: ArtifactRow[] = [
      { run_id: "run", id: "a", kind: "policy-revision", logical_path: "policy-revisions/a.json", revision: 1, content_hash: hash, byte_length: 0, inline_content: canonical({ approvedBy: "model", policyHash: hashJson(changed) }), blob_path: null },
      { run_id: "run", id: "b", kind: "revision-candidate", logical_path: "candidates/b.json", revision: 1, content_hash: hash, byte_length: 0, inline_content: canonical({ approvedBy: "user", policyHash: hashJson(changed) }), blob_path: null },
      { run_id: "run", id: "c", kind: "policy-revision", logical_path: "policy-revisions/c.json", revision: 1, content_hash: hash, byte_length: 0, inline_content: canonical({ approvedBy: "user", policyHash: hashJson(renewing) }), blob_path: null },
    ];
    const decisions = policyDecisions(records, (row) => row.inline_content ?? "");
    expect(decisions).toEqual([{ policyHash: hashJson(renewing) }]);
    const result = evaluateAutoApproval(changed, manifest, spec, graph(scope), [previous], decisions);
    expect(result.approval).toBeNull();
    expect(result.reasons.join("\n")).toContain("policy settings changed without an operator decision");
  });
  test("a re-plan that moves a task to another profile needs a person", () => {
    const tasks = graph(scope);
    tasks.tasks[0] = { ...tasks.tasks[0]!, profileId: "networked" };
    expect(evaluateAutoApproval(renewing, manifest, spec, tasks, [previous]).reasons).toContain("Renewal: task profile networked was not approved");
    const legacy = { ...previous, body_json: canonical({ manifest, writes: scope, policy: renewing }) };
    expect(evaluateAutoApproval(renewing, manifest, spec, graph(scope), [legacy]).reasons).toContain("Renewal: the earlier approval does not record its task profiles");
  });
});

describe("renewal in a run", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const policy: RunPolicy = { ...fixturePolicy, autoApproval: { renewal: true, limits: null } };

  async function driveToRest(fixture: ReturnType<typeof workflowFixture>, runId: string) {
    for (let i = 0; i < 12; i++) {
      const run = await fixture.service.get(runId);
      if (["waiting", "completed", "blocked", "failed"].includes(run.status)) return run;
      if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
      await fixture.service.drive(runId, new AbortController().signal);
    }
    return fixture.service.get(runId);
  }
  async function reviseAfterHumanApproval(next: RunPolicy) {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const first = await driveToRest(fixture, run.runId);
    expect(first.status).toBe("waiting");
    const pending = service.store.requests(run.runId).find((r) => r.status === "pending");
    expect(JSON.parse(pending!.body_json).autoApproval.declined).toContain("Renewal: no earlier human approval in this run");
    await fixture.approve(run.runId);
    const candidate = await new WorkflowArtifacts(service).stageRevision(run.runId, {
      commandId: newId(),
      expectedInputHash: service.store.snapshot(run.runId).inputHash,
      policy: next,
    });
    await service.revise(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision }, candidate.candidateHash);
    return { fixture, runId: run.runId, after: await driveToRest(fixture, run.runId) };
  }

  test("a revise that only changes the check command renews the unchanged scope", async () => {
    const check = fixturePolicy.checks[0]!;
    const next = { ...policy, checks: [{ ...check, args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"] }] };
    const { fixture, runId, after } = await reviseAfterHumanApproval(next);
    expect(after.status).toBe("completed");
    const approvals = fixture.service.store.requests(runId).filter((r) => r.kind === "approval" && r.status === "accepted");
    expect(approvals.map((r) => r.actor)).toEqual(["user", "auto-approval"]);
    const record = fixture.service.store.artifacts(runId).find((a) => a.kind === "policy-revision");
    expect(JSON.parse(fixture.service.store.readArtifact(runId, record!.id))).toMatchObject({ kind: "revision", approvedBy: "user", policyHash: hashJson(PolicySchema.parse(next)) });
  });

  test("a revise that adds a tool still waits for a person", async () => {
    const { fixture, runId, after } = await reviseAfterHumanApproval({ ...policy, allowedTools: [...policy.allowedTools, "web_fetch"] });
    expect(after.status).toBe("waiting");
    const pending = fixture.service.store.requests(runId).find((r) => r.status === "pending");
    expect(JSON.parse(pending!.body_json).autoApproval.declined).toContain("Renewal: tool web_fetch was added");
  });
});

describe("planner scope advice", () => {
  test("the planner is told the limits only when auto approval has them", () => {
    expect(plannerApprovalLimits(defaultWorkflowPolicy)).toBeNull();
    expect(plannerApprovalLimits(renewing)).toBeNull();
    expect(plannerApprovalLimits(limited)).toMatchObject({ maxTasks: 2, maxFiles: 3, allowedPaths: ["src/**", "tests/**"], allowDelete: false });
  });
  test("names every write that would send the plan to a person", () => {
    expect(planScopeAdvice(limited, graph([modify("src/a.ts")], [modify("tests/a.test.ts")]))).toEqual([]);
    expect(planScopeAdvice(defaultWorkflowPolicy, graph([modify("scripts/run.ts")]))).toEqual([]);
    const [advice] = planScopeAdvice(
      limited,
      graph([modify("src/a.ts"), modify("src/b.ts"), modify("docs/a.md"), modify("package.json")], [{ path: "src/c.ts", action: "delete" }]),
    );
    expect(advice).toContain("5 files exceed 3");
    expect(advice).toContain("docs/a.md is outside the allowed paths");
    expect(advice).toContain("package.json always needs a person");
    expect(advice).toContain("src/c.ts would be deleted");
    expect(advice).toContain("submit the same plan again");
  });
});

describe("planner scope advice in a run", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const scoped: RunPolicy = {
    ...fixturePolicy,
    autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["value.txt"], maxTotalTokens: fixturePolicy.maxTotalTokens } },
  };

  /** Submits a plan with an extra file outside the limits, then follows the advice or keeps it. */
  class ScopedPlanner extends FixtureExecutor {
    advice: string[][] = [];
    constructor(root: string, private keep: boolean) { super(root); }
    override async execute(request: ExecutionRequest) {
      const result = await super.execute(request);
      if (request.profile.output !== "plan") return result;
      const plan = result.output as { taskGraph: TaskGraph };
      const [task] = plan.taskGraph.tasks;
      const wide = { ...plan, taskGraph: { ...plan.taskGraph, tasks: [{ ...task!, writes: [...task!.writes, { path: "store.ts", action: "modify" as const }] }] } };
      this.advice.push(request.validate?.(wide) ?? []);
      this.advice.push(request.validate?.(wide) ?? []);
      return this.keep ? { ...result, output: wide } : result;
    }
  }
  async function run(keep: boolean) {
    const fixture = workflowFixture({ policy: scoped, executor: (root) => new ScopedPlanner(root, keep) });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "store.ts"), "export {};\n");
    const started = await fixture.start();
    for (let i = 0; i < 12; i++) {
      const current = await fixture.service.get(started.runId);
      if (["waiting", "completed", "blocked", "failed"].includes(current.status)) break;
      if (current.status === "paused" || current.status === "created") await fixture.resume(started.runId);
      await fixture.service.drive(started.runId, new AbortController().signal);
    }
    return { fixture, runId: started.runId };
  }

  test("a planner that drops the extra file is approved without a person", async () => {
    const { fixture, runId } = await run(false);
    expect(fixture.executor.prompts.plan?.[0]).toContain('"approvalLimits"');
    expect(fixture.executor.advice[0]?.join("\n")).toContain("store.ts is outside the allowed paths");
    // The advice is given once, so a planner that needs the file can keep it.
    expect(fixture.executor.advice[1]).toEqual([]);
    const approvals = fixture.service.store.requests(runId).filter((r) => r.kind === "approval" && r.status === "accepted");
    expect(approvals[0]?.actor).toBe("auto-approval");
  });
  test("a plan that keeps the file waits for a person", async () => {
    const { fixture, runId } = await run(true);
    expect((await fixture.service.get(runId)).status).toBe("waiting");
    const pending = fixture.service.store.requests(runId).find((r) => r.status === "pending");
    expect(JSON.parse(pending!.body_json).autoApproval.declined).toContain("Limits: store.ts is outside the allowed paths");
  });
});

describe("approval reviewer", () => {
  const reviewed: RunPolicy = { ...limited, autoApproval: { renewal: false, limits, modelReview: true } };
  test("the schema needs limits for model review", () => {
    expect(PolicySchema.safeParse({ ...defaultWorkflowPolicy, autoApproval: { renewal: true, limits: null, modelReview: true } }).success).toBe(false);
    expect(PolicySchema.safeParse(reviewed).success).toBe(true);
  });
  test("only size and path problems may go to the reviewer", () => {
    const decide = (policy: RunPolicy, g: TaskGraph) => evaluateAutoApproval(policy, manifest, spec, g, []);
    const many = graph([modify("src/a.ts")], [modify("src/b.ts")], [modify("src/c.ts")]);
    expect(decide(reviewed, many)).toMatchObject({ approval: null, reviewable: true });
    expect(decide(reviewed, many).limitsHash).toHaveLength(64);
    expect(decide(reviewed, graph([modify("scripts/run.ts")])).reviewable).toBe(true);
    expect(decide(limited, many).reviewable).toBeUndefined();
    expect(decide(reviewed, graph([{ path: "src/a.ts", action: "delete" }])).reviewable).toBeUndefined();
    expect(decide({ ...reviewed, maxTotalTokens: limits.maxTotalTokens + 1 }, graph([modify("src/a.ts")])).reviewable).toBeUndefined();
    const anywhere: RunPolicy = { ...reviewed, autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["**"] }, modelReview: true } };
    expect(decide(anywhere, graph([modify(".github/workflows/ci.yml")])).reviewable).toBeUndefined();
  });
  test("the verdict reads as one line", () => {
    expect(approvalReviewText({})).toBeNull();
    expect(approvalReviewText({ review: { verdict: "escalate", risk: "high", reasons: ["It changes auth."] } })).toBe("The approval reviewer escalated at high risk: It changes auth.");
    expect(approvalReviewText({ reviewError: "boom" })).toContain("could not decide (boom)");
  });
});

describe("approval reviewer in a run", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const policy: RunPolicy = {
    ...fixturePolicy,
    autoApproval: { renewal: false, limits: { ...limits, allowedPaths: ["value.txt"], maxTotalTokens: fixturePolicy.maxTotalTokens }, modelReview: true },
  };
  /** Plans an extra file outside the limits and answers the reviewer with `verdict`, or fails. */
  class Reviewed extends FixtureExecutor {
    seen: unknown[] = [];
    constructor(root: string, private verdict: { verdict: string; risk: string } | null) { super(root); }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "approval-review") {
        this.seen.push(JSON.parse(request.prompt.split("\n").at(-1) ?? "{}").extra);
        if (!this.verdict) throw new Error("reviewer unavailable");
        return { output: { ...this.verdict, reasons: ["store.ts holds the value the spec asks for."] }, inputTokens: 10, outputTokens: 10 };
      }
      const result = await super.execute(request);
      if (request.profile.output !== "plan") return result;
      const plan = result.output as { taskGraph: TaskGraph };
      const [task] = plan.taskGraph.tasks;
      return { ...result, output: { ...plan, taskGraph: { ...plan.taskGraph, tasks: [{ ...task!, writes: [...task!.writes, { path: "store.ts", action: "modify" as const }] }] } } };
    }
  }
  async function run(verdict: { verdict: string; risk: string } | null) {
    const fixture = workflowFixture({ policy, executor: (root) => new Reviewed(root, verdict) });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "store.ts"), "export {};\n");
    const started = await fixture.start();
    for (let i = 0; i < 12; i++) {
      const current = await fixture.service.get(started.runId);
      if (["waiting", "completed", "blocked", "failed"].includes(current.status)) break;
      if (current.status === "paused" || current.status === "created") await fixture.resume(started.runId);
      await fixture.service.drive(started.runId, new AbortController().signal);
    }
    const approvals = fixture.service.store.requests(started.runId).filter((r) => r.kind === "approval");
    return { fixture, runId: started.runId, approval: approvals[0]! };
  }

  test("a low-risk approve approves the package without a person", async () => {
    const { fixture, approval } = await run({ verdict: "approve", risk: "low" });
    expect(approval.status).toBe("accepted");
    expect(approval.actor).toBe("auto-approval");
    expect(JSON.parse(approval.answer_json ?? "{}").autoApproval).toMatchObject({ mode: "model-review", review: { verdict: "approve", risk: "low" } });
    const extra = fixture.executor.seen[0] as { approval: { declined: string[]; tasks: { writes: unknown[] }[] } };
    expect(extra.approval.declined).toContain("Limits: store.ts is outside the allowed paths");
    expect(extra.approval.tasks[0]?.writes).toHaveLength(2);
  });
  test("an escalation or a medium risk waits for a person with the verdict", async () => {
    for (const verdict of [{ verdict: "escalate", risk: "low" }, { verdict: "approve", risk: "medium" }]) {
      const { approval } = await run(verdict);
      expect(approval.status).toBe("pending");
      expect(JSON.parse(approval.body_json).autoApproval.review).toMatchObject(verdict);
    }
  });
  test("a reviewer that fails leaves the package with a person", async () => {
    const { approval } = await run(null);
    expect(approval.status).toBe("pending");
    expect(JSON.parse(approval.body_json).autoApproval.reviewError).toContain("reviewer unavailable");
  });
});
