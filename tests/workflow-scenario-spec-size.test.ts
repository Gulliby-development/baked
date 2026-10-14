import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import {
  criteriaLimit,
  requestExamples,
  SPEC_CRITERIA_FLOOR,
} from "../src/core/workflows/spec-size.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 18 (#1013): stmtsplit e29347c1 on claude-code wrote a 53.6 KB spec with
// 43 criteria for a brief whose codex runs needed 6 to 12, one criterion per example of the brief.
// Every later stage read the whole spec, and planning came to 59 percent of the run's dollars. The
// spec author is now told the size the request calls for, and a spec far above it goes back once
// before the planner reads it.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = [
  "Build a statement splitter CLI with tests. It splits SQL text into statements:",
  "- `select 1; select 2` gives two statements",
  "- a semicolon inside a string literal does not split",
  "- a trailing statement without a semicolon is kept",
].join("\n");
const SIZE = /criteria for a request that lists/;

function specWith(count: number): Spec {
  return {
    schemaVersion: 1,
    featureId: "fixture",
    revision: 1,
    title: "Statement splitter",
    problem: "SQL text holds several statements",
    outcome: "Statements are split",
    inScope: ["Split statements"],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    requirements: [{ id: "FR-001", text: "Statements are split", priority: "must", verification: "automated", sourceRefs: [] }],
    criteria: Array.from({ length: count }, (_, i) => ({
      id: `AC-${String(i + 1).padStart(3, "0")}`,
      requirementIds: ["FR-001"],
      given: `example ${String(i + 1)}`,
      when: "it is split",
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the acceptance-criterion contract.
      then: "the statements match",
      method: "automated" as const,
    })),
    dependencies: [],
  };
}

const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 in split.ts.\n## Components\nsplit.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume" };

/** A spec author that writes one criterion per example until it is told the size. */
class ScriptedExecutor implements AgentExecutor {
  submissions: number[] = [];
  corrections: string[][] = [];
  specPrompt = "";
  planSaw: Spec | null = null;
  constructor(private readonly sizes: number[]) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["split.ts"] }; break;
      case "spec": {
        this.specPrompt = `${request.profile.instructions}\n${request.prompt}`;
        // The submit tool's corrections: each sent-back spec is followed by the next size.
        for (const size of this.sizes) {
          const spec = specWith(size);
          this.submissions.push(size);
          const errors = (request.validate?.(spec) ?? []).filter((e) => SIZE.test(e));
          this.corrections.push(errors);
          output = spec;
          if (!errors.length) break;
        }
        break;
      }
      case "plan": {
        // The planner's context carries the documents on one line of canonical JSON.
        const documents = request.prompt
          .split("\n")
          .filter((line) => line.startsWith("{") && line.includes('"spec"'))
          .map((line) => JSON.parse(line) as { spec?: Spec })
          .find((d) => d.spec);
        const spec = documents?.spec ?? null;
        this.planSaw = spec;
        const ids = spec?.criteria.map((c) => c.id) ?? ["AC-001"];
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write split.ts", description: "Split statements", requirementIds: ["FR-001"], criterionIds: ids, dependsOn: [], profileId: "implementer", writes: [{ path: "split.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runSpec(sizes: number[]): Promise<ScriptedExecutor> {
  const root = mkdtempSync(join(tmpdir(), "baked-spec-size-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(sizes);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  return executor;
}

describe("scenario: stmtsplit e29347c1, a spec with a criterion per example (#1013)", () => {
  test("the spec author is told the size the request calls for", async () => {
    const executor = await runSpec([3]);
    expect(executor.specPrompt).toContain("one criterion per behavior group");
    expect(executor.specPrompt).toContain(`at most about ${String(SPEC_CRITERIA_FLOOR)} criteria`);
  });

  test("an oversized spec goes back once and the planner reads the compact one", async () => {
    const executor = await runSpec([43, 3]);
    expect(executor.submissions).toEqual([43, 3]);
    expect(executor.corrections[0]?.join("\n")).toContain("The spec has 43 criteria");
    expect(executor.planSaw?.criteria).toHaveLength(3);
  });

  test("the author's second submission stands even when it is still large", async () => {
    const executor = await runSpec([43, 30]);
    expect(executor.submissions).toEqual([43, 30]);
    expect(executor.corrections[1]).toEqual([]);
    expect(executor.planSaw?.criteria).toHaveLength(30);
  });

  test("a spec within the limit is not sent back", async () => {
    const executor = await runSpec([SPEC_CRITERIA_FLOOR]);
    expect(executor.corrections).toEqual([[]]);
  });
});

describe("request examples", () => {
  test("counts list items, table rows below the header and code blocks", () => {
    const request = [
      "Intro",
      "- one",
      "* two",
      "1. three",
      "",
      "| input | output |",
      "| --- | --- |",
      "| a | b |",
      "| c | d |",
      "",
      "```",
      "- not an item",
      "```",
    ].join("\n");
    expect(requestExamples(request)).toBe(6);
  });
  test("the limit grows with the examples above the floor", () => {
    expect(criteriaLimit("Build a tool")).toBe(SPEC_CRITERIA_FLOOR);
    expect(criteriaLimit(Array.from({ length: 10 }, (_, i) => `- item ${String(i)}`).join("\n"))).toBe(20);
  });
});
