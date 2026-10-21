import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { checkedDerivations, derivationFindings, derivationProblems, quoteInRequest } from "../src/core/workflows/derivation-audit.js";
import type { Analysis, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 55, routeshadow 7d83231e (#1823). The brief states the RS005 position
// in words with two examples; the spec author read `//` as reporting its second slash (1:6), and
// the derivation audit passed the row by citing a `GET // n` example the brief never gave. The
// wrong column shipped: 49 of 22,611 differential invocations. The host now checks the request
// text a derivation rests on, and a citation the request does not contain sends the row back.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const BRIEF = "Build routeshadow, a route linter.\n`RS005` `empty segment`. Position: the `/` that opens the empty segment (`/a/` and `//` each have one).";
const WRONG = '"GET // n" | "RS005 empty segment at 1:6"';
const RIGHT = '"GET // n" | "RS005 empty segment at 1:5"';
const INVENTED = "The request explicitly gives GET // n as RS005 at 1:6; the second slash is the reported opening slash.";
const specWith = (row: string): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "routeshadow", problem: "No route linter", outcome: "A linter", inScope: ["RS005"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-005", text: "RS005 empty segment reports the position of the / that opens the empty segment", priority: "must", verification: "automated", sourceRefs: ["request"] }],
  criteria: [{ id: "AC-006", requirementIds: ["FR-005"], given: "a route file", when: "routeshadow lints the line", then: `it reports:\nInput | expected\n${row}`, method: "automated" }],
  dependencies: [],
});
const markdown = "# Plan\n## Context\nA linter.\n## Decisions\nDEC-001: FR-005 is one pass over the line.\n## Components\nsrc/lint.ts\n## Data\nLines\n## Verification\nTests\n## Risks\nNone";
const policy: RunPolicy = { ...defaultWorkflowPolicy, derivationAudit: "on", checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

type Derivation = NonNullable<Analysis["derivations"]>[number];

class ScriptedExecutor implements AgentExecutor {
  specs = 0;
  returns: string[] = [];
  validation: string[][] = [];
  /** `cite`: what the analyzer writes for the row the spec states, from the first analysis on. */
  constructor(private cite: (row: string) => Partial<Derivation>) {}
  async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { inputHash: string; spec: Spec | null; extra?: { derivationAudit?: { criteria: Spec["criteria"] } } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/lint.ts"] }; break;
      case "spec": {
        this.specs++;
        const returned = request.prompt.includes("Derivation audit findings");
        if (returned) this.returns.push(request.prompt);
        output = specWith(returned ? RIGHT : WRONG);
        break;
      }
      case "plan": {
        const spec = data.spec ?? specWith(WRONG);
        const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement RS005", description: "Implement", requirementIds: ["FR-005"], criterionIds: ["AC-006"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/lint.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] };
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      }
      case "analysis": {
        // The analyzer agrees with whatever row the spec states and says why.
        const derivations = data.extra?.derivationAudit?.criteria.map((c) => {
          const row = c.then.split("\n").at(-1) ?? "";
          return { criterionId: c.id, row, recomputed: row.split("|")[1]?.trim() ?? "", matches: true, derivation: "Indexes: G1 E2 T3 space4 /5 /6 space7 n8.", ...this.cite(row) };
        });
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [], ...(derivations ? { derivations } : {}) };
        this.validation.push(request.validate?.(output) ?? []);
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(executor: ScriptedExecutor) {
  const root = mkdtempSync(join(tmpdir(), "baked-derivation-quote-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: BRIEF, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  return { service, runId: run.runId };
}

describe("scenario: routeshadow 7d83231e, an audit row passed on an invented request example (#1823)", () => {
  test("a quote the request does not contain sends the row back to the spec author", async () => {
    const executor = new ScriptedExecutor((row) => (row.includes("1:6") ? { derivation: INVENTED, quote: "GET // n gives RS005 empty segment at 1:6" } : {}));
    const { service, runId } = await plan(executor);
    expect(executor.specs).toBe(2);
    expect(executor.returns[0]).toContain("is not in the request");
    expect(service.store.state(runId)?.spec?.criteria[0]?.then).toContain(RIGHT);
    expect(service.store.state(runId)).toMatchObject({ derivationReturns: 1, analysisPassed: true });
  }, 60000);

  test("a quote the request holds passes the row", async () => {
    const executor = new ScriptedExecutor(() => ({ derivation: "The request states the rule: the / that opens the empty segment is /5.", quote: "Position: the `/` that opens the empty segment" }));
    const { service, runId } = await plan(executor);
    expect(executor.specs).toBe(1);
    expect(service.store.state(runId)).toMatchObject({ analysisPassed: true });
  }, 60000);

  test("a derivation that cites the request without a quote is told to quote it", async () => {
    const executor = new ScriptedExecutor(() => ({ derivation: INVENTED }));
    await plan(executor);
    expect(executor.validation[0]).toEqual([
      `Derivation audit: the entry for AC-006 row ${JSON.stringify(WRONG)} rests on the request (the derivation or its requirement says the request states it); copy the request's exact words it relies on into quote, or derive the row from the requirements if the request does not state it.`,
    ]);
  }, 60000);
});

describe("request quotes", () => {
  const derivation = (extra: Partial<Derivation>): Derivation => ({ criterionId: "AC-006", row: WRONG, recomputed: "RS005 empty segment at 1:6", matches: true, derivation: "Indexes: /5 /6.", ...extra });
  const spec = specWith(WRONG);

  test("a quote matches the request across Markdown code spans, quote marks, case, spacing and an ellipsis", () => {
    expect(quoteInRequest("RS005 empty segment. Position: the / that opens", BRIEF)).toBe(true);
    expect(quoteInRequest("“the / that opens the  empty segment” ... /a/ and // each have one", BRIEF)).toBe(true);
    expect(quoteInRequest("// each have one ... the / that opens", BRIEF)).toBe(false);
    expect(quoteInRequest("GET // n", BRIEF)).toBe(false);
    expect(quoteInRequest("...", BRIEF)).toBe(false);
  });

  test("only derivations that rest on the request are checked", () => {
    const plain = derivation({});
    const named = derivation({ derivation: "A GET request line has its path after the method." });
    expect(checkedDerivations([plain, named], BRIEF)).toEqual([plain, named]);
  });

  test("the R55 entry is raised as a blocking finding with the reason", () => {
    const checked = checkedDerivations([derivation({ derivation: INVENTED, quote: "GET // n gives RS005 at 1:6" })], BRIEF);
    expect(checked?.[0]?.matches).toBe(false);
    const findings = derivationFindings(spec, { derivations: checked });
    expect(findings.map((f) => [f.id, f.blocking])).toEqual([["DERIVE-AC-006", true]]);
    expect(findings[0]?.description).toContain('The cited request text "GET // n gives RS005 at 1:6" is not in the request');
  });

  test("a citation without a quote is a problem before submission and a mismatch after", () => {
    const cited = derivation({ derivation: "The brief's example gives 1:6." });
    expect(derivationProblems(spec, { derivations: [cited] })).toHaveLength(1);
    expect(derivationProblems(spec, { derivations: [{ ...cited, quote: "the / that opens" }] })).toEqual([]);
    expect(checkedDerivations([cited], BRIEF)?.[0]).toMatchObject({ matches: false, derivation: expect.stringContaining("cites the request without quoting it") });
  });

  test("a row derived from a requirement that says the request gives it is checked the same way", () => {
    const relayed: Spec = { ...spec, requirements: [{ ...spec.requirements[0]!, text: "The request gives `GET // n` -> `RS005 empty segment at 1:6`" }] };
    const cited = derivation({ derivation: "FR-005 explicitly supplies this expected output." });
    expect(derivationProblems(relayed, { derivations: [cited] })).toHaveLength(1);
    expect(checkedDerivations([cited], BRIEF, relayed)?.[0]?.matches).toBe(false);
    expect(checkedDerivations([{ ...cited, quote: "GET // n" }], BRIEF, relayed)?.[0]?.matches).toBe(false);
    expect(checkedDerivations([cited], BRIEF, spec)).toEqual([cited]);
  });
});
