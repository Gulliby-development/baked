import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { robustnessShapes, sweepEntryPoints } from "../src/core/verification/class-sweep.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 24, cfgtrace a657dc4d (#1160). The reviewer reports one robustness class
// one site at a time: a 5,000-digit integer crashes `run()` in the CLI, and once that is repaired a
// 1,500-segment key crashes the format parser. Each corrective repaired the site it was given, so
// the class took one review round per site until the round budget stopped the run. With
// `classSweep` the first corrective is told to run the battery of input shapes against every
// planned source file next to the reported one, may write them, and repairs the class at once.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const CLI = "cfgtrace/cli.py";
const FORMATS = "cfgtrace/formats.py";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Config tracer", problem: "Layered config is opaque", outcome: "Bad input is rejected with an error", inScope: ["Trace config layers"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Malformed input is rejected with a documented error", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "malformed input", when: "it is loaded", then: "a documented error is reported", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA CLI and its parsers.\n## Decisions\nDEC-001: FR-001 in both modules.\n## Components\ncfgtrace/cli.py, cfgtrace/formats.py\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned = (id: string, path: string): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

/** Prints the documented error once the file is robust, else the crash the reviewer saw. */
const probe = (path: string, actual: string) => ({ executable: "bun", args: ["-e", `console.log((await Bun.file('${path}').text()).includes('robust') ? 'E107' : ${JSON.stringify(actual)})`], expected: "E107", actual });

// The CLI calls the format parser, so the parser shares the CLI's input path (#1226).
const SOURCES: Record<string, string> = { [CLI]: "fragile\nfrom cfgtrace.formats import load\n", [FORMATS]: "fragile\n" };

class ScriptedExecutor implements AgentExecutor {
  reviews = 0;
  corrections: Task[] = [];
  constructor(private root: string, private others: string[] = []) {}
  private fragile(path: string): boolean {
    return readFileSync(join(this.root, path), "utf8").includes("fragile");
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: [CLI] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", CLI), planned("T002", FORMATS), ...this.others.map((path, i) => planned(`T${String(i + 3).padStart(3, "0")}`, path))] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        if (task.origin === "planned") {
          mkdirSync(join(this.root, "cfgtrace"), { recursive: true });
          const path = task.writes[0]?.path ?? "";
          writeFileSync(join(this.root, path), SOURCES[path] ?? "VERSION = 1\n");
        } else {
          // A corrective repairs the site its finding names, and with a class sweep every entry
          // point the host lists, as long as the task may write it.
          this.corrections.push(task);
          const sites = task.description.includes("Class sweep") ? [CLI, FORMATS] : [task.description.includes("run()") ? CLI : FORMATS];
          for (const path of sites) if (task.writes.some((w) => w.path === path)) writeFileSync(join(this.root, path), "robust\n");
        }
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        this.reviews++;
        const finding = this.fragile(CLI)
          ? { file: CLI, claim: "A 5,000-digit integer makes run() raise ValueError", actual: "ValueError: Exceeds the limit (4300) for integer string conversion" }
          : this.fragile(FORMATS)
            ? { file: FORMATS, claim: "A 1,500-segment TOML key crashes the format parser", actual: "RecursionError: maximum recursion depth exceeded" }
            : null;
        output = finding
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [], findings: [{ id: "F001", kind: "correctness", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: finding.file, symbol: null, evidenceIds: evidence, claim: finding.claim, impact: "Malformed input crashes instead of reporting the documented error", suggestedFix: "Reject the input with the documented error", repro: probe(finding.file, finding.actual) }] }
          : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] };
        break;
      }
      case "refutation": output = { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds: evidence, explanation: "It crashes" }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(classSweep: boolean, others: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "baked-cfgtrace-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 1, checks: [tests], ...(classSweep ? { classSweep } : {}) };
  const executor = new ScriptedExecutor(root, others);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Trace config layers", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { done, row: service.store.run(run.runId), executor, root };
}

