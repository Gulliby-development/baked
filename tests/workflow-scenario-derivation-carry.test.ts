import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  auditCarry,
  carriedDerivations,
  checkedDerivations,
  derivationAuditExtra,
  withCarried,
} from "../src/core/workflows/derivation-audit.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 57, modeplan foundation (#1851): the first analysis pass audited 117 rows, the spec
// author fixed a few criteria, and the second pass audited all 121 rows again (318k tokens) to
// answer one finding. With `derivationAuditCarry: "on"` a later pass audits only the criteria that
// changed and keeps the earlier derivations of the rest.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const WRONG = "crc:3:3:0:1:0:0 / 01 | 4";
const RIGHT = "crc:3:3:0:1:0:0 / 01 | 3";
const STABLE = "crc:3:3:0:1:0:0 / 00 | 0";
const specWith = (row: string, requirement = "The register shifts one bit at a time and XORs the polynomial when the bit shifted out is 1"): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "crc", problem: "No CRC tool", outcome: "A CRC calculator", inScope: ["CRC"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [
    { id: "FR-004", text: requirement, priority: "must", verification: "automated", sourceRefs: [] },
    { id: "FR-005", text: "A zero input gives the initial value", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { id: "AC-004", requirementIds: ["FR-004"], given: "width 3, polynomial 3", when: "crc computes the input", then: `the result is:\nInput | expected\n${row}`, method: "automated" },
    { id: "AC-006", requirementIds: ["FR-005"], given: "width 3, polynomial 3", when: "crc computes a zero byte", then: `the result is:\nInput | expected\n${STABLE}`, method: "automated" },
  ],
  dependencies: [],
});
const markdown = "# Plan\n## Context\nA tool.\n## Decisions\nDEC-001: FR-004 is a bit-serial register.\n## Components\nsrc/crc.ts\n## Data\nBytes\n## Verification\nTests\n## Risks\nNone";
const policyWith = (extra: Partial<RunPolicy>): RunPolicy => ({ ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }], ...extra });

type Audit = { criteria: Spec["criteria"]; requirements: Spec["requirements"]; note: string };

class ScriptedExecutor implements AgentExecutor {
  audits: (Audit | undefined)[] = [];
  async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { inputHash: string; spec: Spec | null; extra?: { derivationAudit?: Audit } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/crc.ts"] }; break;
      case "spec":
        // The audit sends AC-004 back once; the spec author corrects only that row.
        output = specWith(request.prompt.includes("Derivation audit findings") ? RIGHT : WRONG);
        break;
      case "plan": {
        const spec = data.spec ?? specWith(WRONG);
        const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement crc", description: "Implement", requirementIds: ["FR-004", "FR-005"], criterionIds: ["AC-004", "AC-006"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/crc.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] };
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      }
      case "analysis": {
        const audit = data.extra?.derivationAudit;
        this.audits.push(audit);
        const derivations = audit?.criteria.map((c) => {
          const row = c.then.split("\n").at(-1) ?? "";
          const value = row.includes("/ 00 |") ? "0" : "3";
          return { criterionId: c.id, row, recomputed: value, matches: row.endsWith(`| ${value}`), derivation: `the register gives ${value}` };
        });
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [], ...(derivations ? { derivations } : {}) };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(executor: ScriptedExecutor, policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-derivation-carry-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build crc with a bit-serial register.", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const requests = (kind: string) => service.store.requests(run.runId).filter((r) => r.kind === kind && r.status === "pending");
  return { service, runId: run.runId, requests };
}

describe("scenario: modeplan foundation, a second analysis pass after one criterion changed (#1851)", () => {
  test("the second pass audits only the changed criterion and carries the other", async () => {
    const executor = new ScriptedExecutor();
    const { service, runId, requests } = await plan(executor, policyWith({ derivationAudit: "on", derivationAuditCarry: "on" }));
    expect(executor.audits.map((a) => a?.criteria.map((c) => c.id))).toEqual([["AC-004", "AC-006"], ["AC-004"]]);
    expect(executor.audits[1]?.requirements.map((r) => r.id)).toEqual(["FR-004"]);
    expect(executor.audits[1]?.note).toContain("The rows of AC-006 were reproduced by an earlier pass");
    expect(requests("approval")).toHaveLength(1);
    const state = service.store.state(runId);
    expect(state).toMatchObject({ derivationReturns: 1, analysisPassed: true });
    expect(state?.auditCarried.map((c) => c.criterionId)).toEqual(["AC-004", "AC-006"]);
    expect(state?.auditCarried.find((c) => c.criterionId === "AC-004")?.derivations[0]?.row).toBe(RIGHT);
  }, 60000);

  test("without the setting every pass audits every criterion, as before", async () => {
    const executor = new ScriptedExecutor();
    const { service, runId } = await plan(executor, policyWith({ derivationAudit: "on" }));
    expect(executor.audits.map((a) => a?.criteria.map((c) => c.id))).toEqual([["AC-004", "AC-006"], ["AC-004", "AC-006"]]);
    expect(executor.audits[1]?.note).not.toContain("earlier pass");
    expect(service.store.state(runId)?.auditCarried).toEqual([]);
  }, 60000);
});

describe("carried derivations", () => {
  const derivations = [
    { criterionId: "AC-004", row: RIGHT, recomputed: "3", matches: true, derivation: "3" },
    { criterionId: "AC-006", row: STABLE, recomputed: "0", matches: true, derivation: "0" },
  ];

  test("an unchanged criterion is carried; a changed criterion or requirement is audited again", () => {
    const spec = specWith(RIGHT);
    const carry = auditCarry(spec, derivations);
    expect(carriedDerivations(spec, carry).map((d) => d.criterionId)).toEqual(["AC-004", "AC-006"]);
    expect(derivationAuditExtra(spec, new Set(["AC-004", "AC-006"]))).toBeNull();
    // A changed row of AC-004.
    expect(carriedDerivations(specWith(WRONG), carry).map((d) => d.criterionId)).toEqual(["AC-006"]);
    // A changed text of FR-004 invalidates AC-004, which derives from it.
    expect(carriedDerivations(specWith(RIGHT, "The register shifts two bits at a time"), carry).map((d) => d.criterionId)).toEqual(["AC-006"]);
  });

  test("a criterion with a row the pass did not reproduce is not carried", () => {
    const spec = specWith(WRONG);
    const carry = auditCarry(spec, [{ ...derivations[0]!, row: WRONG, matches: false }, derivations[1]!]);
    expect(carry.map((c) => c.criterionId)).toEqual(["AC-006"]);
  });

  test("a carried derivation whose quote the request does not hold is raised again", () => {
    const quoted = { ...derivations[1]!, quote: "a zero byte gives 0" };
    const merged = withCarried([derivations[0]!, { ...derivations[1]!, derivation: "fresh" }], [quoted]);
    expect(merged?.map((d) => d.criterionId)).toEqual(["AC-006", "AC-004"]);
    expect(merged?.find((d) => d.criterionId === "AC-006")?.derivation).toBe("0");
    const checked = checkedDerivations(merged, "Build crc.", specWith(RIGHT));
    expect(checked?.find((d) => d.criterionId === "AC-006")?.matches).toBe(false);
    expect(checked?.find((d) => d.criterionId === "AC-004")?.matches).toBe(true);
  });
});
