import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { dataDir } from "../src/core/platform/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import {
  CASE_TEXT_MAX,
  CASES_PER_CLASS,
  CLASSES_PER_DOMAIN,
  type DefectAddition,
  DEFECT_CLASSES_FILE,
  defectAdditions,
  defectCase,
  defectClassesFor,
  defectDomain,
  domainsOf,
  GENERAL_DOMAIN,
  mergeDefectClasses,
  readDefectClasses,
} from "../src/core/workflows/defect-classes.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench rounds 55 to 62 (#1970). md-site repeated the emphasis-delimiter class every
// round (R55 T009 354k, R56 T009 277k, R57 T009 506k, R59 T010 346k, R62 T009 451k) because each
// run started with nothing. With `defectClasses: "on"` the first Markdown run's corrected family
// goes into the list in the BAKED data directory, a second Markdown run in a fresh workspace shows
// it to its planner and implementer as an example, and a run of another domain does not.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const LIST = () => join(dataDir(), DEFECT_CLASSES_FILE);
const reproFor = (marker: string): Repro => ({ executable: "bun", args: ["-e", `const t = await Bun.file('out.txt').text(); console.log(t.includes('case-${marker}') ? 'nested' : 'flat')`], expected: "nested", actual: "flat" });

describe("the defect class list (#1970)", () => {
  const add = (domain: string, family: string, command: string): DefectAddition => ({ domain, family, cases: [{ command, expected: "nested", actual: "flat" }] });

  test("classes of two runs merge: a known class counts another run and keeps its newest cases", () => {
    const first = mergeDefectClasses({}, [add("markdown", "nested-inline-delimiters", "a")], "2026-10-01T00:00:00Z");
    const second = mergeDefectClasses(first, [add("markdown", "nested-inline-delimiters", "b"), add("csv", "quoted-commas", "c")], "2026-10-02T00:00:00Z");
    expect(second.markdown).toEqual([{ family: "nested-inline-delimiters", runs: 2, seen: "2026-10-02T00:00:00Z", cases: [{ command: "a", expected: "nested", actual: "flat" }, { command: "b", expected: "nested", actual: "flat" }] }]);
    expect(second.csv?.map((c) => [c.family, c.runs])).toEqual([["quoted-commas", 1]]);
    // The first list is not changed in place.
    expect(first.markdown?.[0]?.runs).toBe(1);
  });

  test("each domain keeps its most recent classes and each class its newest cases", () => {
    let list = {};
    for (let i = 0; i < CLASSES_PER_DOMAIN + 3; i++)
      list = mergeDefectClasses(list, [add("markdown", `family-${i}`, `c${i}`)], `2026-10-${String(10 + i)}T00:00:00Z`);
    for (let i = 0; i < CASES_PER_CLASS + 2; i++)
      list = mergeDefectClasses(list, [add("markdown", "family-10", `again-${i}`)], "2026-10-30T00:00:00Z");
    const markdown = (list as ReturnType<typeof mergeDefectClasses>).markdown ?? [];
    expect(markdown).toHaveLength(CLASSES_PER_DOMAIN);
    expect(markdown[0]?.family).toBe("family-10");
    expect(markdown.map((c) => c.family)).not.toContain("family-0");
    expect(markdown[0]?.cases.map((c) => c.command)).toEqual(["again-2", "again-3", "again-4"]);
  });

  test("a finding is filed under the domains it names, else the run's; one without a family is left out", () => {
    const finding = { kind: "correctness", claim: "Nested emphasis is parsed flat", file: "src/inline.ts", symbol: "findDelimitedInline", repro: reproFor("a") };
    expect(defectAdditions([{ ...finding, family: "Nested inline delimiters" }], "Sum amounts").map((a) => [a.domain, a.family])).toEqual([["markdown", "nested-inline-delimiters"]]);
    expect(defectAdditions([{ ...finding, claim: "Wrong output", family: "off-by-one" }], "Render Markdown").map((a) => a.domain)).toEqual(["markdown"]);
    expect(defectAdditions([{ ...finding, family: null }], "Render Markdown")).toEqual([]);
    expect(defectAdditions([{ ...finding, kind: "missing", family: "x" }], "Render Markdown")).toEqual([]);
    expect(domainsOf("Sum two integers")).toEqual([]);
  });
});

