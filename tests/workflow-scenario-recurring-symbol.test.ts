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

// Scenario of bench round 33 (#1330). md-site 11b11f19: the inline parser got one finding per
// pass (strong emphasis inside inline code, then inside a link destination), and each correction
// patched where the previous one left off; the five corrections cost 5.44M tokens. Here the
// second finding lands on the same symbol: its correction is told to rewrite the symbol against
// the first finding too, and the host's repro check holds the first finding as a regression.

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
  corrections: { findingIds: string[]; recurring?: { earlier: { id: string; repro?: Repro }[]; note: string }; regression: string[] }[] = [];
  service?: NativeWorkflowService;
  contexts: { taskId: string; findingIds: string[]; sent: Record<string, unknown>; saved?: Record<string, unknown> }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; recurringFindings?: { earlier: { id: string; repro?: Repro }[]; note: string } } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const root = request.root ?? this.root;
    const write = (text: string) => writeFileSync(join(root, "inline.txt"), text);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["inline.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        const row = this.service?.store.latestArtifact(request.runId, `attempts/${request.attemptId}/context.json`);
        this.contexts.push({ taskId: task?.id ?? "", findingIds: task?.findingIds ?? [], sent: data.extra, saved: row ? JSON.parse(this.service?.store.readArtifact(request.runId, row.id) ?? "{}") : undefined });
        if (task?.origin === "planned") write("ready");
        else if (this.corrections.length === 0) {
          this.corrections.push({ findingIds: task?.findingIds ?? [], regression: [] });
          write("ready code");
        } else {
          // The second correction first patches only its own case, dropping the first one, as
          // md-site's corrections did; the host's repro check shows the regression.
          write("ready link");
          const regression = (await request.reproCheck?.(root, request.signal)) ?? [];
          this.corrections.push({ findingIds: task?.findingIds ?? [], recurring: data.extra.recurringFindings, regression });
          write("ready code link");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Rewrote the inline parser", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        const text = readFileSync(join(root, "inline.txt"), "utf8");
        const finding = (id: string, marker: string, symbol: string, claim: string) => ({ id, kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol, evidenceIds, claim, impact: "Wrong emphasis", suggestedFix: "Keep delimiters literal", repro: reproFor(marker) });
        const findings = !text.includes("code")
          ? [finding("F1", "code", "parseInline", "Strong emphasis is applied inside inline code")]
          : !text.includes("link")
            ? [finding("F2", "link", "Parser.parseInline()", "Strong emphasis consumes delimiters in a link destination")]
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

describe("scenario: md-site 11b11f19, findings that recur on one symbol (#1330)", () => {
  test.each([false, true])("records the second correction's recurring context before execution, worktree=%s (#1566)", async (worktree) => {
    const root = mkdtempSync(join(tmpdir(), "baked-recurring-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    if (worktree) {
      for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test User"], ["config", "user.email", "test@example.test"], ["config", "commit.gpgsign", "false"], ["commit", "-q", "--allow-empty", "-m", "Initial"]]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      }
    }
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    executor.service = service;
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse inline Markdown", ownerLabel: "test", policy, ...(worktree ? { executionMode: "worktree" as const, maxConcurrentWriters: 2 } : {}) });
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
    expect(second?.recurring?.earlier.map((f) => f.id)).toEqual(["F1"]);
    expect(second?.recurring?.earlier[0]?.repro).toEqual(reproFor("code"));
    expect(second?.recurring?.note).toContain("rewrite the symbol for its whole input class");
    expect(second?.regression.join("\n")).toContain("F1");
    for (const context of executor.contexts) {
      expect(context.saved).toBeDefined();
      expect(context.saved?.schemaVersion).toBe(1);
      expect(context.saved?.taskId).toBe(context.taskId);
      expect(context.saved?.findingIds).toEqual(context.findingIds);
      expect(context.saved?.recurringFindings).toEqual(context.sent.recurringFindings);
      expect(context.saved?.correctionFocus).toEqual(context.sent.correctionFocus);
      expect(context.saved?.siblingFindings).toEqual(context.sent.siblingFindings);
    }
    const [initial, firstCorrection, secondCorrection] = executor.contexts;
    expect(initial?.saved?.recurringFindings).toBeUndefined();
    expect(firstCorrection?.saved?.recurringFindings).toBeUndefined();
    expect(secondCorrection?.saved?.recurringFindings).toMatchObject({ symbols: ["parseInline"], earlier: [{ id: "F1", repro: reproFor("code") }] });
    expect(secondCorrection?.saved?.correctionFocus).toMatchObject({ files: ["inline.txt"], symbols: ["Parser.parseInline()"] });
  }, 60000);
});
