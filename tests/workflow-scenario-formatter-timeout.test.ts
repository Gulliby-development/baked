import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { expectRecovery } from "./helpers/workflow-remedies.js";

// Scenario of bench round 71 (#2240). evalpin json a77894d4: rustfmt never finished on a test file
// with a data literal nested 20 deep, so the checks stage's `cargo fmt --check` ran into its
// timeout, counted as inconclusive, and the run blocked `verification_failed` with no finding, no
// fixer run and no remedy; a resume ran the same check on the same snapshot into the same timeout.
// Here a stand-in cargo and rustfmt hang on any `.rs` file holding `DEEP`: T002's first attempt
// writes one, and its correction writes a flat one.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fake-cargo-"));
const fixes = join(bin, "fixes.log");
const slowMark = join(bin, "SLOW");
const savedPath = process.env.PATH;
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(bin, { recursive: true, force: true });
});
if (!IS_WIN) {
  // `cargo fmt --check` hangs while a file holds DEEP, `cargo fmt` logs that the fixer ran,
  // `cargo clippy` hangs while the SLOW mark exists (outside the workspace, which the run watches).
  writeFileSync(
    join(bin, "cargo"),
    `#!/bin/sh
case "$1" in
  fmt)
    if [ "$2" = "--check" ]; then
      if grep -rl DEEP --include='*.rs' . >/dev/null 2>&1; then exec sleep 30; fi
      exit 0
    fi
    echo fix >> '${fixes}'
    exit 0;;
  clippy)
    if [ -e '${slowMark}' ]; then exec sleep 30; fi
    exit 0;;
esac
exit 0
`,
  );
  // rustfmt on one file: the last argument.
  writeFileSync(
    join(bin, "rustfmt"),
    `#!/bin/sh
for a; do f=$a; done
if grep -q DEEP "$f"; then exec sleep 30; fi
exit 0
`,
  );
  chmodSync(join(bin, "cargo"), 0o755);
  chmodSync(join(bin, "rustfmt"), 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const DEEP = "#[test]\nfn twenty_nested_objects() {\n    let _ = 1; // DEEP\n}\n";
const FLAT = "#[test]\nfn twenty_nested_objects() {\n    let _ = 1;\n}\n";

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "JSON", problem: "No parser", outcome: "A parser", inScope: ["Parser"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Nesting up to 20 levels parses", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a document nested 20 deep", when: "it is parsed", then: "it is valid", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne parser.\n## Decisions\nDEC-001: FR-001 caps nesting.\n## Components\nsrc/lib.rs\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, path: string, dependsOn: string[]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [task("T001", "src/lib.rs", []), task("T002", "tests/json.rs", ["T001"])];
const fmt: Check = { id: "fmt", executable: "cargo", args: ["fmt", "--check"], cwd: ".", timeoutMs: 3000, required: true, scope: "feature", envNames: [], writes: [], fix: { executable: "cargo", args: ["fmt"] } };
const clippy: Check = { id: "clippy", executable: "cargo", args: ["clippy"], cwd: ".", timeoutMs: 3000, required: true, scope: "feature", envNames: [], writes: [] };
const CARGO = "[package]\nname = \"json\"\nversion = \"0.1.0\"\nedition = \"2024\"\n";

class ScriptedExecutor implements AgentExecutor {
  attempts: { id: string; origin: string; fix?: string }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/lib.rs"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const current = request.task;
        this.attempts.push({ id: current?.id ?? "", origin: current?.origin ?? "", fix: request.prompt });
        const writes = current?.writes.map((w) => w.path) ?? [];
        if (writes.includes("src/lib.rs")) {
          mkdirSync(join(this.root, "src"), { recursive: true });
          writeFileSync(join(this.root, "src/lib.rs"), "pub fn parse() {}\n");
        }
        if (writes.includes("tests/json.rs")) {
          mkdirSync(join(this.root, "tests"), { recursive: true });
          writeFileSync(join(this.root, "tests/json.rs"), current?.origin === "planned" ? DEEP : FLAT);
        }
        output = { schemaVersion: 1, taskId: current?.id, outcome: "implemented", summary: "Wrote files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The tests pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function approvedRun(policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-formatter-timeout-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "Cargo.toml"), CARGO);
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse JSON nested up to 20 levels", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  return { root, executor, service, runId: run.runId };
}

const checkRuns = (service: NativeWorkflowService, runId: string, id: string) =>
  service.store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith(`checks/${id}/`))
    .map((a) => JSON.parse(service.store.readArtifact(runId, a.id)) as { reason: string; timedOut: boolean; output: string });

describe.skipIf(IS_WIN)("scenario: evalpin json a77894d4, a formatter that never finishes on one file (#2240)", () => {
  test("the timeout is a finding naming the file, the fixer is not run on it, and a correction repairs it", async () => {
    writeFileSync(fixes, "");
    const { executor, service, runId } = await approvedRun({ ...defaultWorkflowPolicy, checks: [fmt] });
    const done = await service.drive(runId, new AbortController().signal);
    const errors = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.length ? service.store.readArtifact(runId, errors.at(-1)?.id ?? "") : "").toBe("");
    expect(done.status).toBe("completed");
    const slow = checkRuns(service, runId, "fmt").find((r) => r.timedOut);
    expect(slow?.reason).toBe("timeout_slow");
    expect(slow?.output).toContain("the formatter does not finish on tests/json.rs");
    // One correction of the file, which no fixer touched while it hung.
    const corrections = executor.attempts.filter((a) => a.origin !== "planned");
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.fix).toContain("tests/json.rs");
    expect(readFileSync(fixes, "utf8")).toBe("");
  }, 90000);

  test("a check that timed out twice on the same workspace says so and offers revise", async () => {
    const { service, runId } = await approvedRun({ ...defaultWorkflowPolicy, checks: [clippy] });
    writeFileSync(slowMark, "");
    const blocked = await service.drive(runId, new AbortController().signal);
    expect(blocked.status).toBe("blocked");
    const first = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(service.store.readArtifact(runId, first.at(-1)?.id ?? "")).toContain("Required check clippy is inconclusive");
    // A plain resume on the unchanged workspace runs into the same timeout, and the block says so.
    const current = await service.get(runId);
    await service.resume(runId, { commandId: newId(), expectedRevision: current.revision });
    const again = await service.drive(runId, new AbortController().signal);
    expect(again.status).toBe("blocked");
    const errors = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/"));
    const last = service.store.readArtifact(runId, errors.at(-1)?.id ?? "");
    expect(last).toContain("timed out twice on the same workspace");
    expectRecovery(last, stopRecovery(service.store, runId), "revise");
    expect(checkRuns(service, runId, "clippy").map((r) => r.reason)).toEqual(["timeout", "timeout"]);
    rmSync(slowMark);
  }, 90000);

  test("a check that passed earlier in the run and then times out is failed; a first timeout stays inconclusive", async () => {
    const { root, service, runId } = await approvedRun({ ...defaultWorkflowPolicy, checks: [clippy] });
    const attempt = service.store.attempts(runId)[0]?.id ?? "";
    const scope = new ProcessScope();
    const signal = new AbortController().signal;
    const runner = new CheckRunner(service.store, scope);
    const cold = { ...clippy, id: "clippy-cold" };
    writeFileSync(slowMark, "");
    expect((await runner.run(runId, attempt, cold, signal, root)).reason).toBe("timeout");
    rmSync(slowMark);
    expect((await runner.run(runId, attempt, clippy, signal, root)).status).toBe("passed");
    writeFileSync(slowMark, "");
    const slow = await runner.run(runId, attempt, clippy, signal, root);
    expect([slow.status, slow.reason]).toEqual(["failed", "timeout_slow"]);
    expect(slow.output).toContain("although it passed earlier in this run");
    rmSync(slowMark);
  }, 60000);
});