// R68 pilot (#2140): md-site's `output-symlink-resolution` (an output directory below a symlink is
// written through, src/build.ts) names no domain word, so it was filed under all six domains the
// request named; and 8 of 9 stored commands were programs cut at 300 characters.
const symlinkProgram = `const t = await Bun.file('out.txt').text(); console.log(t.includes('case-a') ? 'nested' : 'flat') // output directory below a symlink ${"padding ".repeat(300)}`;
const symlinkRepro: Repro = { executable: "bun", args: ["-e", symlinkProgram], expected: "nested", actual: "flat" };
const symlinkFinding = { kind: "correctness", family: "output-symlink-resolution", claim: "An output directory below a symlink is written through", file: "src/build.ts", symbol: "writeOutput", repro: symlinkRepro };
const SITE_REQUEST = "Build a Markdown site from CSV and JSON files, with URLs, dates and a CLI";

describe("one domain per defect class, whole cases (#2140)", () => {
  test("a finding without a domain word is filed once, never under every run domain", () => {
    expect(domainsOf(SITE_REQUEST)).toHaveLength(6);
    expect(defectAdditions([symlinkFinding], SITE_REQUEST).map((a) => [a.domain, a.family])).toEqual([[GENERAL_DOMAIN, "output-symlink-resolution"]]);
    // A run that names one domain keeps the class there.
    expect(defectAdditions([symlinkFinding], "Render Markdown").map((a) => a.domain)).toEqual(["markdown"]);
  });

  test("the domain whose words occur most wins; a tie goes to a domain the run names", () => {
    const finding = { ...symlinkFinding, claim: "Markdown emphasis inside a JSON string is parsed flat by the Markdown renderer", repro: undefined };
    expect(defectDomain(finding, ["json"])).toBe("markdown");
    const tie = { ...finding, claim: "Markdown inside a JSON string is parsed flat" };
    expect(defectDomain(tie, [])).toBe("markdown");
    expect(defectDomain(tie, ["json", "csv"])).toBe("json");
    // The repro command counts too.
    expect(defectDomain({ ...symlinkFinding, repro: { ...symlinkRepro, args: ["-e", "console.log(new URL('a b', 'http://x'))"] } }, [])).toBe("url");
  });

  test("decimal words name arithmetic, not an app's subject", () => {
    expect(domainsOf("Report the expenses totals by month")).toEqual([]);
    expect(domainsOf("Round money amounts to two decimals")).toEqual(["decimal"]);
  });

  test("a long repro is summarized on one line with its values' ends, a shorter one kept whole", () => {
    const long = defectCase({ ...symlinkRepro, expected: "first line\nnested", actual: `${"log line\n".repeat(80)}flat` });
    expect(symlinkProgram.length).toBeGreaterThan(CASE_TEXT_MAX);
    expect(long.summarized).toBe(true);
    expect(long.command).toContain("summary of a");
    expect(long.command.length).toBeLessThan(300);
    expect(long.expected).toBe("first line\nnested");
    expect(long.actual.endsWith("flat")).toBe(true);
    const medium = { ...symlinkRepro, args: ["-e", symlinkProgram.slice(0, 900)] };
    const kept = defectCase(medium);
    expect(kept.command).toBe(`bun -e ${symlinkProgram.slice(0, 900)}`);
    expect(kept.summarized).toBeUndefined();
  });

  test("the general bucket is shown only to a run that names no domain", () => {
    rmSync(LIST(), { force: true });
    cleanups.push(() => rmSync(LIST(), { force: true }));
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(LIST(), JSON.stringify({ schemaVersion: 1, domains: { general: [{ family: "output-symlink-resolution", runs: 1, seen: "2026-10-01T00:00:00Z", cases: [] }] } }));
    expect(defectClassesFor(LIST(), "Sum two integers")?.domains.map((d) => d.domain)).toEqual([GENERAL_DOMAIN]);
    expect(defectClassesFor(LIST(), "Render Markdown")).toBeNull();
  });
});

