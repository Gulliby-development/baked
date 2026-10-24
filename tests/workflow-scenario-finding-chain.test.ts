import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { CHAIN_REWRITE_AT, type ChainFinding, type ChainRecord, chainMembers, chainRecord, familyKey, findingChain } from "../src/core/workflows/finding-chain.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { chainCosts, exportTrace, openTrace, replayChainEscalation, replayTrace } from "../src/core/workflows/trace.js";
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

/** The symbols of report.py the family scenario's findings name, one per round. */
const FAMILY_SYMBOLS = ["build_report", "_share", "render_table"] as const;

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
  /**
   * Each round's finding is on another symbol of the file with `repeatOf: null` and one family, as
   * R66 expenses-py F2 (`build_report`) and F3 (`_share`) were (#2048).
   */
  family = false;
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
          ? [{ id: `F${index + 1}`, kind: "correctness", severity: "high", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol: this.family ? FAMILY_SYMBOLS[index] : index % 2 ? "Inline.findDelimitedInline()" : "findDelimitedInline", evidenceIds, claim: `Nested delimiter run case-${marker} is parsed flat`, impact: "Wrong emphasis", suggestedFix: `Handle case-${marker}`, repro: reproFor(marker), ...(this.family ? { repeatOf: null, family: index === 1 ? "Decimal context precision" : "decimal-context-precision" } : { repeatOf: index ? `F${index}` : null }) }]
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

