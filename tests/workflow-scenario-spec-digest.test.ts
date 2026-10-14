import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import {
  digestsSpec,
  READ_CRITERION,
  SPEC_DIGEST_BYTES,
  specDigest,
} from "../src/core/workflows/spec-digest.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 18 (#1013, #1019): stmtsplit e29347c1 on claude-code wrote 43 criteria
// (53.6 KB), each with the request's examples as a table. Analyze, review and converge resent the
// whole spec on every step, and planning came to $5.88 of the run's $9.97. Those stages now get a
// digest of a spec that large, one line per given, when and then, and read a criterion in full
// with read_criterion.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** One criterion with an examples table, the way the stmtsplit spec held them. */
function criterion(n: number) {
  const id = `AC-${String(n).padStart(3, "0")}`;
  const rows = Array.from(
    { length: 12 },
    (_, row) => `| 2026-0${(row % 9) + 1}-1${row % 9} | Grocery store ${row} | -${row}.4${n} | EXPENSE-${n}-${row} |`,
  ).join("\n");
  return {
    id,
    requirementIds: ["FR-001"],
    given: `a CSV statement with these rows (example ${n}):\n| date | payee | amount | category |\n${rows}`,
    when: "the statement is split by category",
    then: `the report lists category EXPENSE-${n} with the exact total -${n}.40 and the rows above in date order`,
    method: "automated" as const,
  };
}

function specWith(count: number): Spec {
  return {
    schemaVersion: 1,
    featureId: "fixture",
    revision: 1,
    title: "Split statements",
    problem: "Statements are hard to read",
    outcome: "A report per category",
    inScope: ["Split a statement"],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    requirements: [{ id: "FR-001", text: "Statements are split by category", priority: "must", verification: "automated", sourceRefs: [] }],
    criteria: Array.from({ length: count }, (_, i) => criterion(i + 1)),
    dependencies: [],
  };
}

const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 in split.ts.\n## Components\nsplit.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";

class ScriptedExecutor implements AgentExecutor {
  analysis: ExecutionRequest | null = null;
  constructor(private readonly spec: Spec) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    const spec = this.spec;
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["split.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write split.ts", description: "Split statements", requirementIds: ["FR-001"], criterionIds: spec.criteria.map((c) => c.id), dependsOn: [], profileId: "implementer", writes: [{ path: "split.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      case "analysis": this.analysis = request; output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

/** What the analyze stage is given for a run whose spec author returns `spec`. */
const check = { id: "check", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [] };

async function analyzeSees(spec: Spec, policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [check] }) {
  const root = mkdtempSync(join(tmpdir(), "baked-spec-digest-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(spec);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Split a bank statement by category", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  if (!executor.analysis) throw new Error("The analyze stage was not called");
  const approval = service.store
    .requests(run.runId)
    .find((r) => r.kind === "approval" && r.status === "pending");
  return Object.assign(executor.analysis, {
    approval: approval ? (JSON.parse(approval.body_json) as Record<string, unknown>) : null,
  });
}

describe("scenario: stmtsplit e29347c1, a 43-criterion spec resent to every planning step (#1019)", () => {
  const large = specWith(43);
  const table = "| 2026-03-12 | Grocery store 2 | -2.47 | EXPENSE-7-2 |";

  test("analyze gets a digest of the large spec and reads a criterion in full on demand", async () => {
    expect(Buffer.byteLength(canonical(large))).toBeGreaterThan(SPEC_DIGEST_BYTES);
    const request = await analyzeSees(large);
    // The examples table of AC-007 is not resent; its first line and the digest note are.
    expect(request.prompt).not.toContain(table);
    expect(request.prompt).toContain("a CSV statement with these rows (example 7):");
    expect(request.prompt).toContain(`Call ${READ_CRITERION} with their ids`);
    expect(Buffer.byteLength(request.prompt)).toBeLessThan(Buffer.byteLength(canonical(large)));
    const tool = request.hostTools?.[READ_CRITERION];
    if (!tool) throw new Error("read_criterion was not offered");
    const read = (await tool.execute({ ids: ["AC-007", "AC-999"] })) as {
      criteria: Spec["criteria"];
      unknown?: string[];
    };
    expect(read.criteria).toEqual([large.criteria[6]]);
    expect(read.criteria[0]?.given).toContain(table);
    expect(read.unknown).toEqual(["AC-999"]);
    // The plan approval names what planning cost next to what the tasks should cost.
    expect(request.approval?.planCost).toMatchObject({ planning: { models: [] } });
  });

  test("a small spec is sent whole, without the tool", async () => {
    const small = specWith(2);
    const request = await analyzeSees(small);
    expect(request.prompt).toContain("| 2026-03-12 | Grocery store 2 | -2.42 | EXPENSE-2-2 |");
    expect(request.hostTools?.[READ_CRITERION]).toBeUndefined();
  });

  test("specDigest off sends the large spec whole", async () => {
    const request = await analyzeSees(large, { ...defaultWorkflowPolicy, clarification: "assume", checks: [check], specDigest: "off" });
    expect(request.prompt).toContain(table);
    expect(request.hostTools?.[READ_CRITERION]).toBeUndefined();
  });
});

describe("spec digest", () => {
  const large = specWith(43);
  const profile = (id: string) => {
    const found = builtinProfiles.find((p) => p.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  test("analyze, review and converge are digested; the author, planner and implementer are not", () => {
    for (const id of ["spec-reviewer", "reviewer", "security-reviewer", "spec-auditor", "skeptic"])
      expect(digestsSpec(large, profile(id), defaultWorkflowPolicy)).toBe(true);
    for (const id of ["spec-author", "planner", "implementer", "language-reviewer"])
      expect(digestsSpec(large, profile(id), defaultWorkflowPolicy)).toBe(false);
  });

  test("a criterion that fits its lines is marked full; one with a table is not", () => {
    const short = { ...criterion(1), given: "a statement", then: "the total is -1.40" };
    const digest = specDigest({ ...large, criteria: [short, criterion(2)] }) as {
      criteria: { id: string; given: string; full: boolean }[];
    };
    expect(digest.criteria.map((c) => c.full)).toEqual([true, false]);
    expect(digest.criteria[1]?.given).toBe("a CSV statement with these rows (example 2):");
  });
});
