import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NO_ENTRY_POINT_LINES, noEntryPoint, testsNotBuilt } from "../src/core/verification/convergence.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Smoke c-strbuf 2026-11-07 (runs 8704ae0f, 5abc522f) and 2026-11-11 trial 2 (44319e68), #2997.
// The seed Makefile links `src/*.c tests/*.c` into one test binary. The plan writes the sources,
// then the README, then the tests last. The README task's summary named `src/strbuf.c`, so the
// reported-defect path ran `make test` at once: with no test file the link failed for want of
// `main`, the failure became a finding on `src/strbuf.c`, and the repair (which cannot add a
// `main` from the sources or README) ended unfinished twice and the run stopped blocked.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "String buffer", problem: "No buffer", outcome: "A buffer", inScope: ["Create the buffer"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Globs match", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the tests run", then: "globs match", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA buffer and its tests.\n## Decisions\nDEC-001: FR-001 is tested last.\n## Components\nsrc/strbuf.c, README.md, tests/test_strbuf.c\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const GNU_LD = "cc -std=c11 -Wall -Wextra -Werror -O2 -Isrc -o build/tests src/strbuf.c\n/usr/bin/ld: /usr/lib/gcc/x86_64-linux-gnu/13/../../../x86_64-linux-gnu/Scrt1.o: in function `_start':\n(.text+0x1b): undefined reference to `main'\ncollect2: error: ld returned 1 exit status\nmake: *** [Makefile:11: build/tests] Error 1";
// `make test` on the seed: the link fails until tests/test_strbuf.c (its `main`) exists.
const makeTest = (failure: string): Check => ({ id: "make-test", executable: "bun", args: ["-e", `if (!(await Bun.file('tests/test_strbuf.c').exists())) { console.log(${JSON.stringify(failure)}); process.exit(2) } console.log('All 3 tests passed')`], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] });
const basePolicy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [makeTest(GNU_LD)] };
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(
    private root: string,
    private moduleSummary: string,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", "src/strbuf.c"), planned("T002", "README.md", ["T001"]), planned("T003", "tests/test_strbuf.c", ["T002"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        for (const write of task?.writes ?? []) {
          mkdirSync(dirname(join(this.root, write.path)), { recursive: true });
          writeFileSync(join(this.root, write.path), "# code\n");
        }
        const summary = task?.id === "T002" ? this.moduleSummary : `Created ${task?.writes[0]?.path}`;
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(moduleSummary: string, policy: RunPolicy = basePolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-strbuf-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, moduleSummary);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create the strbuf library with tests", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { service, runId: run.runId, done, executor };
}

const README_SUMMARY = "Wrote README.md documenting the API of src/strbuf.h and src/strbuf.c, with a usage example.";

const defects = (service: NativeWorkflowService, runId: string) => {
  const artifact = service.store.latestArtifact(runId, "tasks/defects/T002.json");
  return artifact ? (JSON.parse(service.store.readArtifact(runId, artifact.id)) as { checks: { status: string }[]; findings: string[] }) : null;
};

describe("scenario: smoke c-strbuf, a README that names the source before the tests exist (#2997)", () => {
  for (const [linker, failure] of [
    ["GNU ld", GNU_LD],
    ["Apple ld", 'Undefined symbols for architecture arm64:\n  "_main", referenced from:\n      <initial-undefines>\nld: symbol(s) not found for architecture arm64\nclang: error: linker command failed with exit code 1 (use -v to see invocation)\nmake: *** [build/tests] Error 1'],
    ["MSVC", "LINK : fatal error LNK1561: entry point must be defined\nNMAKE : fatal error U1077: 'link' : return code '0x6c1'"],
  ] as const)
    test(`${linker}: the test binary's missing main is no defect of the source, and the run completes`, async () => {
      const { service, runId, done, executor } = await runScenario(README_SUMMARY, { ...basePolicy, checks: [makeTest(failure)] });
      // On main: a finding on src/strbuf.c, a repair task that cannot add a main, and a blocked run.
      expect(done.status).toBe("completed");
      expect(service.store.run(runId).corrective_tasks).toBe(0);
      expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
      expect(defects(service, runId)).toMatchObject({ checks: [{ status: "no_tests" }], findings: [] });
    });
});

describe("NO_ENTRY_POINT_LINES (#2997)", () => {
  test("each linker's form of a missing main, and nothing else", () => {
    expect(NO_ENTRY_POINT_LINES.map((l) => l.tool)).toEqual(["GNU ld", "lld", "Apple ld", "MSVC"]);
    expect(noEntryPoint(GNU_LD)).toBe(true);
    expect(noEntryPoint("ld.lld: error: undefined symbol: main\n>>> referenced by start.S")).toBe(true);
    expect(noEntryPoint('Undefined symbols for architecture x86_64:\n  "_main", referenced from:\n     implicit entry/start for main executable')).toBe(true);
    expect(noEntryPoint('test.obj : error LNK2019: unresolved external symbol main referenced in function "int __cdecl invoke_main(void)"')).toBe(true);
    expect(noEntryPoint("(.text+0x20): undefined reference to `WinMain'")).toBe(true);
    // Another missing symbol is a defect of the code that calls it.
    expect(noEntryPoint("strbuf.c:(.text+0x5): undefined reference to `sb_grow'")).toBe(false);
    expect(noEntryPoint('Undefined symbols for architecture arm64:\n  "_sb_grow", referenced from:')).toBe(false);
  });

  test("a missing main the output charges to a test file of the plan is still a failure", () => {
    expect(testsNotBuilt(GNU_LD, ["tests/test_strbuf.c"])).toBe(true);
    expect(testsNotBuilt("tests/test_strbuf.c:(.text+0x1b): undefined reference to `main'", ["tests/test_strbuf.c"])).toBe(false);
    expect(testsNotBuilt("collected 0 items\n\n==== no tests ran in 0.01s ====", [])).toBe(true);
    expect(testsNotBuilt("FAILED tests/test_globs.py::test_star - AssertionError", [])).toBe(false);
  });
});