async function drive(options: { policy?: Partial<RunPolicy>; quality?: { chainRewrite: "on" | "off" }; breakFirstRewrite?: boolean; family?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "baked-finding-chain-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ChainExecutor(root);
  executor.breakFirstRewrite = options.breakFirstRewrite ?? false;
  executor.family = options.family ?? false;
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

    // The trace keeps each finding's links and repro without its prose (#1981), so the chain the
    // rewrite saw replays from the findings, and the round report reads the chain's length,
    // battery and cost from the trace.
    const traced = openTrace(out);
    cleanups.push(traced.dispose);
    const body = JSON.parse(traced.store.findings(runId).find((f) => f.id === "F2")?.body_json ?? "{}");
    expect(body).toMatchObject({ repeatOf: "F1", file: "inline.txt", symbol: "Inline.findDelimitedInline()", repro: { expected: "nested", actual: "flat" } });
    expect(body.claim).toMatch(/^claim-\d+$/);
    expect(JSON.stringify(body)).not.toContain("case-b");
    const escalation = replayChainEscalation(traced.store, runId);
    expect(escalation.missingBodies).toEqual([]);
    expect(escalation.steps.map((s) => [s.findingId, s.chain, s.decision, s.battery])).toEqual([["F1", ["F1"], "patch", []], ["F2", ["F1", "F2"], "rewrite", ["F1", "F2"]]]);
    expect(replayChainEscalation(traced.store, runId, { policy: "off" }).steps.map((s) => s.decision)).toEqual(["patch", "patch"]);
    const [chain, ...others] = chainCosts(traced.store, runId);
    expect(others).toEqual([]);
    expect(chain).toMatchObject({ file: "inline.txt", symbol: "findDelimitedInline", length: 2, findings: ["F1", "F2"], battery: { runs: 1, cases: 2, reproduced: 0, refuted: 2, inconclusive: 0, reopened: 0 } });
    expect(chain?.tasks.map((t) => [t.taskId, t.decision])).toEqual([[patch?.taskId, "patch"], [rewrite?.taskId, "rewrite"]]);
    expect(chain?.tokens).toBe(chain?.tasks.reduce((sum, t) => sum + t.tokens, 0));
    expect(chain?.tokens).toBeGreaterThan(0);
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

describe("scenario: R66 expenses-py, a chain of one defect family on different symbols of a file (#2048)", () => {
  test("with chainRewrite on, the second finding of the family rewrites against both cases although its symbol and repeatOf differ", async () => {
    const { root, runId, done, executor, service, artifacts } = await drive({ policy: { chainRewrite: "on" }, family: true });
    expect(done.status).toBe("completed");
    const [patch, rewrite, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect(patch?.findingIds).toEqual(["F1"]);
    expect(patch?.battery).toBeUndefined();
    expect(rewrite?.findingIds).toEqual(["F2"]);
    expect(rewrite?.title).toStartWith("Rewrite _share:");
    expect(rewrite?.description).toContain("case 2 of the defect class decimal-context-precision in inline.txt (F1, F2, on build_report, _share)");
    expect(rewrite?.battery).toMatchObject({ symbol: "_share", family: "decimal-context-precision", symbols: ["build_report", "_share"], findings: ["F1", "F2"] });
    expect(rewrite?.battery?.cases.map((c) => c.findingId)).toEqual(["F1", "F2"]);
    expect(rewrite?.saved?.battery).toEqual(rewrite?.battery);
    expect(readFileSync(join(root, "inline.txt"), "utf8")).toContain("case-c");
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.findingId, d.length, d.family, d.symbols, d.decision])).toEqual([["F2", 2, "decimal-context-precision", ["build_report", "_share"], "rewrite"]]);
    expect(artifacts("chains/battery/").map((b) => b.decision)).toEqual(["pass"]);

    // The trace keeps the family, the replay reads it as a column, and the round report groups the
    // chain by file and family.
    const dir = mkdtempSync(join(tmpdir(), "finding-family-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    expect(replayTrace(out).runs.find((r) => r.runId === runId)?.newChainDecisions).toBe(0);
    const traced = openTrace(out);
    cleanups.push(traced.dispose);
    expect(JSON.parse(traced.store.findings(runId).find((f) => f.id === "F2")?.body_json ?? "{}")).toMatchObject({ family: "decimal-context-precision", symbol: "_share", repeatOf: null });
    const escalation = replayChainEscalation(traced.store, runId);
    expect(escalation.steps.map((s) => [s.findingId, s.chain, s.family, s.decision, s.battery])).toEqual([["F1", ["F1"], "decimal-context-precision", "patch", []], ["F2", ["F1", "F2"], "decimal-context-precision", "rewrite", ["F1", "F2"]]]);
    const [chain, ...others] = chainCosts(traced.store, runId);
    expect(others).toEqual([]);
    expect(chain).toMatchObject({ file: "inline.txt", family: "decimal-context-precision", length: 2, findings: ["F1", "F2"], battery: { runs: 1, cases: 2 } });
    expect(service.store.run(runId).policy_json).toContain('"chainRewrite":"on"');
  }, 120_000);

  test("with chainRewrite off, the family chain is recorded and every corrective patches", async () => {
    const { done, executor, artifacts } = await drive({ family: true });
    expect(done.status).toBe("completed");
    expect(executor.corrections.map((c) => [c.findingIds, c.battery])).toEqual([[["F1"], undefined], [["F2"], undefined], [["F3"], undefined]]);
    expect((artifacts("chains/tasks/") as unknown as ChainRecord[]).map((d) => [d.findingId, d.length, d.decision])).toEqual([["F2", 2, "patch"], ["F3", 3, "patch"]]);
  }, 120_000);
});

describe("the chain key: file and symbol, or file and family (#2048)", () => {
  const finding = (id: string, symbol: string, family: string | null, repairTaskId: string | null, file = "expenses/report.py"): ChainFinding => ({ id, file, symbol, family, repeatOf: null, repairTaskId, claim: id, severity: "high", status: "resolved", requirementIds: [], criterionIds: [], repro: reproFor(id.toLowerCase()) });
  const chainOf = (findings: ChainFinding[], id: string) => {
    const all = new Map(findings.map((f) => [f.id, f]));
    return findingChain(all, all.get(id) as ChainFinding).map((f) => f.id);
  };

  test("a later case of the family on another symbol joins the latest addressed one", () => {
    const findings = [finding("F1", "render_table", null, "T010"), finding("F2", "build_report", "decimal-context-precision", "T010"), finding("F3", "_share", "decimal-context-precision", "T011")];
    expect(chainOf(findings, "F3")).toEqual(["F2", "F3"]);
    expect(chainOf(findings, "F2")).toEqual(["F2"]);
    expect(chainOf(findings, "F1")).toEqual(["F1"]);
  });

  test("a case found in the same round, another file, another family or no family is no link", () => {
    expect(chainOf([finding("F2", "build_report", "decimal-context-precision", null), finding("F3", "_share", "decimal-context-precision", null)], "F3")).toEqual(["F3"]);
    expect(chainOf([finding("F2", "build_report", "decimal-context-precision", "T010"), finding("F3", "_share", "decimal-context-precision", "T010")], "F3")).toEqual(["F3"]);
    expect(chainOf([finding("F2", "build_report", "decimal-context-precision", "T010", "expenses/other.py"), finding("F3", "_share", "decimal-context-precision", "T011")], "F3")).toEqual(["F3"]);
    expect(chainOf([finding("F2", "build_report", "nested-inline-delimiters", "T010"), finding("F3", "_share", "decimal-context-precision", "T011")], "F3")).toEqual(["F3"]);
    expect(chainOf([finding("F2", "build_report", null, "T010"), finding("F3", "_share", null, "T011")], "F3")).toEqual(["F3"]);
  });

  test("a repeatOf link may point to either half of the key, and a family chain grows by its latest case", () => {
    const linked = { ...finding("F3", "_share", "decimal-context-precision", "T012"), repeatOf: "F1" };
    expect(chainOf([finding("F1", "build_report", "decimal-context-precision", "T010"), finding("F2", "total", "decimal-context-precision", "T011"), linked], "F3")).toEqual(["F1", "F3"]);
    expect(chainOf([finding("F1", "build_report", "decimal-context-precision", "T010"), finding("F2", "total", "decimal-context-precision", "T011"), finding("F3", "_share", "decimal-context-precision", "T012")], "F3")).toEqual(["F1", "F2", "F3"]);
  });

  test("a family label is compared folded", () => {
    expect(familyKey(" Decimal context_precision ")).toBe("decimal-context-precision");
    expect(familyKey("--")).toBeNull();
    expect(familyKey(null)).toBeNull();
  });
});

describe("the R62 md-site chain on findDelimitedInline (#1959)", () => {
  // The findings of run 8711b632 as the review linked them: F1 stood alone, F3 repeated F2, F4 and
  // F4-2 repeated F3, F5 repeated F4. T010 corrected F3, T011 F4 and F4-2, T012 F5.
  const finding = (id: string, repeatOf: string | null, symbol = "findDelimitedInline"): ChainFinding => ({ id, file: "src/markdown.ts", symbol, family: null, repeatOf, repairTaskId: null, claim: id, severity: "high", status: "resolved", requirementIds: [], criterionIds: [], repro: reproFor(id.toLowerCase()) });
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
