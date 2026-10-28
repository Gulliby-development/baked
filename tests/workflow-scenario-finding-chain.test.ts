import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../src/core/intelligence/language-records.js";
import { CHAIN_REWRITE_AT, type ChainFinding, type ChainRecord, chainMembers, chainRecord, containsSymbol, type FamilyRecord, familyKey, findingChain, rewriteStep, symbolKey } from "../src/core/workflows/finding-chain.js";
import { type Check, type Repro, ReviewSchema, type RunPolicy, type Spec, type Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { chainCosts, exportTrace, openTrace, replayChainEscalation, replayFindingChains, replayTrace, scrubTrace } from "../src/core/workflows/trace.js";
import { checkSites, keptSites, type SitesRecord } from "../src/core/verification/family-sites.js";
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

/** The planned test file of the test-file chain scenario (#2098). */
const TEST_FILE = "inline.test.ts";

/**
 * The spec files of the cross-file family scenario (#2334), one finding per round: R74 callmend
 * cmd F1, F1-2 and F1-3. The third is in another directory than the first two, so only the chain
 * names it beside them.
 */
const SPEC_FILES = ["spec/cmd/stream_command_spec.rb", "spec/cmd/check_command_spec.rb", "spec/cli_spec.rb"] as const;

/** The generated input of R74 callmend's specs, in Ruby: three backslashes by repetition. */
const GENERATED = String.raw`"\\" * 3`;
/** The same input as a literal example. */
const LITERAL = String.raw`"\\\\\\"`;

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
  /**
   * Each round's finding is on the planned test file, the first without a symbol and the next on
   * a test method with `repeatOf` the first, as R67 ampwhy F2 and F4 were (#2098).
   */
  testFile = false;
  /**
   * Each round's finding is on the next of `SPEC_FILES`, without a symbol or a repro, family
   * `literal-test-inputs`, as R74 callmend cmd F1, F1-2 and F1-3 were (#2334). The second is
   * `repeatOf: F1`; the third links by its family alone, since a second repeat without a repro is
   * a contradiction the host accepts as a known limitation (R74 F1-3 got no corrective).
   */
  crossFile = false;
  /**
   * With `crossFile`, the reviewer states the family's `sites` on all three spec files (#2343):
   * the third holds the construct only in a comment, so the host drops it. A corrective fixes the
   * reported file and every site its input lists; the reviewer flags any spec file still building
   * its input, so a corrective that lists no sites leaves the next file for another round.
   */
  sites = false;
  /** With `sites`, the reviewer states none: the corrective gets only the reported file. */
  noSites = false;
  /** The earlier findings each review was shown, in order. */
  earlier: unknown[][] = [];
  /** The members of the class the reviewer finds, one per round. */
  members: readonly string[] = MEMBERS;
  /** A rewrite writes only the cases its battery holds, so a member it was not shown stays open. */
  batteryOnly = false;
  /** The cases the sibling probe proposes (#1969), by marker; `pass` is one the code gets right. */
  probe: string[] = [];
  /**
   * The first finding names a class and the next a member of it, each `repeatOf` the first, as R68
   * ewvet scanner F1 (`Scanner`) and F1-3 (`Scanner.IsEncodingToken`) were (#2137).
   */
  container = false;
  /**
   * The first corrective changes no file, and the reviewer reports its finding again as
   * `F1-repeat` (`repeatOf: F1`), as R68 ewvet scanner T010 and F1-repeat were (#2137).
   */
  emptyFirst = false;
  private reported = new Set<string>();
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
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [this.testFile ? { ...planned, writes: [...planned.writes, { path: TEST_FILE, action: "create" as const }] } : this.crossFile ? { ...planned, writes: [...planned.writes, ...SPEC_FILES.map((path) => ({ path, action: "create" as const }))] } : planned] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin === "planned") {
          writeFileSync(path, "ready");
          if (this.testFile) writeFileSync(join(root, TEST_FILE), "test('inline', () => {});\n");
          if (this.crossFile)
            for (const [index, file] of SPEC_FILES.entries()) {
              mkdirSync(dirname(join(root, file)), { recursive: true });
              writeFileSync(join(root, file), this.sites && index === 2 ? `it("streams") { expect(run(${LITERAL})).to eq(0) }\n# was: ${GENERATED}\n` : `it("streams") { expect(run(${GENERATED})).to eq(0) }\n`);
            }
        }
        else if (task && this.sites) {
          this.corrections.push({ taskId: task.id, title: task.title, description: task.description, findingIds: task.findingIds });
          // The reported file and every listed site get the literal input.
          const listed = (task.description.split("Sites of this defect class")[1] ?? "").split("\n").flatMap((l) => l.match(/^- ([^:]+):/)?.[1] ?? []);
          const reported = SPEC_FILES.filter((file) => task.description.includes(`${file} generates`));
          for (const file of new Set([...reported, ...listed])) writeFileSync(join(root, file), `it("streams") { expect(run(${LITERAL})).to eq(0) }\n`);
        }
        else if (task) {
          const row = this.service?.store.latestArtifact(request.runId, `attempts/${request.attemptId}/context.json`);
          const rewrites = this.corrections.filter((c) => c.battery).length;
          this.corrections.push({ taskId: task.id, title: task.title, description: task.description, findingIds: task.findingIds, ...(data.extra.battery ? { battery: data.extra.battery } : {}), saved: row ? JSON.parse(this.service?.store.readArtifact(request.runId, row.id) ?? "{}") : undefined });
          if (this.emptyFirst && this.corrections[0]?.taskId === task.id) {
            // "I made no edits in this task": the corrective reports implemented and changes nothing.
          } else if (data.extra.battery && this.breakFirstRewrite && rewrites === 0) {
            // Only the newest case of the battery: the earlier one fails again.
            const newest = data.extra.battery.cases.at(-1)?.command.match(/case-(\w)/)?.[1] ?? "";
            writeFileSync(path, `ready case-${newest}`);
          } else if (data.extra.battery && this.batteryOnly) {
            const shown = data.extra.battery.cases.flatMap((c) => c.command.match(/case-(\w)/)?.[1] ?? []);
            writeFileSync(path, `ready ${shown.map((m) => `case-${m}`).join(" ")}`);
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
      case "chain-family": {
        // The family around the battery: new members, one already in the battery, one the code gets right.
        const shown = data.extra as unknown as { cases: { command: string }[]; executables: string[] };
        expect(shown.cases.length).toBeGreaterThanOrEqual(2);
        expect(shown.executables).toContain("bun");
        const { actual: _, ...known } = reproFor("a");
        const cases = this.probe.map((m) => {
          const { actual: _a, ...repro } = reproFor(m);
          return m === "pass" ? { ...repro, args: ["-e", "console.log('nested')"] } : repro;
        });
        output = { schemaVersion: 1, cases: [known, ...cases], rationale: "Deeper nesting of the reported delimiter runs" };
        break;
      }
      case "convergence": {
        this.earlier.push((data.extra as { earlierFindings?: unknown[] }).earlierFindings ?? []);
        if (this.sites) {
          // A spec file that still builds its input in code (a commented one does not).
          const open = SPEC_FILES.findIndex((file) => readFileSync(join(root, file), "utf8").startsWith(`it("streams") { expect(run(${GENERATED}`));
          const file = SPEC_FILES[open];
          const sites = SPEC_FILES.map((f, i) => ({ file: f, line: i === 2 ? 2 : 1, text: GENERATED }));
          output = file
            ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Generated input" }], findings: [{ id: `F${open + 1}`, kind: "partial", severity: "medium", basis: "spec", confidence: 0.9, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file, symbol: null, family: "literal-test-inputs", ...(this.noSites ? {} : { sites }), evidenceIds, claim: `${file} generates its input with repetition instead of a literal example`, impact: "The test does not show the literal input the criteria name", suggestedFix: "Write the input as a literal example", repeatOf: null }] }
            : pass;
          break;
        }
        const text = readFileSync(path, "utf8");
        const index = this.members.findIndex((m) => !text.includes(`case-${m}`));
        const marker = this.members[index];
        const again = this.emptyFirst && marker !== undefined && this.reported.has(marker);
        if (marker) this.reported.add(marker);
        const findings = marker && again
          ? [{ id: `F${index + 1}-repeat`, kind: "correctness", severity: "high", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol: "findDelimitedInline", evidenceIds, claim: `Nested delimiter run case-${marker} is still parsed flat`, impact: "Wrong emphasis", suggestedFix: `Handle case-${marker}`, repro: reproFor(marker), repeatOf: `F${index + 1}` }]
          : marker && this.container
          ? [{ id: `F${index + 1}`, kind: "missing", severity: "high", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol: index ? "Scanner.IsEncodingToken" : "Scanner", evidenceIds, claim: `Nested delimiter run case-${marker} is parsed flat`, impact: "Wrong emphasis", suggestedFix: `Handle case-${marker}`, repro: reproFor(marker), repeatOf: index ? "F1" : null }]
          : marker && this.crossFile
          ? [{ id: index ? `F1-${index + 1}` : "F1", kind: "partial", severity: "medium", basis: "spec", confidence: 0.9, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: SPEC_FILES[index], symbol: null, family: "literal-test-inputs", evidenceIds, claim: `${SPEC_FILES[index]} generates its input for case-${marker} with a loop and interpolation instead of a literal example`, impact: "The test does not show the literal input the criteria name", suggestedFix: `Write case-${marker} as a literal example`, repeatOf: index === 1 ? "F1" : null }]
          : marker && this.testFile
          ? [{ id: `F${index + 1}`, kind: "partial", severity: "medium", basis: "spec", confidence: 0.9, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: TEST_FILE, symbol: index ? "nestedRunsInBothModes" : null, evidenceIds, claim: `The tests leave nested delimiter run case-${marker} unchecked`, impact: "A regression would pass", suggestedFix: `Assert case-${marker}`, repeatOf: index ? `F${index}` : null }]
          : marker
          ? [{ id: `F${index + 1}`, kind: "correctness", severity: "high", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol: this.family ? FAMILY_SYMBOLS[index] : index % 2 ? "Inline.findDelimitedInline()" : "findDelimitedInline", evidenceIds, claim: `Nested delimiter run case-${marker} is parsed flat`, impact: "Wrong emphasis", suggestedFix: `Handle case-${marker}`, repro: reproFor(marker), ...(this.family ? { repeatOf: null, family: index === 1 ? "Decimal context precision" : "decimal-context-precision" } : { repeatOf: index ? `F${index}` : null }) }]
          : [];
        // R68 F1 was a missing finding without a repro: a repro the corrective leaves failing
        // would block it at submit, before any review saw the repeat.
        if (this.emptyFirst) for (const finding of findings) delete (finding as { repro?: Repro }).repro;
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

async function drive(options: { policy?: Partial<RunPolicy>; quality?: { chainRewrite: "on" | "off"; chainProbe?: "on" | "off" }; breakFirstRewrite?: boolean; family?: boolean; testFile?: boolean; crossFile?: boolean; sites?: boolean; noSites?: boolean; members?: readonly string[]; batteryOnly?: boolean; probe?: string[]; container?: boolean; emptyFirst?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "baked-finding-chain-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ChainExecutor(root);
  executor.breakFirstRewrite = options.breakFirstRewrite ?? false;
  executor.family = options.family ?? false;
  executor.testFile = options.testFile ?? false;
  executor.crossFile = options.crossFile ?? false;
  executor.sites = options.sites ?? false;
  executor.noSites = options.noSites ?? false;
  executor.members = options.members ?? MEMBERS;
  executor.batteryOnly = options.batteryOnly ?? false;
  executor.probe = options.probe ?? [];
  executor.container = options.container ?? false;
  executor.emptyFirst = options.emptyFirst ?? false;
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
    expect(replayed?.findingChains.filter((b) => b.kind !== "crash").map((b) => [b.kind, b.recorded, b.replayed])).toEqual([["rewrite", "rewrite", "rewrite"], ["battery", "pass", "pass"]]);
    // Each battery case records its output tail and crash decision in shadow (#2136): none crashed.
    expect(replayed?.findingChains.filter((b) => b.kind === "crash").every((b) => b.recorded === "pass" && b.replayed === "pass")).toBe(true);
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

// R62 md-site again (#1969): the class has four members, and the rewrite makes only the cases it is
// shown pass. Without the probe the third member is found by one more review round and the chain
// rewrites again; with it, one probe call finds members c and d before the rewrite starts.
describe("scenario: R62 md-site, a sibling probe at the second link of a chain (#1969)", () => {
  const FOUR = ["a", "b", "c", "d"] as const;

  test("with chainProbe on, the probe's failing cases join the rewrite's battery and no third finding round comes", async () => {
    const { root, runId, done, executor, service, artifacts } = await drive({ quality: { chainRewrite: "on", chainProbe: "on" }, members: FOUR, batteryOnly: true, probe: ["c", "d", "pass"] });
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).policy_json).toContain('"chainProbe":"on"');
    const [patch, rewrite, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect(patch?.findingIds).toEqual(["F1"]);
    expect(rewrite?.findingIds).toEqual(["F2"]);
    // One probe call, before the rewrite's attempt.
    const calls = executor.calls.map((c) => c.output);
    expect(calls.filter((c) => c === "chain-family")).toHaveLength(1);
    expect(executor.calls.findIndex((c) => c.output === "chain-family")).toBeLessThan(executor.calls.findIndex((c) => c.taskId === rewrite?.taskId));
    const markers = rewrite?.battery?.cases.map((c) => c.command.match(/case-(\w)/)?.[1]);
    expect(markers).toEqual(["a", "b", "c", "d"]);
    expect(rewrite?.battery?.cases.slice(2).map((c) => [c.expected, c.actual])).toEqual([["nested", "flat"], ["nested", "flat"]]);
    expect(readFileSync(join(root, "inline.txt"), "utf8")).toContain("case-d");
    // Two finding rounds and the closing one: the probe found c and d, not the review.
    expect(calls.filter((c) => c === "convergence")).toHaveLength(3);
    const [family, ...others] = artifacts("chains/family/") as unknown as FamilyRecord[];
    expect(others).toEqual([]);
    expect(family).toMatchObject({ taskId: rewrite?.taskId, findingId: "F2", symbol: "findDelimitedInline", shown: ["F1", "F2"] });
    // The case the battery already held is not run again.
    expect(family?.cases.map((c) => [c.status, c.decision])).toEqual([["refuted", "join"], ["refuted", "join"], ["reproduced", "skip"]]);
    const joined = service.store.findings(runId).filter((f) => f.id.startsWith("F2-family-"));
    expect(joined.map((f) => [f.id, JSON.parse(f.body_json).repeatOf, f.repair_task_id])).toEqual([["F2-family-1", "F2", rewrite?.taskId], ["F2-family-2", "F2", rewrite?.taskId]]);
    // The pre-review battery holds the probed members too.
    const batteries = artifacts("chains/battery/");
    expect((batteries[0]?.cases as unknown[]).length).toBe(4);

    // The probe's decisions replay from the bench trace.
    const dir = mkdtempSync(join(tmpdir(), "finding-chain-probe-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.findingChains.filter((b) => b.kind === "family").map((b) => [b.recorded, b.replayed])).toEqual([["join", "join"], ["join", "join"], ["skip", "skip"]]);
    expect(replayed?.newChainDecisions).toBe(0);
    expect(replayTrace(out, { familyRule: () => "skip" }).runs.find((r) => r.runId === runId)?.newChainDecisions).toBe(2);
  }, 120_000);

  test("with chainProbe off, the next member is found by another review round", async () => {
    const { done, executor, artifacts } = await drive({ policy: { chainRewrite: "on" }, members: FOUR, batteryOnly: true, probe: ["c", "d"] });
    expect(done.status).toBe("completed");
    expect(executor.calls.filter((c) => c.output === "chain-family")).toEqual([]);
    expect(artifacts("chains/family/")).toEqual([]);
    expect(executor.corrections.map((c) => c.findingIds)).toEqual([["F1"], ["F2"], ["F3"], ["F4"]]);
    expect(executor.calls.filter((c) => c.output === "convergence").length).toBeGreaterThan(3);
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

describe("scenario: R67 ampwhy, a reviewer's repeat on a test file whose first finding has no symbol (#2098)", () => {
  // A repeat without a new repro is a contradiction stop; the `assume` rule grants the round R67 got.
  test("with chainRewrite on, the second finding is the second link of the chain and its corrective is the test sweep, not a rewrite", async () => {
    const { done, executor, artifacts } = await drive({ quality: { chainRewrite: "on" }, policy: { clarification: "assume" }, testFile: true, members: ["a", "b"] });
    expect(done.status).toBe("completed");
    const [patch, sweep, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect(patch?.findingIds).toEqual(["F1"]);
    expect(sweep?.findingIds).toEqual(["F2"]);
    expect(sweep?.title).not.toStartWith("Rewrite");
    expect(sweep?.description).toContain("Class sweep: the review shows the defect in one test file");
    expect(sweep?.description).toContain(`- ${TEST_FILE}`);
    expect(sweep?.description).not.toContain("This finding repeats F1");
    expect(sweep?.description).not.toContain("Do not patch this case");
    // No battery: a test-file finding has no repro, and the host runs none before the review.
    expect(sweep?.battery).toBeUndefined();
    expect(sweep?.saved?.battery).toBeUndefined();
    expect(artifacts("chains/battery/")).toEqual([]);
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.taskId, d.findingId, d.chain.map((f) => f.id), d.decision, d.corrective])).toEqual([[sweep?.taskId, "F2", ["F1", "F2"], "rewrite", "test-sweep"]]);
  }, 60000);

  test("with chainRewrite off, the chain is recorded as a patch and the corrective repeats the earlier fix", async () => {
    const { done, executor, artifacts } = await drive({ quality: { chainRewrite: "off" }, policy: { clarification: "assume" }, testFile: true, members: ["a", "b"] });
    expect(done.status).toBe("completed");
    expect(executor.corrections[1]?.description).toContain("This finding repeats F1");
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.length, d.decision, d.corrective])).toEqual([[2, "patch", undefined]]);
  }, 60000);
});

describe("scenario: R68 ewvet scanner, a reviewer's repeat from a class to its member (#2137)", () => {
  test("with chainRewrite on, the member finding linked to the class finding is the second link and rewrites against both cases", async () => {
    const { done, executor, service, runId, artifacts } = await drive({ quality: { chainRewrite: "on" }, container: true });
    expect(done.status).toBe("completed");
    const [patch, rewrite, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect(patch?.findingIds).toEqual(["F1"]);
    expect(rewrite?.findingIds).toEqual(["F2"]);
    expect(rewrite?.title).toStartWith("Rewrite IsEncodingToken:");
    expect(rewrite?.battery?.cases.map((c) => c.findingId)).toEqual(["F1", "F2"]);
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.taskId, d.chain.map((f) => f.id), d.symbols, d.decision])).toEqual([[rewrite?.taskId, ["F1", "F2"], ["Scanner", "IsEncodingToken"], "rewrite"]]);
    // Both correctives changed the file: no repeat without a change.
    expect(service.store.eventsOfType(runId, "decision.would_stop").filter((e) => e.type === "decision.would_stop" && e.payload.reason === "repeat_without_change")).toEqual([]);
  }, 60000);
});

describe("scenario: R68 ewvet scanner, a finding back after a corrective that changed no file (#2137)", () => {
  test("the repeat records the repeat_without_change would-stop with the corrective's empty change and the chain, and the run goes on", async () => {
    // The corrective's own required check passes on the unchanged files, so the host accepts its
    // empty result as implemented, as T010's was.
    const { done, executor, service, runId } = await drive({ quality: { chainRewrite: "on" }, policy: { clarification: "assume", checks: [{ ...check, scope: "task" }] }, emptyFirst: true, members: ["a"] });
    expect(done.status).toBe("completed");
    const empty = executor.corrections[0];
    expect(empty?.findingIds).toEqual(["F1"]);
    // Shadow: the repeat still gets its corrective.
    expect(executor.corrections.at(-1)?.findingIds).toEqual(["F1-repeat"]);
    expect(executor.corrections.map((c) => c.findingIds)).toEqual([["F1"], ["F1-repeat"]]);
    const stops = service.store
      .eventsOfType(runId, "decision.would_stop")
      .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "repeat_without_change" ? [e.payload] : []));
    expect(stops).toEqual([
      expect.objectContaining({
        mode: "shadow",
        key: `task-${empty?.taskId}`,
        inputs: { findingId: "F1-repeat", earlierId: "F1", taskId: empty?.taskId, changed: [], chain: ["F1", "F1-repeat"] },
      }),
    ]);
  }, 60000);
});

describe("scenario: R74 callmend cmd, one defect family on three spec files (#2334)", () => {
  // A repeat without a new repro is a contradiction stop; the `assume` rule grants the round R74 got.
  test("with chainRewrite on, the three findings form a chain of 3: the second corrective is the chain's rewrite and its sweep lists every file of the family", async () => {
    const { root, runId, done, executor, artifacts } = await drive({ quality: { chainRewrite: "on" }, policy: { clarification: "assume" }, crossFile: true });
    expect(done.status).toBe("completed");
    const [patch, second, third, ...rest] = executor.corrections;
    expect(rest).toEqual([]);
    expect([patch?.findingIds, second?.findingIds, third?.findingIds]).toEqual([["F1"], ["F1-2"], ["F1-3"]]);
    expect(patch?.description).not.toContain("Class sweep");
    // A rewrite of a test-file chain is the test sweep (#2098): it has no battery, since a
    // literal-input finding has no repro, and the host runs none before the review.
    for (const sweep of [second, third]) {
      expect(sweep?.description).toContain("Class sweep: the review shows the defect in one test file");
      expect(sweep?.description).not.toContain("This finding repeats");
      expect(sweep?.battery).toBeUndefined();
    }
    const listed = (c: Correction | undefined) => (c?.description.split("Test files to sweep")[1] ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    expect(listed(second)).toEqual([SPEC_FILES[0], SPEC_FILES[1]]);
    // The third file is in another directory: only the chain names the first two beside it.
    expect(listed(third)).toEqual([SPEC_FILES[0], SPEC_FILES[1], SPEC_FILES[2]]);
    expect(artifacts("chains/battery/")).toEqual([]);
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.taskId, d.findingId, d.chain.map((f) => f.id), d.length, d.family, d.files, d.decision, d.corrective])).toEqual([
      [second?.taskId, "F1-2", ["F1", "F1-2"], 2, "literal-test-inputs", [SPEC_FILES[0], SPEC_FILES[1]], "rewrite", "test-sweep"],
      [third?.taskId, "F1-3", ["F1", "F1-2", "F1-3"], 3, "literal-test-inputs", [...SPEC_FILES], "rewrite", "test-sweep"],
    ]);

    // The trace replays the chain as the run decided it.
    const dir = mkdtempSync(join(tmpdir(), "finding-cross-file-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    expect(replayTrace(out).runs.find((r) => r.runId === runId)?.newChainDecisions).toBe(0);
    const traced = openTrace(out);
    cleanups.push(traced.dispose);
    const escalation = replayChainEscalation(traced.store, runId);
    expect(escalation.steps.map((s) => [s.findingId, s.chain, s.decision, s.battery])).toEqual([["F1", ["F1"], "patch", []], ["F1-2", ["F1", "F1-2"], "rewrite", []], ["F1-3", ["F1", "F1-2", "F1-3"], "rewrite", []]]);
    expect(chainCosts(traced.store, runId).map((c) => [c.file, c.files, c.family, c.length, c.findings])).toEqual([[SPEC_FILES[0], [...SPEC_FILES], "literal-test-inputs", 3, ["F1", "F1-2", "F1-3"]]]);
  }, 120_000);

  test("with chainRewrite off, the chain is recorded as a patch and every corrective repeats the earlier fix", async () => {
    const { done, executor, artifacts } = await drive({ quality: { chainRewrite: "off" }, policy: { clarification: "assume" }, crossFile: true });
    expect(done.status).toBe("completed");
    expect(executor.corrections.map((c) => c.findingIds)).toEqual([["F1"], ["F1-2"], ["F1-3"]]);
    expect(executor.corrections[1]?.description).toContain("This finding repeats F1");
    expect(executor.corrections.some((c) => c.description.includes("Class sweep"))).toBe(false);
    const decisions = artifacts("chains/tasks/") as unknown as ChainRecord[];
    expect(decisions.map((d) => [d.findingId, d.length, d.decision, d.corrective])).toEqual([["F1-2", 2, "patch", undefined], ["F1-3", 3, "patch", undefined]]);
  }, 120_000);
});

describe("scenario: R74 callmend cmd, a family finding that states every site of its pattern (#2343)", () => {
  test("the corrective lists the two sites the host finds in code, drops the commented one, and no second literal-input round comes", async () => {
    const { root, runId, done, executor, artifacts } = await drive({ quality: { chainRewrite: "on" }, crossFile: true, sites: true });
    expect(done.status).toBe("completed");
    expect(executor.corrections.map((c) => c.findingIds)).toEqual([["F1"]]);
    const [only] = executor.corrections;
    const listed = (only?.description.split("Sites of this defect class")[1] ?? "").split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toEqual([`- ${SPEC_FILES[0]}:1: ${GENERATED}`, `- ${SPEC_FILES[1]}:1: ${GENERATED}`]);
    const [record, ...others] = artifacts("chains/sites/") as unknown as SitesRecord[];
    expect(others).toEqual([]);
    expect(record?.taskId).toBe(only?.taskId);
    expect(record?.sites.map((s) => [s.file, s.verdict])).toEqual([[SPEC_FILES[0], "kept"], [SPEC_FILES[1], "kept"], [SPEC_FILES[2], "not_code"]]);
    // The review after the corrective sees the sites its corrective was given.
    expect(executor.earlier.at(-1)).toEqual([expect.objectContaining({ id: "F1", family: "literal-test-inputs", sites: [{ file: SPEC_FILES[0], line: 1, text: GENERATED }, { file: SPEC_FILES[1], line: 1, text: GENERATED }] })]);

    // The trace keeps the sites and replays each check as the run decided it.
    const dir = mkdtempSync(join(tmpdir(), "finding-sites-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    expect(replayTrace(out).runs.find((r) => r.runId === runId)?.newChainDecisions).toBe(0);
    const traced = openTrace(out);
    cleanups.push(traced.dispose);
    expect(replayFindingChains(traced.store, runId).filter((b) => b.kind === "site").map((b) => [b.recorded, b.replayed])).toEqual([["kept", "kept"], ["kept", "kept"], ["not_code", "not_code"]]);
  }, 120_000);

  test("without sites, the corrective fixes the reported file and the next file takes another round", async () => {
    const { done, executor } = await drive({ quality: { chainRewrite: "on" }, crossFile: true, sites: true, policy: { clarification: "assume" }, noSites: true });
    expect(done.status).toBe("completed");
    expect(executor.corrections.map((c) => c.findingIds)).toEqual([["F1"], ["F2"]]);
  }, 120_000);
});

/**
 * A site in a comment of each comment syntax `MASK_SYNTAX` spells differently, beside the same
 * text in code: the host keeps the code site and drops the commented one (#2343).
 */
const COMMENTED_SITES: readonly [file: string, code: string, comment: string][] = [
  ["spec/a_spec.rb", 'x = "a" * 3', '# x = "a" * 3'],
  ["tests/test_a.py", 'x = "a" * 3', '# x = "a" * 3'],
  ["tests/test_b.py", 'x = "a" * 3', '"""\nx = "a" * 3\n"""'],
  ["src/a.test.ts", 'const x = "a".repeat(3);', '// const x = "a".repeat(3);'],
  ["spec/a_spec.lua", 'local x = string.rep("a", 3)', '-- local x = string.rep("a", 3)'],
  ["tests/testthat/test-a.R", 'x <- strrep("a", 3)', '# x <- strrep("a", 3)'],
  ["tests/ATest.php", '$x = str_repeat("a", 3);', '// $x = str_repeat("a", 3);'],
  ["tests/BTest.php", '$x = str_repeat("a", 3);', '# $x = str_repeat("a", 3);'],
];

describe("the host's check of a family's sites (#2343)", () => {
  const workspace = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "family-sites-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return root;
  };

  for (const [file, code, comment] of COMMENTED_SITES)
    test(`${file}: the site in code is kept and the one in a comment dropped`, () => {
      const root = workspace({ [file]: `${comment}\n${code}\n` });
      const commentLine = comment.split("\n").length === 1 ? 1 : 2;
      const codeLine = comment.split("\n").length + 1;
      const text = code.replace(/^(const|local) /, "").replace(/;$/, "");
      const checks = checkSites(root, [{ id: "F1", sites: [{ file, line: codeLine, text }, { file, line: commentLine, text }] }], () => true);
      expect(checks.map((c) => c.verdict)).toEqual(["kept", "kept"]);
      // The commented copy alone, with the code line out of reach, is not a site.
      const alone = workspace({ [file]: `${comment}\n\n\n\n\n\n${code}\n` });
      expect(checkSites(alone, [{ id: "F1", sites: [{ file, line: commentLine, text }] }], () => true).map((c) => c.verdict)).toEqual(["not_code"]);
    });

  test("a site inside a string, off its line, in a missing or outside file, or unwritable is not kept, and one place is listed once", () => {
    const root = workspace({ "spec/a_spec.rb": 'it "x * 3" do\n  expect(1).to eq(1)\nend\n\n\n\nx = "a" * 3\n' });
    const checks = checkSites(root, [{ id: "F1", sites: [
      { file: "spec/a_spec.rb", line: 1, text: "x * 3" },
      { file: "spec/a_spec.rb", line: 2, text: '"a" * 3' },
      { file: "spec/a_spec.rb", line: 7, text: '"a" * 3' },
      { file: "spec/missing_spec.rb", line: 1, text: "x" },
      { file: "../outside_spec.rb", line: 1, text: "x" },
      { file: "spec/a_spec.rb", line: 6, text: '"a" * 3' },
    ] }], () => true);
    expect(checks.map((c) => [c.line, c.verdict, c.foundLine])).toEqual([[1, "not_code", undefined], [2, "not_on_line", undefined], [7, "kept", 7], [1, "no_file", undefined], [1, "no_file", undefined], [6, "kept", 7]]);
    const refused = checkSites(root, [{ id: "F1", sites: [{ file: "spec/a_spec.rb", line: 7, text: '"a" * 3' }] }], () => false);
    expect(refused.map((c) => c.verdict)).toEqual(["unwritable"]);
    expect(keptSites(checks)).toEqual([{ file: "spec/a_spec.rb", line: 7, text: '"a" * 3' }]);
  });

  test("the trace export keeps a finding's sites as code", () => {
    const sites = [{ file: "spec/a_spec.rb", line: 7, text: '"a" * 3' }];
    expect(scrubTrace({ findings: [{ id: "F1", claim: "secret prose here", sites }] })).toEqual({ findings: [{ id: "F1", claim: expect.not.stringContaining("secret"), sites }] });
  });
});

describe("the chain key across files: one family on test files, or a reviewer's link (#2334)", () => {
  const finding = (id: string, file: string, family: string | null, repairTaskId: string | null, repeatOf: string | null = null, symbol: string | null = null): ChainFinding => ({ id, file, symbol, family, repeatOf, repairTaskId, claim: id, severity: "high", status: "resolved", requirementIds: [], criterionIds: [] });
  const chainOf = (findings: ChainFinding[], id: string) => {
    const all = new Map(findings.map((f) => [f.id, f]));
    return findingChain(all, all.get(id) as ChainFinding).map((f) => f.id);
  };

  // R74 callmend cmd 9a6ada47 as the review linked them: T015 corrected F1, T016 F1-2; the
  // stream_command_spec.rb findings between them name no family.
  const r74 = [finding("F1", "spec/cmd/stream_command_spec.rb", "literal-test-inputs", "T015"), finding("F1-2", "spec/cmd/check_command_spec.rb", "literal-test-inputs", "T016", "F1"), finding("f3b4831a", "spec/cmd/stream_command_spec.rb", null, "T017"), finding("F1-3", "spec/cmd/cli_spec.rb", "literal-test-inputs", null, "F1-2")];

  test("the R74 cmd findings are one chain: F1-2 is its second link and T016 a rewrite", () => {
    expect(chainOf(r74, "F1-2")).toEqual(["F1", "F1-2"]);
    expect(chainOf(r74, "F1-3")).toEqual(["F1", "F1-2", "F1-3"]);
    const all = new Map(r74.map((f) => [f.id, f]));
    const record = chainRecord("T016", all.get("F1-2") as ChainFinding, findingChain(all, all.get("F1-2") as ChainFinding), "on");
    expect([record.decision, record.corrective, record.files]).toEqual(["rewrite", "test-sweep", ["spec/cmd/stream_command_spec.rb", "spec/cmd/check_command_spec.rb"]]);
    // Without the reviewer's links, the family alone joins the test files.
    const unlinked = r74.map((f) => ({ ...f, repeatOf: null }));
    expect(chainOf(unlinked, "F1-3")).toEqual(["F1", "F1-2", "F1-3"]);
  });

  test("on source files only a reviewer's link joins two files, and only with one family", () => {
    expect(chainOf([finding("F1", "lib/a.rb", "utf8-byte-offsets", "T010"), finding("F2", "lib/b.rb", "utf8-byte-offsets", "T011")], "F2")).toEqual(["F2"]);
    expect(chainOf([finding("F1", "lib/a.rb", "utf8-byte-offsets", "T010"), finding("F2", "lib/b.rb", "utf8-byte-offsets", "T011", "F1")], "F2")).toEqual(["F1", "F2"]);
    expect(chainOf([finding("F1", "lib/a.rb", "utf8-byte-offsets", "T010"), finding("F2", "lib/b.rb", "decimal-context-precision", "T011", "F1")], "F2")).toEqual(["F2"]);
    expect(chainOf([finding("F1", "lib/a.rb", null, "T010"), finding("F2", "lib/b.rb", null, "T011", "F1")], "F2")).toEqual(["F2"]);
    // A test file and a source file: a reviewer's link with one family.
    expect(chainOf([finding("F1", "lib/a.rb", "utf8-byte-offsets", "T010"), finding("F2", "spec/a_spec.rb", "utf8-byte-offsets", "T011")], "F2")).toEqual(["F2"]);
    expect(chainOf([finding("F1", "lib/a.rb", "utf8-byte-offsets", "T010"), finding("F2", "spec/a_spec.rb", "utf8-byte-offsets", "T011", "F1")], "F2")).toEqual(["F1", "F2"]);
  });

  test("a symbol rewrite across files holds both cases in its battery and names every file", () => {
    const cases = [{ ...finding("F1", "lib/a.rb", "utf8-byte-offsets", "T010", null, "Reader#read"), repro: reproFor("a") }, { ...finding("F2", "lib/b.rb", "utf8-byte-offsets", "T011", "F1", "Writer#write"), repro: reproFor("b") }];
    const all = new Map(cases.map((f) => [f.id, f]));
    const chain = findingChain(all, all.get("F2") as ChainFinding);
    expect(chainMembers(all, chain).map((f) => f.id)).toEqual(["F1", "F2"]);
    const record = chainRecord("T012", all.get("F2") as ChainFinding, chain, "on");
    expect([record.decision, record.corrective, record.files, record.symbols]).toEqual(["rewrite", undefined, ["lib/a.rb", "lib/b.rb"], ["read", "write"]]);
    expect(rewriteStep("write", ["F1", "F2"], { name: "utf8-byte-offsets", file: "lib/b.rb", symbols: ["read", "write"], files: ["lib/a.rb", "lib/b.rb"] })).toContain("case 2 of the defect class utf8-byte-offsets in lib/a.rb, lib/b.rb (F1, F2, on read, write)");
    expect(rewriteStep("lib/b.rb", ["F1", "F2"], { name: "utf8-byte-offsets", file: "lib/b.rb", symbols: [], files: ["lib/a.rb", "lib/b.rb"] })).toContain("in lib/a.rb, lib/b.rb (F1, F2), each found");
  });

  /**
   * Each field of a reviewer's finding and its place in the chain key (AGENTS.md): a new field
   * says here whether it keys or links a chain, and the key's readers read it, before it ships.
   */
  const FINDING_FIELDS: Record<string, "key" | "link" | "battery" | "none"> = {
    id: "link",
    file: "key",
    symbol: "key",
    family: "key",
    repeatOf: "link",
    repro: "battery",
    requirementIds: "battery",
    criterionIds: "battery",
    severity: "battery",
    claim: "none",
    kind: "none",
    basis: "none",
    confidence: "none",
    noRepro: "none",
    evidenceIds: "none",
    impact: "none",
    suggestedFix: "none",
    quote: "none",
    // The family's sites (#2343) widen the corrective's input and writes, not the chain key.
    sites: "none",
  };

  test("every field of a reviewer's finding has its place in the chain key", () => {
    expect(Object.keys(ReviewSchema.shape.findings.element.shape).sort()).toEqual(Object.keys(FINDING_FIELDS).sort());
  });
});

/**
 * A container and a member of it in each supported language's qualified-name spelling (#2137). A
 * language added to `SUPPORTED_LANGUAGES` adds its row, and a new spelling joins `symbolPath`.
 */
const CONTAINER_MEMBER: Record<SupportedLanguage, readonly [container: string, member: string]> = {
  typescript: ["Parser", "Parser.parseInline()"],
  javascript: ["Parser", "Parser.prototype.parse"],
  python: ["Reader", "Reader.read"],
  go: ["Reader", "(*Reader).Read"],
  rust: ["Reader", "Reader::read"],
  java: ["Reader", "Reader.read(int)"],
  kotlin: ["Reader", "Reader.read"],
  scala: ["Reader", "Reader#read"],
  csharp: ["Scanner", "Scanner.IsEncodingToken"],
  c: ["struct reader", "reader->read"],
  cpp: ["Reader", "Reader::read() const"],
  ruby: ["Reader", "Reader#read"],
  php: ["Reader", "App\\Reader->read"],
  swift: ["Reader", "Reader.read(_:)"],
  lua: ["Reader", "Reader:read"],
  elixir: ["Reader", "Reader.read/1"],
  dart: ["Reader", "Reader.read"],
  zig: ["Reader", "Reader.read"],
  bash: ["reader", "reader::read"],
  ocaml: ["Reader", "Reader.read"],
  objc: ["Reader", "-[Reader read:]"],
  vue: ["Reader", "Reader.methods.read"],
  svelte: ["Reader", "Reader.read"],
  rescript: ["Reader", "Reader.read"],
  solidity: ["Vault", "Vault.withdraw"],
  sql: ["inventory", "inventory.stock_level"],
  powershell: ["Reader", "[Reader]::Read"],
  r: ["Reader", "Reader$read"],
};

describe("a reviewer's link between a class and its member joins in every supported language (#2137)", () => {
  const linked = (id: string, symbol: string, repeatOf: string | null): ChainFinding => ({ id, file: "src/reader", symbol, family: null, repeatOf, repairTaskId: repeatOf ? null : "T005", claim: id, severity: "high", status: "resolved", requirementIds: [], criterionIds: [] });

  test("the table has a row for every supported language", () => {
    expect(Object.keys(CONTAINER_MEMBER).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  for (const [language, [container, member]] of Object.entries(CONTAINER_MEMBER)) {
    test(`${language}: ${container} and ${member}`, () => {
      // The last names differ, so the chain key alone never joined them.
      expect(symbolKey(member)).not.toBe(symbolKey(container));
      expect(containsSymbol(container, member)).toBe(true);
      expect(containsSymbol(member, container)).toBe(true);
      for (const [first, second] of [[container, member], [member, container]] as const) {
        const all = new Map([linked("F1", first, null), linked("F2", second, "F1")].map((f) => [f.id, f]));
        expect(findingChain(all, all.get("F2") as ChainFinding).map((f) => f.id)).toEqual(["F1", "F2"]);
      }
    });
  }

  test("unrelated symbols, a name that only starts like another, and one symbol twice are no container", () => {
    expect(containsSymbol("Reader", "Writer.write")).toBe(false);
    expect(containsSymbol("Read", "Reader.read")).toBe(false);
    expect(containsSymbol("Reader.read", "Reader.read")).toBe(false);
    expect(containsSymbol(null, "Reader.read")).toBe(false);
    // A namespace before the container still joins.
    expect(containsSymbol("Scanner", "Ewvet.Scan.Scanner.IsEncodingToken")).toBe(true);
  });
});
