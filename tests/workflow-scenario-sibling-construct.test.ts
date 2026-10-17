import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 39 (#1397). md-site ec3c22bf: three findings about multiline inline code
// in src/markdown.ts arrived one review round after another (emphasis inside the span, lost
// newlines, the same inside blockquotes), each on another function, so the same-symbol rule of
// #1330 never applied; the corrections cost 1.85M tokens. Here the second finding names another
// symbol in the same file: its correction is told to cover the construct's sibling contexts in
// one table-driven test, and the host's repro check holds the first finding as a regression.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Inline parser", problem: "No parser", outcome: "A parser", inScope: ["Parser"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Delimiters inside code and links are literal", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "inline code or a link", when: "it is parsed", then: "its delimiters are literal", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne parser.\n## Decisions\nDEC-001: FR-001 in inline.txt.\n## Components\ninline.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('inline.txt').text(); if (!t.includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, checks: [check] };
const planned: Task = { id: "T001", title: "Write the inline parser", description: "Write inline.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "inline.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// "code" in the file stands for the inline-code case handled, "link" for the link destination.
const reproFor = (marker: string): Repro => ({ executable: "bun", args: ["-e", `const t = await Bun.file('inline.txt').text(); console.log(t.includes('${marker}') ? 'literal' : 'emphasis')`], expected: "literal", actual: "emphasis" });

class ScriptedExecutor implements AgentExecutor {
  corrections: { findingIds: string[]; sibling?: { files: string[]; earlier: { id: string; repro?: Repro }[]; note: string }; recurring?: unknown; regression: string[] }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; siblingFindings?: { files: string[]; earlier: { id: string; repro?: Repro }[]; note: string }; recurringFindings?: unknown } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const write = (text: string) => writeFileSync(join(this.root, "inline.txt"), text);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["inline.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin === "planned") write("ready");
        else if (this.corrections.length === 0) {
          this.corrections.push({ findingIds: task?.findingIds ?? [], regression: [] });
          write("ready code");
        } else {
          // The second correction first patches only its own case, dropping the first one, as
          // md-site's corrections did; the host's repro check shows the regression.
          write("ready link");
          const regression = (await request.reproCheck?.(this.root, request.signal)) ?? [];
          this.corrections.push({ findingIds: task?.findingIds ?? [], sibling: data.extra.siblingFindings, recurring: data.extra.recurringFindings, regression });
          write("ready code link");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Rewrote the inline parser", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        const text = readFileSync(join(this.root, "inline.txt"), "utf8");
        const finding = (id: string, marker: string, symbol: string, claim: string) => ({ id, kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol, evidenceIds, claim, impact: "Wrong emphasis", suggestedFix: "Keep delimiters literal", repro: reproFor(marker) });
        const findings = !text.includes("code")
          ? [finding("F1", "code", "parseInline", "Emphasis closes inside a multiline inline code span")]
          : !text.includes("link")
            ? [finding("F2", "link", "renderBlockquote", "Multiline inline code inside a blockquote loses its newlines")]
            : [];
        output = findings.length
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: findings[0]?.claim }], findings }
          : pass;
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: md-site ec3c22bf, findings on one construct across functions (#1397)", () => {
  test("a correction after an earlier one in the same file covers the construct's sibling contexts", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-sibling-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse inline Markdown", ownerLabel: "test", policy });
    await service.drive(started.runId, new AbortController().signal);
    const snapshot = await service.get(started.runId);
    const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(started.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const [first, second] = executor.corrections;
    expect(first?.findingIds).toEqual(["F1"]);
    expect(second?.findingIds).toEqual(["F2"]);
    // Another symbol: not the same-symbol rewrite of #1330, but the sibling contexts of the file.
    expect(second?.recurring).toBeUndefined();
    expect(second?.sibling?.files).toEqual(["inline.txt"]);
    expect(second?.sibling?.earlier.map((f) => f.id)).toEqual(["F1"]);
    expect(second?.sibling?.earlier[0]?.repro).toEqual(reproFor("code"));
    expect(second?.sibling?.note).toContain("list every context the construct can appear in");
    expect(first?.sibling).toBeUndefined();
    expect(second?.regression.join("\n")).toContain("F1");
  });
});
