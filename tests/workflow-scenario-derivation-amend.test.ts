import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { amendKeepsPlan, amendableReturn, startAmend } from "../src/core/workflows/derivation-audit.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// Bench round 70, evalpin on the claude-code series (#2219): in 3 of 6 features the derivation
// audit found one wrong cell (report-cli AC-004 expected `0 new, 0 gone` where the requirements
// give `1 new`), and each return re-ran specify, plan and analyze in full, USD 5.68 or 18 percent
// of the initiative. With `derivationAmend: "on"` a return of rows alone is answered by one
// revision of the named criteria plus analyze, and the plan and tasks are kept.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WRONG = "crc:3:3:0:1:0:0 / 01 | 4";
const RIGHT = "crc:3:3:0:1:0:0 / 01 | 3";
const specWith = (row: string, extra: Spec["criteria"] = []): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "crc", problem: "No CRC tool", outcome: "A CRC calculator", inScope: ["CRC"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-004", text: "The register shifts one bit at a time, most significant bit first, and XORs the polynomial when the bit shifted out is 1", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    { id: "AC-004", requirementIds: ["FR-004"], given: "width 3, polynomial 3, no reflection", when: "crc computes the input", then: `the result is:\nInput | expected\n${row}`, method: "automated" },
    { id: "AC-005", requirementIds: ["FR-004"], given: "an empty input", when: "crc computes it", then: "it prints the initial value", method: "automated" },
    ...extra,
  ],
  dependencies: [],
});
const ADDED = { id: "AC-006", requirementIds: ["FR-004"], given: "a one-byte input", when: "crc computes it", then: "it prints a value below 8", method: "automated" as const };
const markdown = "# Plan\n## Context\nA tool.\n## Decisions\nDEC-001: FR-004 is a bit-serial register.\n## Components\nsrc/crc.ts\n## Data\nBytes\n## Verification\nTests\n## Risks\nNone";
const policyWith = (extra: Partial<RunPolicy>): RunPolicy => ({ ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }], ...extra });

type Audit = { criteria: Spec["criteria"]; requirements: Spec["requirements"]; note: string };

class ScriptedExecutor implements AgentExecutor {
  outputs: string[] = [];
  analyses = 0;
  /**
   * `adds`: the spec author also adds a criterion when it corrects the row, which changes the
   * task's criterion list. `ambiguous`: the first analysis also raises a blocking ambiguity.
   */
  constructor(private options: { adds?: boolean; ambiguous?: boolean } = {}) {}
  async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { inputHash: string; spec: Spec | null; extra?: { derivationAudit?: Audit; revision?: { artifact: string } } };
    this.outputs.push(request.profile.output);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/crc.ts"] }; break;
      case "spec":
        output = request.prompt.includes("Derivation audit findings") ? specWith(RIGHT, this.options.adds ? [ADDED] : []) : specWith(WRONG);
        break;
      case "revision":
        expect(data.extra?.revision?.artifact).toBe("spec");
        output = {
          schemaVersion: 1,
          operations: [
            { op: "replaceText", path: "criteria/AC-004/then", find: "| 4", replace: "| 3" },
            ...(this.options.adds ? [{ op: "add", path: "criteria", value: ADDED }] : []),
          ],
        };
        break;
      case "plan": {
        const spec = data.spec ?? specWith(WRONG);
        const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement crc", description: "Implement", requirementIds: ["FR-004"], criterionIds: spec.criteria.map((c) => c.id), dependsOn: [], profileId: "implementer", writes: [{ path: "src/crc.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] };
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      }
      case "analysis": {
        this.analyses++;
        const audit = data.extra?.derivationAudit;
        const derivations = audit?.criteria.map((c) => {
          const row = c.then.split("\n").at(-1) ?? "";
          return { criterionId: c.id, row, recomputed: "3", matches: row.endsWith("| 3"), derivation: "01 is 0b00000001; the 1 shifts out of width 3 and XORs polynomial 3: 3" };
        });
        const findings = this.options.ambiguous && this.analyses === 1 ? [{ id: "F-001", kind: "ambiguity", refs: ["spec.json", "FR-004"], description: "FR-004 does not say which bit order the register uses for the input bytes", blocking: true }] : [];
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: findings.length ? "needs_revision" : "pass", findings, ...(derivations ? { derivations } : {}) };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(executor: ScriptedExecutor, policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-derivation-amend-"));
  cleanups.push(() => removeTempDir(root));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build crc with a bit-serial register.", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const artifacts = (path: string) => service.store.artifacts(run.runId).filter((a) => a.logical_path === path);
  const read = (path: string) => {
    const found = artifacts(path).at(-1);
    return found ? service.store.readArtifact(run.runId, found.id) : null;
  };
  const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval" && r.status === "pending");
  return { service, runId: run.runId, artifacts, read, approvals };
}

const stagesOf = (executor: ScriptedExecutor) => executor.outputs.filter((o) => o !== "research");

