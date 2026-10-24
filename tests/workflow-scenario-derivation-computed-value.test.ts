import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { auditedCriteria, auditShape, derivationProblems } from "../src/core/workflows/derivation-audit.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 65, uritpl cli 6adf6a07 (#2022). AC-005 is a given/when/then criterion
// whose `then` states column 6 for the second name of `{a}{a}`; the request's example gives name
// columns, which put it at 5. The derivation audit covered table rows only, so the analysis never
// looked at AC-005, and the conflict cost 1.42M tokens in the implementer. With the audit's scope
// widened to values computed from a literal input, the analysis returns it to the spec author.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = "Build the uritpl cli. A duplicate variable name is reported at the column of the repeated name: for `{a}{a}` the names are at columns 2 and 5, so lint reports `1:5 duplicate name a`.";
const WRONG = "lint reports `1:6 duplicate name a` and exits 1";
const RIGHT = "lint reports `1:5 duplicate name a` and exits 1";
const specWith = (then: string): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "cli", problem: "No cli", outcome: "A lint command", inScope: ["lint"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-003", text: "A repeated variable name is reported at the 1-based column of its first character", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    { id: "AC-004", requirementIds: ["FR-003"], given: "an empty template", when: "lint runs", then: "it exits 0", method: "automated" },
    { id: "AC-005", requirementIds: ["FR-003"], given: "the template `{a}{a}`", when: "`uritpl lint` reads it", then, method: "automated" },
  ],
  dependencies: [],
});
const markdown = "# Plan\n## Context\nA tool.\n## Decisions\nDEC-001: FR-003 counts code points.\n## Components\nsrc/cli.py\n## Data\nText\n## Verification\nTests\n## Risks\nNone";
const policyWith = (extra: Partial<RunPolicy>): RunPolicy => ({ ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }], ...extra });

type Audit = { criteria: Spec["criteria"]; requirements: Spec["requirements"]; note: string };

class ScriptedExecutor implements AgentExecutor {
  specs = 0;
  audits: (Audit | undefined)[] = [];
  async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { inputHash: string; spec: Spec | null; extra?: { derivationAudit?: Audit } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.py"] }; break;
      case "spec":
        this.specs++;
        output = specWith(request.prompt.includes("Derivation audit findings") ? RIGHT : WRONG);
        break;
      case "plan": {
        const spec = data.spec ?? specWith(WRONG);
        const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement lint", description: "Implement", requirementIds: ["FR-003"], criterionIds: ["AC-004", "AC-005"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/cli.py", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] };
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      }
      case "analysis": {
        const audit = data.extra?.derivationAudit;
        this.audits.push(audit);
        // The analyzer counts the columns: `{` 1, `a` 2, `}` 3, `{` 4, `a` 5.
        const derivations = audit?.criteria.map((c) => ({
          criterionId: c.id,
          row: `{a}{a} → ${c.then}`,
          recomputed: "1:5",
          matches: c.then.includes("1:5"),
          derivation: "Columns of {a}{a}: { 1, a 2, } 3, { 4, a 5; the repeated name starts at column 5.",
          quote: "for `{a}{a}` the names are at columns 2 and 5",
        }));
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [], ...(derivations ? { derivations } : {}) };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(executor: ScriptedExecutor, policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-derivation-computed-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const requests = (kind: string) => service.store.requests(run.runId).filter((r) => r.kind === kind && r.status === "pending");
  return { service, runId: run.runId, requests };
}

describe("scenario: uritpl cli 6adf6a07, a column computed in a given/when/then criterion (#2022)", () => {
  test("the audit covers AC-005 and sends column 6 back to the spec author before any task", async () => {
    const executor = new ScriptedExecutor();
    const { service, runId, requests } = await plan(executor, policyWith({ derivationAudit: "on" }));
    expect(executor.audits[0]?.criteria.map((c) => c.id)).toEqual(["AC-005"]);
    expect(executor.audits[0]?.note).toContain("a value computed from a literal input");
    expect(executor.specs).toBe(2);
    expect(requests("clarification")).toHaveLength(0);
    expect(service.store.state(runId)).toMatchObject({ derivationReturns: 1, analysisPassed: true });
    expect(service.store.state(runId)?.spec?.criteria[1]?.then).toBe(RIGHT);
  }, 60000);
});

describe("derivation audit shapes", () => {
  const criterion = (id: string, given: string, then: string, method: "automated" | "manual" = "automated"): Spec["criteria"][number] => ({ id, requirementIds: ["FR-003"], given, when: "it runs", then, method });

  test("a counted value of a literal input is audited; prose, unquoted inputs and manual criteria are not", () => {
    const criteria = [
      criterion("AC-001", "the template `{a}{a}`", "it reports `1:6 duplicate name a`"),
      criterion("AC-002", 'the input "abc"', "the error is at column 3"),
      criterion("AC-003", "the line `x = 1`", "the width is 5"),
      criterion("AC-004", "the text `héllo`", "it prints 5 characters"),
      criterion("AC-005", "a template", "it reports the error at 1:6"),
      criterion("AC-006", "the template `{a}`", "it exits 0"),
      criterion("AC-007", "the template `{a}{a}`", "it reports 1:6", "manual"),
      criterion("AC-008", "a value", "Input | expected\n7 | seven"),
    ];
    expect(criteria.map((c) => auditShape(c))).toEqual(["computed", "computed", "computed", "computed", null, null, null, "rows"]);
    expect(auditedCriteria({ ...specWith(WRONG), criteria }).map((c) => c.id)).toEqual(["AC-001", "AC-002", "AC-003", "AC-004", "AC-008"]);
  });

  test("an analysis that skips a computed-value criterion is told to complete it", () => {
    expect(derivationProblems(specWith(WRONG), { derivations: [] })).toEqual([
      "Derivation audit: AC-005 states a value computed from a literal input (a column, offset, width, length or count) and has no entry in derivations; recompute each such value from FR-003 and add one entry per value.",
    ]);
  });
});
