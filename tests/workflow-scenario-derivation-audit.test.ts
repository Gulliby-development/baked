import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { auditedCriteria, derivationFindings, derivationProblems } from "../src/core/workflows/derivation-audit.js";
import type { Analysis, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 42, fecsmith crc e21ebbc3 (#1465). The spec author derived the row
// `crc:3:3:0:1:0:0 / 01 | 4` by hand; FR-004's bit-serial rule gives 3. Analysis did not
// recompute it, the test task wrote 4, and the spec conflict cost 1.05M tokens over two
// generations of the task (R40 tonemath theory had the same class with a question to a person).
// With `derivationAudit: "on"` the analyzer recomputes every literal row from the requirements, and
// a row it cannot reproduce goes back to the spec author before any task runs.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const WRONG = "crc:3:3:0:1:0:0 / 01 | 4";
const RIGHT = "crc:3:3:0:1:0:0 / 01 | 3";
const specWith = (row: string): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "crc", problem: "No CRC tool", outcome: "A CRC calculator", inScope: ["CRC"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-004", text: "The register shifts one bit at a time, most significant bit first, and XORs the polynomial when the bit shifted out is 1", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    { id: "AC-004", requirementIds: ["FR-004"], given: "width 3, polynomial 3, no reflection", when: "crc computes the input", then: `the result is:\nInput | expected\n${row}`, method: "automated" },
    { id: "AC-005", requirementIds: ["FR-004"], given: "an empty input", when: "crc computes it", then: "it prints the initial value", method: "automated" },
  ],
  dependencies: [],
});
const markdown = "# Plan\n## Context\nA tool.\n## Decisions\nDEC-001: FR-004 is a bit-serial register.\n## Components\nsrc/crc.ts\n## Data\nBytes\n## Verification\nTests\n## Risks\nNone";
const policyWith = (extra: Partial<RunPolicy>): RunPolicy => ({ ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }], ...extra });

type Audit = { criteria: Spec["criteria"]; requirements: Spec["requirements"]; note: string };