describe("scenario: evalpin report-cli, a one-cell derivation mismatch (#2219)", () => {
  test("one revision of the criterion plus analyze answers it, with plan.md and tasks.json kept", async () => {
    const executor = new ScriptedExecutor();
    const { service, runId, artifacts, read, approvals } = await plan(executor, policyWith({ derivationAudit: "on", derivationAmend: "on" }));
    expect(stagesOf(executor)).toEqual(["spec", "plan", "analysis", "revision", "analysis"]);
    expect(approvals).toHaveLength(1);
    const state = service.store.state(runId);
    expect(state).toMatchObject({ derivationReturns: 1, analysisPassed: true, derivationAmend: null });
    expect(state?.spec?.criteria[0]?.then).toContain(RIGHT);
    expect(artifacts("plan.md")).toHaveLength(1);
    const tasks = JSON.parse(read("tasks.json") ?? "{}") as TaskGraph;
    expect(tasks.specHash).toBe(hashJson(state?.spec));
    expect(tasks.tasks.map((t) => [t.id, t.criterionIds])).toEqual([["T001", ["AC-004", "AC-005"]]]);
    expect(JSON.parse(read("spec-repairs/derivation-amend-1.json") ?? "{}")).toEqual({ criteria: ["AC-004"], rows: [WRONG], planKept: true });
  }, 60000);

  test("an amendment that adds a criterion changes the task's criterion list and falls back to the full return", async () => {
    const executor = new ScriptedExecutor({ adds: true });
    const { service, runId, read, approvals } = await plan(executor, policyWith({ derivationAudit: "on", derivationAmend: "on" }));
    expect(stagesOf(executor)).toEqual(["spec", "plan", "analysis", "revision", "plan", "analysis"]);
    expect(approvals).toHaveLength(1);
    const tasks = JSON.parse(read("tasks.json") ?? "{}") as TaskGraph;
    expect(tasks.tasks[0]?.criterionIds).toEqual(["AC-004", "AC-005", "AC-006"]);
    expect(service.store.state(runId)?.spec?.criteria.map((c) => c.id)).toEqual(["AC-004", "AC-005", "AC-006"]);
    expect(JSON.parse(read("spec-repairs/derivation-amend-1.json") ?? "{}")).toMatchObject({ planKept: false, reason: "the amendment changed more than the given, when and then of the amended criteria" });
  }, 60000);

  test("a return that also carries an ambiguity finding stays the full return", async () => {
    const executor = new ScriptedExecutor({ ambiguous: true });
    const { read } = await plan(executor, policyWith({ derivationAudit: "on", derivationAmend: "on" }));
    expect(stagesOf(executor)).toEqual(["spec", "plan", "analysis", "spec", "plan", "analysis"]);
    expect(read("spec-repairs/derivation-amend-1.json")).toBeNull();
  }, 60000);

  test("without the setting the return re-runs specify, plan and analyze as before", async () => {
    const executor = new ScriptedExecutor();
    const { read, approvals } = await plan(executor, policyWith({ derivationAudit: "on" }));
    expect(stagesOf(executor)).toEqual(["spec", "plan", "analysis", "spec", "plan", "analysis"]);
    expect(approvals).toHaveLength(1);
    expect(read("spec-repairs/derivation-amend-1.json")).toBeNull();
  }, 60000);
});

describe("derivation amendment helpers", () => {
  const graph = (description: string): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "0".repeat(64), planHash: "0".repeat(64), tasks: [{ id: "T001", title: "Implement crc", description, requirementIds: ["FR-004"], criterionIds: ["AC-004", "AC-005"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/crc.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] } as TaskGraph);
  const derivations = [{ criterionId: "AC-004", row: WRONG, recomputed: "3", matches: false, derivation: "gives 3" }];
  const amend = startAmend(specWith(WRONG), derivations, [{ id: "DERIVE-AC-004" }]);

  test("only derivation findings, at most the patch limit, are amendable", () => {
    expect(amendableReturn([{ id: "DERIVE-AC-004" }], 5)).toBe(true);
    expect(amendableReturn([{ id: "DERIVE-AC-004" }, { id: "F-001" }], 5)).toBe(false);
    expect(amendableReturn([], 5)).toBe(false);
    expect(amendableReturn([{ id: "DERIVE-AC-1" }, { id: "DERIVE-AC-2" }], 1)).toBe(false);
  });

  test("the plan stands when only the amended criterion's text changed", () => {
    expect(amendKeepsPlan(amend, specWith(RIGHT), markdown, graph("Implement"), false)).toEqual({ keep: true });
    expect(amendKeepsPlan(amend, { ...specWith(RIGHT), revision: 2 }, markdown, graph("Implement"), false)).toEqual({ keep: true });
  });

  test("a changed requirement, another criterion, a copied row or rows as data fall back", () => {
    const changedRequirement = { ...specWith(RIGHT), requirements: [{ ...specWith(RIGHT).requirements[0]!, text: "Another rule" }] };
    expect(amendKeepsPlan(amend, changedRequirement, markdown, graph("Implement"), false).keep).toBe(false);
    const otherCriterion = specWith(RIGHT);
    otherCriterion.criteria[1] = { ...otherCriterion.criteria[1]!, when: "crc runs" };
    expect(amendKeepsPlan(amend, otherCriterion, markdown, graph("Implement"), false).keep).toBe(false);
    expect(amendKeepsPlan(amend, specWith(RIGHT), markdown, graph(`Implement so that ${WRONG}`), false)).toMatchObject({ keep: false, reason: expect.stringContaining("copies a corrected row") });
    expect(amendKeepsPlan(amend, specWith(RIGHT), `${markdown}\n${WRONG}`, graph("Implement"), false).keep).toBe(false);
    expect(amendKeepsPlan(amend, specWith(RIGHT), markdown, graph("Implement"), true).keep).toBe(false);
    expect(amendKeepsPlan(amend, specWith(RIGHT), null, null, false).keep).toBe(false);
  });
});