const markdownSpec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Inline emphasis", problem: "No parser", outcome: "A parser", inScope: ["Parser"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Nested Markdown emphasis follows CommonMark", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "nested delimiter runs", when: "they are parsed", then: "emphasis follows the delimiter-run rules", method: "automated" }], dependencies: [] };
const otherSpec: Spec = { ...markdownSpec, title: "Integer sum", requirements: [{ ...markdownSpec.requirements[0], id: "FR-001", text: "The program prints the sum of two integers" }] as Spec["requirements"] };
const markdown = "# Plan\n## Context\nOne program.\n## Decisions\nDEC-001: FR-001 in out.txt.\n## Components\nout.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('out.txt').text(); if (!t.includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, maxConvergenceRounds: 3, checks: [check] };
const planned: Task = { id: "T001", title: "Write the program", description: "Write out.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "out.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };

class ClassExecutor implements AgentExecutor {
  shown: { output: string; origin?: string; defectClasses?: { domains: { domain: string; classes: { family: string; cases: { expected: string }[] }[] }[]; note: string } }[] = [];
  constructor(private root: string, private spec: Spec, private findOnce: boolean, private finding?: Record<string, unknown>) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; defectClasses?: ClassExecutor["shown"][number]["defectClasses"] } };
    this.shown.push({ output: request.profile.output, ...(request.task ? { origin: request.task.origin } : {}), ...(data.extra.defectClasses ? { defectClasses: data.extra.defectClasses } : {}) });
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const path = join(request.root ?? this.root, "out.txt");
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["out.txt"] }; break;
      case "spec": output = this.spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(this.spec), planHash: hashBytes(markdown), tasks: [planned] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        writeFileSync(path, request.task?.origin === "planned" ? "ready" : "ready case-a");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Changed the program", evidenceIds: [], unresolved: [] };
        break;
      case "review": output = pass; break;
      case "convergence": {
        const found = this.findOnce && !readFileSync(path, "utf8").includes("case-a");
        output = found
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Nested run parsed flat" }], findings: [{ id: "F1", kind: "correctness", severity: "high", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "out.txt", symbol: "findDelimitedInline", family: "nested-inline-delimiters", repeatOf: null, evidenceIds, claim: "Nested delimiter run case-a is parsed flat", impact: "Wrong emphasis", suggestedFix: "Handle case-a", repro: reproFor("a"), ...this.finding }] }
          : pass;
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(options: { spec: Spec; prompt: string; findOnce: boolean; quality?: "on" | "off"; finding?: Record<string, unknown> }) {
  const root = mkdtempSync(join(tmpdir(), "baked-defect-classes-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ClassExecutor(root, options.spec, options.findOnce, options.finding);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", quality: { defectClasses: options.quality ?? "on" }, workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: options.prompt, ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { done, executor, service, runId: started.runId };
}

describe("scenario: md-site R55 to R62, a defect class every round (#1970)", () => {
  test("a second run of the domain shows its planner and implementer the class; another domain does not", async () => {
    rmSync(LIST(), { force: true });
    cleanups.push(() => rmSync(LIST(), { force: true }));
    const first = await run({ spec: markdownSpec, prompt: "Parse nested Markdown emphasis", findOnce: true });
    expect(first.done.status).toBe("completed");
    expect(first.service.store.run(first.runId).policy_json).toContain('"defectClasses":"on"');
    // The first run had no list to read.
    expect(first.executor.shown.filter((s) => s.defectClasses)).toEqual([]);
    const list = readDefectClasses(LIST());
    expect(list.markdown?.map((c) => [c.family, c.runs, c.cases.map((k) => [k.expected, k.actual])])).toEqual([["nested-inline-delimiters", 1, [["nested", "flat"]]]]);
    expect(first.service.store.latestArtifact(first.runId, "learning/defect-classes.json")).toBeTruthy();

    const second = await run({ spec: markdownSpec, prompt: "Render Markdown inline emphasis", findOnce: false });
    expect(second.done.status).toBe("completed");
    const shown = second.executor.shown.filter((s) => s.defectClasses);
    expect(shown.map((s) => [s.output, s.origin ?? null])).toEqual([["plan", null], ["implementation", "planned"]]);
    const classes = shown[0]?.defectClasses;
    expect(classes?.domains.map((d) => [d.domain, d.classes.map((c) => c.family)])).toEqual([["markdown", ["nested-inline-delimiters"]]]);
    expect(classes?.domains[0]?.classes[0]?.cases).toHaveLength(1);
    expect(classes?.note).toContain("never requirements");
    // The planned implementer's attempt-context records what it was shown (#2140); the first
    // run's records that it was shown nothing.
    const savedContexts = (r: Awaited<ReturnType<typeof run>>) =>
      r.service.store.artifacts(r.runId).filter((a) => a.kind === "attempt-context").map((a) => JSON.parse(r.service.store.readArtifact(r.runId, a.id)) as { taskId: string; defectClasses?: unknown });
    expect(savedContexts(second).find((c) => c.taskId === "T001")?.defectClasses).toEqual(shown[1]?.defectClasses);
    expect(savedContexts(first).find((c) => c.taskId === "T001")?.defectClasses).toBeNull();
    // A run that corrects nothing adds nothing.
    expect(readDefectClasses(LIST()).markdown?.[0]?.runs).toBe(1);

    const other = await run({ spec: otherSpec, prompt: "Sum two integers", findOnce: false });
    expect(other.done.status).toBe("completed");
    expect(other.executor.shown.filter((s) => s.defectClasses)).toEqual([]);
  }, 180_000);

  test("R68 md-site: a class whose finding names no domain is filed once and its long repro is not cut (#2140)", async () => {
    rmSync(LIST(), { force: true });
    cleanups.push(() => rmSync(LIST(), { force: true }));
    const siteSpec: Spec = { ...markdownSpec, requirements: [{ ...markdownSpec.requirements[0], id: "FR-001", text: "Markdown pages render from CSV and JSON files and keep their URLs and dates; CLI flags pick the output directory" }] as Spec["requirements"] };
    const site = await run({ spec: siteSpec, prompt: "Render Markdown pages", findOnce: true, finding: { family: "output-symlink-resolution", claim: "An output directory below a symlink is written through", file: "out.txt", symbol: "writeOutput", repro: symlinkRepro } });
    expect(site.done.status).toBe("completed");
    const list = readDefectClasses(LIST());
    const filed = Object.entries(list).flatMap(([domain, classes]) => classes.map((c) => [domain, c.family]));
    expect(filed).toEqual([[GENERAL_DOMAIN, "output-symlink-resolution"]]);
    const stored = list[GENERAL_DOMAIN]?.[0]?.cases[0];
    expect(stored?.summarized).toBe(true);
    expect(stored?.command.endsWith("…")).toBe(false);
    // A later run that names no domain sees it; a Markdown run does not.
    const plain = await run({ spec: otherSpec, prompt: "Sum two integers", findOnce: false });
    expect(plain.executor.shown.filter((s) => s.defectClasses).map((s) => s.defectClasses?.domains.map((d) => d.domain))).toEqual([[GENERAL_DOMAIN], [GENERAL_DOMAIN]]);
    const md = await run({ spec: markdownSpec, prompt: "Render Markdown inline emphasis", findOnce: false });
    expect(md.executor.shown.filter((s) => s.defectClasses)).toEqual([]);
  }, 180_000);

  test("with defectClasses off the list is neither written nor read", async () => {
    rmSync(LIST(), { force: true });
    cleanups.push(() => rmSync(LIST(), { force: true }));
    const off = await run({ spec: markdownSpec, prompt: "Parse nested Markdown emphasis", findOnce: true, quality: "off" });
    expect(off.done.status).toBe("completed");
    expect(existsSync(LIST())).toBe(false);
    writeFileSync(LIST(), JSON.stringify({ schemaVersion: 1, domains: { markdown: [{ family: "nested-inline-delimiters", runs: 1, seen: "2026-10-01T00:00:00Z", cases: [] }] } }));
    const again = await run({ spec: markdownSpec, prompt: "Parse nested Markdown emphasis", findOnce: false, quality: "off" });
    expect(again.executor.shown.filter((s) => s.defectClasses)).toEqual([]);
  }, 180_000);
});
