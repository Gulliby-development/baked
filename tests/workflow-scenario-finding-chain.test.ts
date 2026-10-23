import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { CHAIN_REWRITE_AT, type ChainFinding, type ChainRecord, chainMembers, chainRecord, findingChain } from "../src/core/workflows/finding-chain.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 62 (#1959). md-site 8711b632 got six findings on `findDelimitedInline`,
// each the next nesting of emphasis delimiter runs and each `repeatOf` the last, and its four
// correctives patched the reported input one round at a time: 8.41M of 11.6M tokens. Here a fake
// reviewer reports three nested members of one class on one symbol, one per round. With
// `chainRewrite: "on"` the second corrective is a rewrite of the symbol whose input holds the
// battery, and the chain closes after it; off, every corrective patches as before. A rewrite that
// breaks an earlier case is reopened by the host's battery before any review call.
//
// A new corrective origin adds its case here (AGENTS.md).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Inline emphasis", problem: "No parser", outcome: "A parser", inScope: ["Parser"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Nested emphasis delimiter runs follow CommonMark", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "nested delimiter runs", when: "they are parsed", then: "emphasis follows the delimiter-run rules", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne parser.\n## Decisions\nDEC-001: FR-001 in inline.txt.\n## Components\ninline.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('inline.txt').text(); if (!t.includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const basePolicy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, maxConvergenceRounds: 4, checks: [check] };
const planned: Task = { id: "T001", title: "Write the inline parser", description: "Write inline.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "inline.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// Each member of the class is a marker the file must hold: "a" for `**a *b***`, and so on.
const MEMBERS = ["a", "b", "c"] as const;
const reproFor = (marker: string): Repro => ({ executable: "bun", args: ["-e", `const t = await Bun.file('inline.txt').text(); console.log(t.includes('case-${marker}') ? 'nested' : 'flat')`], expected: "nested", actual: "flat" });

interface Correction {
  taskId: string;
  title: string;
  description: string;
  findingIds: string[];
  battery?: { symbol: string; findings: string[]; cases: { findingId: string; command: string; expected: string; actual: string }[]; spec: { criteria: { id: string }[] }; note: string };
  saved?: Record<string, unknown>;
}

class ChainExecutor implements AgentExecutor {
  calls: { output: string; taskId?: string }[] = [];
  corrections: Correction[] = [];
  service?: NativeWorkflowService;
  /** The first rewrite drops the earlier cases, as a rewrite from scratch can. */
  breakFirstRewrite = false;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    this.calls.push({ output: request.profile.output, ...(request.task ? { taskId: request.task.id } : {}) });
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; battery?: Correction["battery"] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const root = request.root ?? this.root;
    const path = join(root, "inline.txt");
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["inline.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin === "planned") writeFileSync(path, "ready");
        else if (task) {
          const row = this.service?.store.latestArtifact(request.runId, `attempts/${request.attemptId}/context.json`);
          const rewrites = this.corrections.filter((c) => c.battery).length;
          this.corrections.push({ taskId: task.id, title: task.title, description: task.description, findingIds: task.findingIds, ...(data.extra.battery ? { battery: data.extra.battery } : {}), saved: row ? JSON.parse(this.service?.store.readArtifact(request.runId, row.id) ?? "{}") : undefined });
          if (data.extra.battery && this.breakFirstRewrite && rewrites === 0) {
            // Only the newest case of the battery: the earlier one fails again.
            const newest = data.extra.battery.cases.at(-1)?.command.match(/case-(\w)/)?.[1] ?? "";
            writeFileSync(path, `ready case-${newest}`);
          } else if (data.extra.battery) {
            // The rewrite restates the algorithm for the whole class, unseen members included.
            writeFileSync(path, `ready ${MEMBERS.map((m) => `case-${m}`).join(" ")}`);
          } else {
            // A patch adds the reported case to what is there.
            const text = readFileSync(path, "utf8");
            const cases = [...task.description.matchAll(/case-(\w)/g)].map((m) => `case-${m[1]}`);
            writeFileSync(path, `${text} ${cases.filter((c) => !text.includes(c)).join(" ")}`.trim());
          }
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Changed the inline parser", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        const text = readFileSync(path, "utf8");
        const index = MEMBERS.findIndex((m) => !text.includes(`case-${m}`));
        const marker = MEMBERS[index];
        const findings = marker
          ? [{ id: `F${index + 1}`, kind: "correctness", severity: "high", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol: index % 2 ? "Inline.findDelimitedInline()" : "findDelimitedInline", evidenceIds, claim: `Nested delimiter run case-${marker} is parsed flat`, impact: "Wrong emphasis", suggestedFix: `Handle case-${marker}`, repro: reproFor(marker), repeatOf: index ? `F${index}` : null }]
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

async function drive(options: { policy?: Partial<RunPolicy>; quality?: { chainRewrite: "on" | "off" }; breakFirstRewrite?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "baked-finding-chain-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ChainExecutor(root);
  executor.breakFirstRewrite = options.breakFirstRewrite ?? false;
  const policy: RunPolicy = { ...basePolicy, ...options.policy };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", ...(options.quality ? { quality: options.quality } : {}), workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse nested emphasis", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const artifacts = (prefix: string) =>
    service.store
      .artifacts(started.runId)
      .filter((a) => a.logical_path.startsWith(prefix))
      .map((a) => JSON.parse(service.store.readArtifact(started.runId, a.id)) as Record<string, unknown>);
  return { root, runId: started.runId, done, executor, service, artifacts };
}

describe("scenario: R62 md-site, a finding chain on one symbol (#1959)", () => {
  test("with chainRewrite on, the second corrective rewrites the symbol against the battery and the chain closes", async () => {
    // The project setting turns it on; the run freezes it in its policy.
    const { root, runId, done, executor, service, artifacts } = await drive({ quality: { chainRewrite: "on" } });
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).policy_json).toContain('"chainRewrite":"on"');
    expect(CHAIN_REWRITE_AT).toBe(2);
    const [patch, rewrite, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect(patch?.findingIds).toEqual(["F1"]);
    expect(patch?.battery).toBeUndefined();
    expect(patch?.saved?.battery).toBeUndefined();
    expect(rewrite?.findingIds).toEqual(["F2"]);
    expect(rewrite?.title).toStartWith("Rewrite findDelimitedInline:");
    expect(rewrite?.description).toContain("rewrite findDelimitedInline from the algorithm");
    expect(rewrite?.description).not.toContain("This finding repeats F1");
    expect(rewrite?.battery).toMatchObject({ symbol: "findDelimitedInline", findings: ["F1", "F2"], spec: { criteria: [{ id: "AC-001" }] } });
    expect(rewrite?.battery?.cases.map((c) => [c.findingId, c.expected, c.actual])).toEqual([["F1", "nested", "flat"], ["F2", "nested", "flat"]]);
    expect(rewrite?.battery?.cases[0]?.command).toContain("case-a");
    expect(rewrite?.battery?.note).toContain("reference algorithm");
    // The saved attempt context is what the rewrite was sent (#1566).
    expect(rewrite?.saved?.battery).toEqual(rewrite?.battery);
    // No third finding: the rewrite covered the class.
    expect(executor.calls.filter((c) => c.output === "convergence")).toHaveLength(3);
    expect(readFileSync(join(root, "inline.txt"), "utf8")).toContain("case-c");
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.taskId, d.findingId, d.length, d.decision])).toEqual([[rewrite?.taskId, "F2", 2, "rewrite"]]);
    const batteries = artifacts("chains/battery/");
    expect(batteries.map((b) => b.decision)).toEqual(["pass"]);
    expect((batteries[0]?.cases as { findingId: string; status: string }[]).map((c) => [c.findingId, c.status])).toEqual([["F1", "refuted"], ["F2", "refuted"]]);

    // The decisions replay from the bench trace (#1649): the current rules decide them as recorded,
    // and a rule that never rewrites differs on the rewrite.
    const dir = mkdtempSync(join(tmpdir(), "finding-chain-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.findingChains.map((b) => [b.kind, b.recorded, b.replayed])).toEqual([["rewrite", "rewrite", "rewrite"], ["battery", "pass", "pass"]]);
    expect(replayed?.newChainDecisions).toBe(0);
    const patching = replayTrace(out, { chainRule: () => "patch" }).runs.find((r) => r.runId === runId);
    expect(patching?.newChainDecisions).toBe(1);
  }, 120_000);

  test("with chainRewrite off, every corrective patches as before", async () => {
    const { done, executor, artifacts } = await drive({});
    expect(done.status).toBe("completed");
    expect(executor.corrections.map((c) => c.findingIds)).toEqual([["F1"], ["F2"], ["F3"]]);
    for (const correction of executor.corrections) {
      expect(correction.battery).toBeUndefined();
      expect(correction.saved?.battery).toBeUndefined();
      expect(correction.title).toStartWith("Correct:");
    }
    expect(executor.corrections[1]?.description).toContain("This finding repeats F1");
    // The chain is recorded, decided as a patch, and no battery runs.
    expect((artifacts("chains/tasks/") as unknown as ChainRecord[]).map((d) => [d.findingId, d.length, d.policy, d.decision])).toEqual([["F2", 2, "off", "patch"], ["F3", 3, "off", "patch"]]);
    expect(artifacts("chains/battery/")).toEqual([]);
  }, 120_000);

  test("a rewrite that breaks an earlier battery case is reopened by the host's battery with no review call", async () => {
    const { done, executor, artifacts } = await drive({ policy: { chainRewrite: "on" }, breakFirstRewrite: true });
    expect(done.status).toBe("completed");
    const [patch, rewrite, reopened, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect(patch?.findingIds).toEqual(["F1"]);
    expect(rewrite?.findingIds).toEqual(["F2"]);
    expect(reopened?.title).toStartWith("Rewrite findDelimitedInline:");
    expect(reopened?.description).toContain("Battery case F1 of findDelimitedInline");
    expect(reopened?.battery?.cases.map((c) => c.command.match(/case-(\w)/)?.[1])).toEqual(["a", "b"]);
    // Between the broken rewrite and its reopening the host called no reviewer.
    const calls = executor.calls;
    const from = calls.findIndex((c) => c.taskId === rewrite?.taskId);
    const to = calls.findIndex((c) => c.taskId === reopened?.taskId);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(calls.slice(from + 1, to).filter((c) => c.output === "review" || c.output === "convergence")).toEqual([]);
    const batteries = artifacts("chains/battery/");
    expect(batteries.map((b) => b.decision)).toEqual(["reopen", "pass"]);
    expect((batteries[0]?.cases as { findingId: string; status: string }[]).map((c) => [c.findingId, c.status])).toEqual([["F1", "reproduced"], ["F2", "refuted"]]);
  }, 120_000);
});

describe("the R62 md-site chain on findDelimitedInline (#1959)", () => {
  // The findings of run 8711b632 as the review linked them: F1 stood alone, F3 repeated F2, F4 and
  // F4-2 repeated F3, F5 repeated F4. T010 corrected F3, T011 F4 and F4-2, T012 F5.
  const finding = (id: string, repeatOf: string | null, symbol = "findDelimitedInline"): ChainFinding => ({ id, file: "src/markdown.ts", symbol, repeatOf, claim: id, severity: "high", status: "resolved", requirementIds: [], criterionIds: [], repro: reproFor(id.toLowerCase()) });
  const all = new Map([finding("F1", null), finding("F2", null), finding("F3", "F2"), finding("F4", "F3"), finding("F4-2", "F3"), finding("F5", "F4"), finding("F6", "F5", "renderInline")].map((f) => [f.id, f]));
  const at = (id: string) => findingChain(all, all.get(id) as ChainFinding);

  test("the second link rewrites: T010 instead of T012", () => {
    expect(at("F2").map((f) => f.id)).toEqual(["F2"]);
    expect(at("F3").map((f) => f.id)).toEqual(["F2", "F3"]);
    expect(at("F5").map((f) => f.id)).toEqual(["F2", "F3", "F4", "F5"]);
    // A link to another symbol ends the chain.
    expect(at("F6").map((f) => f.id)).toEqual(["F6"]);
    expect(chainRecord("T010", all.get("F3") as ChainFinding, at("F3"), "on").decision).toBe("rewrite");
    expect(chainRecord("T010", all.get("F3") as ChainFinding, at("F3"), "off").decision).toBe("patch");
    expect(chainRecord("T009", all.get("F2") as ChainFinding, at("F2"), "on").decision).toBe("patch");
  });

  test("the battery holds the chain's side branches", () => {
    expect(chainMembers(all, at("F5")).map((f) => f.id)).toEqual(["F2", "F3", "F4", "F4-2", "F5"]);
  });
});