class ScriptedExecutor implements AgentExecutor {
  specs = 0;
  audits: (Audit | undefined)[] = [];
  validation: string[][] = [];
  /** `fixes`: the spec author corrects the row when the audit sends it back. */
  constructor(private fixes: boolean, private omitsFirst = false) {}
  async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { inputHash: string; spec: Spec | null; extra?: { derivationAudit?: Audit } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/crc.ts"] }; break;
      case "spec":
        this.specs++;
        output = specWith(this.fixes && request.prompt.includes("Derivation audit findings") ? RIGHT : WRONG);
        break;
      case "plan": {
        const spec = data.spec ?? specWith(WRONG);
        const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement crc", description: "Implement", requirementIds: ["FR-004"], criterionIds: ["AC-004", "AC-005"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/crc.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] };
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      }
      case "analysis": {
        const audit = data.extra?.derivationAudit;
        this.audits.push(audit);
        // The analyzer recomputes the row from FR-004: 0b001 shifted through polynomial 3 gives 3.
        const derivations = audit?.criteria.map((c) => {
          const row = c.then.split("\n").at(-1) ?? "";
          return { criterionId: c.id, row, recomputed: "3", matches: row.endsWith("| 3"), derivation: "01 is 0b00000001; seven zero shifts, then the 1 shifts out of width 3 and XORs polynomial 3: 3" };
        });
        const first = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        if (audit && this.omitsFirst && this.validation.length === 0) {
          this.validation.push(request.validate?.(first) ?? []);
        }
        output = { ...first, ...(derivations ? { derivations } : {}) };
        this.validation.push(request.validate?.(output) ?? []);
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(executor: ScriptedExecutor, policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-derivation-audit-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build crc with a bit-serial register.", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const requests = (kind: string) => service.store.requests(run.runId).filter((r) => r.kind === kind && r.status === "pending");
  return { service, runId: run.runId, requests };
}

describe("scenario: fecsmith crc e21ebbc3, a hand-derived criterion row (#1465)", () => {
  test("the audit sends the row back to the spec author before any task, with no question", async () => {
    const executor = new ScriptedExecutor(true);
    const { service, runId, requests } = await plan(executor, policyWith({ derivationAudit: "on" }));
    expect(executor.audits[0]?.criteria.map((c) => c.id)).toEqual(["AC-004"]);
    expect(executor.audits[0]?.requirements.map((r) => r.id)).toEqual(["FR-004"]);
    expect(executor.specs).toBe(2);
    expect(requests("clarification")).toHaveLength(0);
    expect(requests("approval")).toHaveLength(1);
    expect(service.store.state(runId)).toMatchObject({ derivationReturns: 1, analysisPassed: true });
    expect(service.store.state(runId)?.spec?.criteria[0]?.then).toContain(RIGHT);
  }, 60000);

  test("a row the spec author keeps after the return is put to the person once", async () => {
    const executor = new ScriptedExecutor(false);
    const { requests } = await plan(executor, policyWith({ derivationAudit: "on", clarification: "ask" }));
    expect(executor.specs).toBe(2);
    const asked = requests("clarification");
    expect(asked).toHaveLength(1);
    const findings = (JSON.parse(asked[0]?.body_json ?? "{}") as { findings: Analysis["findings"] }).findings;
    expect(findings.map((f) => f.id)).toEqual(["DERIVE-AC-004"]);
    expect(findings[0]?.description).toContain(`row "${WRONG}": the requirements give "3"`);
    expect(findings[0]?.refs).toEqual(["spec.json", "AC-004", "FR-004"]);
  }, 60000);

  test("without the policy setting the analyzer gets no audit and the row passes as before", async () => {
    const executor = new ScriptedExecutor(true);
    const { service, runId, requests } = await plan(executor, policyWith({}));
    expect(executor.audits).toEqual([undefined]);
    expect(executor.specs).toBe(1);
    expect(requests("approval")).toHaveLength(1);
    expect(service.store.state(runId)?.spec?.criteria[0]?.then).toContain(WRONG);
  }, 60000);

  test("an analysis that skips an audited criterion is told to complete it", async () => {
    const executor = new ScriptedExecutor(true, true);
    await plan(executor, policyWith({ derivationAudit: "on" }));
    expect(executor.validation[0]).toEqual([
      "Derivation audit: AC-004 states literal rows and has no entry in derivations; recompute each of its rows from FR-004 and add one entry per row.",
    ]);
    expect(executor.validation[1]).toEqual([]);
  }, 60000);
});

describe("derivation audit helpers", () => {
  const criterion = (id: string, then: string, method: "automated" | "manual" = "automated") => ({ id, requirementIds: ["FR-004"], given: "a value", when: "it runs", then, method });
  const spec = (criteria: Spec["criteria"]): Spec => ({ ...specWith(WRONG), criteria });

  test("audits automated criteria with table cells or mapping arrows, not shell pipes of ||", () => {
    const audited = auditedCriteria(
      spec([
        criterion("AC-001", "Input | expected\n7 | seven"),
        criterion("AC-002", "`C#` → `Db`"),
        criterion("AC-003", "a || b is true"),
        criterion("AC-004", "it prints ok"),
        criterion("AC-005", "1 | one", "manual"),
      ]),
    );
    expect(audited.map((c) => c.id)).toEqual(["AC-001", "AC-002"]);
  });

  test("one finding per criterion lists every row the requirements do not give", () => {
    const s = spec([criterion("AC-001", "Input | expected\n1 | one\n2 | three")]);
    const findings = derivationFindings(s, {
      derivations: [
        { criterionId: "AC-001", row: "1 | one", recomputed: "one", matches: true, derivation: "1 is one" },
        { criterionId: "AC-001", row: "2 | three", recomputed: "two", matches: false, derivation: "2 is two" },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "DERIVE-AC-001", kind: "inconsistency", blocking: true });
    expect(findings[0]?.description).toContain('row "2 | three": the requirements give "two" (2 is two)');
    expect(findings[0]?.description).not.toContain('"1 | one"');
  });

  test("a derivation that names an unknown criterion is a problem", () => {
    const s = spec([criterion("AC-001", "1 | one")]);
    expect(
      derivationProblems(s, {
        derivations: [
          { criterionId: "AC-001", row: "1 | one", recomputed: "one", matches: true, derivation: "1 is one" },
          { criterionId: "AC-009", row: "x", recomputed: "y", matches: true, derivation: "z" },
        ],
      }),
    ).toEqual(["derivations names AC-009, which is not a criterion of the spec."]);
  });
});