describe("scenario: cfgtrace a657dc4d, one robustness class found one site per review round (#1160)", () => {
  test("with classSweep the first corrective sweeps every entry point and the run completes", async () => {
    const { done, row, executor, root } = await runScenario(true);
    expect(done.status).toBe("completed");
    expect(row.review_rounds).toBe(1);
    expect(executor.corrections).toHaveLength(1);
    const [sweep] = executor.corrections;
    expect(sweep?.description).toContain("Class sweep");
    expect(sweep?.description).toContain("- huge numbers (reported, every entry point)");
    expect(sweep?.description).toContain(`- ${FORMATS}`);
    expect(sweep?.writes.map((w) => w.path).sort()).toEqual([CLI, FORMATS]);
    expect(readFileSync(join(root, FORMATS), "utf8")).toBe("robust\n");
  }, 60000);

  // cfgtrace eff0ebe7 (bench round 27): the sweep listed 12 planned source files against the whole
  // battery, about 60 probes for one attempt, and its corrective cost 3.96M tokens over three
  // attempts. Modules the reported file does not import and no criterion names are not swept, and
  // the shapes not reported are probed only where the defect was found.
  test("the sweep lists only the entry points tied to the reported file (#1226)", async () => {
    const others = ["cfgtrace/report.py", "cfgtrace/colors.py", "cfgtrace/version.py", "cfgtrace/paths.py", "cfgtrace/env.py", "cfgtrace/diff.py"];
    const { done, executor } = await runScenario(true, others);
    expect(done.status).toBe("completed");
    const [sweep] = executor.corrections;
    expect(sweep?.description).toContain(`- ${CLI}\n- ${FORMATS}`);
    for (const path of others) expect(sweep?.description).not.toContain(`- ${path}`);
    expect(sweep?.description).toContain("- huge numbers (reported, every entry point)");
    expect(sweep?.description).toContain(`- deep nesting (only ${CLI})`);
    expect(sweep?.writes.map((w) => w.path).sort()).toEqual([CLI, FORMATS]);
  }, 60000);

  test("without it each corrective repairs one site and the round budget stops the run", async () => {
    const { done, executor } = await runScenario(false);
    expect(done.status).toBe("blocked");
    expect(executor.corrections[0]?.description).not.toContain("Class sweep");
    // The review's corrective is still told to look next to the reported case (#943).
    expect(executor.corrections[0]?.description).toContain("sibling code paths");
  }, 60000);

  test("robustness shapes come from the claim, the impact and the reproduction", () => {
    const finding = (claim: string, actual = "") => ({ claim, impact: "", repro: actual ? { executable: "python", args: [], expected: "E107", actual } : undefined });
    expect(robustnessShapes(finding("500 chained references raise RecursionError"))).toEqual(["deep nesting"]);
    expect(robustnessShapes(finding("run() crashes", "ValueError: Exceeds the limit (4300) for integer string conversion"))).toEqual(["huge numbers"]);
    expect(robustnessShapes(finding("A 1,500-segment key raises RecursionError"))).toEqual(["deep nesting", "long input"]);
    expect(robustnessShapes(finding("The --help text names the wrong flag"))).toEqual([]);
  });

  test("entry points are the planned source files next to the reported one, without tests", () => {
    const task = (id: string, paths: string[], profileId = "implementer"): Task => ({ ...planned(id, paths[0] ?? ""), profileId, writes: paths.map((path) => ({ path, action: "create" as const })) });
    const root = { tasks: [task("T001", [CLI, "cfgtrace/__init__.py"]), task("T002", [FORMATS, "README.md"]), task("T003", ["tests/test_cli.py"], "tester"), task("T004", ["tools/gen.py"])] };
    expect(sweepEntryPoints([{ file: FORMATS }], root, "implementer", root.tasks[1] as Task)).toEqual([FORMATS, CLI, "cfgtrace/__init__.py"]);
    expect(sweepEntryPoints([{ file: null }], root, "implementer", root.tasks[0] as Task)).toEqual([CLI, "cfgtrace/__init__.py"]);
  });
});
