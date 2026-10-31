import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { fileHash } from "../src/core/workflows/effects.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { recoveryOf } from "../src/core/workflows/remedies.js";
import { REPEAT_TASKS_DIR, type RepeatRecord } from "../src/core/workflows/repeated-failure.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 77, pairwick (#2437): the implement tasks failed one `scalafmt` check
// attempt after attempt, each ended "did not complete its implementation", the run blocked
// `invalid_output` and the resume ran the same task into the same failure; 121 failing runs,
// 143 attempts, 17.13M tokens, and no `repeats/` record, since no corrective was ever opened for
// the chain comparison (#1996) to see. Here every attempt edits Rules.scala, runs the check (an
// sbt-shaped formatter failure whose `elapsed time` line differs per run) and reports blocked.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Pairing rules", problem: "No rules", outcome: "Rules exist", inScope: ["Rules"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Rules exist", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the build", when: "it is checked", then: "the rules are formatted", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne Scala file.\n## Decisions\nDEC-001: FR-001 rules.\n## Components\nRules.scala\n## Data\nText\n## Verification\nscalafmt\n## Risks\nNone for fixture";
// What the formatter says depends on the file's first line; the attempt counter below it is the
// model's edit, which the formatter does not see. The elapsed time and cache counters change per run.
const script = [
  "const first = (await Bun.file('Rules.scala').text()).split('\\n')[0];",
  "if (first === 'formatted') process.exit(0);",
  "const n = Math.floor(Math.random() * 1000);",
  "console.log('[warn] Rules.scala isn\\'t formatted properly! (' + first + ')');",
  "console.log('[error] (Compile / scalafmtCheck) 1 files aren\\'t formatted properly');",
  "console.log('[error] elapsed time: ' + (n % 60) + ' s, cache ' + (n % 100) + '%, ' + n + ' disk cache hits, 3 onsite tasks');",
  "process.exit(1);",
].join("\n");
const scalafmt: Check = { id: "scalafmt", executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [scalafmt, { ...scalafmt, id: "suite", scope: "feature" }] };

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  service?: NativeWorkflowService;
  constructor(
    private root: string,
    /** The first line each implementation attempt writes, in order; the last one repeats. */
    private lines: string[],
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["Rules.scala"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement rules", description: "Write Rules.scala", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "Rules.scala", action: "create" }], readHints: [], checkIds: ["scalafmt"], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const index = this.implementations++;
        const root = request.root ?? this.root;
        const line = this.lines[Math.min(index, this.lines.length - 1)] ?? "";
        const store = this.service?.store;
        if (!store) throw new Error("No service");
        // Journaled as a model's edit is, so the resume finds no change outside the run.
        const file = join(root, "Rules.scala");
        const effect = store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: "Rules.scala", tool: "edit_file" }, fileHash(file), null);
        writeFileSync(file, `${line}\n// attempt ${index + 1}\n`);
        store.finishFileEffect(request.runId, effect, fileHash(file));
        const scope = new ProcessScope();
        try {
          await new CheckRunner(store, scope).run(request.runId, request.attemptId, scalafmt, request.signal ?? new AbortController().signal, root);
        } finally {
          await scope.stop();
        }
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "blocked", summary: "scalafmt keeps failing on Rules.scala", evidenceIds: [], unresolved: ["The fixer could not run, and scalafmt still reports Rules.scala"] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(lines: string[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-unfinished-repeat-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, lines);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "standard", prompt: "Implement the pairing rules", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const store = service.store;
  const records = store
    .artifacts(run.runId)
    .filter((a) => a.logical_path === `${REPEAT_TASKS_DIR}T001.json`)
    .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as RepeatRecord);
  const wouldStops = store
    .eventsOfType(run.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "repeated_failure" ? [e.payload] : []));
  const errors = store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
  const last = errors.at(-1);
  const message = last ? store.readArtifact(run.runId, last.id) : "";
  const advice = last ? store.latestArtifact(run.runId, `recovery/advice-${last.id}.json`) : null;
  return { done, executor, root, runId: run.runId, store, records, wouldStops, message, advice: advice ? recoveryOf(JSON.parse(store.readArtifact(run.runId, advice.id))) : undefined };
}

describe("scenario: R77 pairwick, a task that ends unfinished twice on the same failing check (#2437)", () => {
  test("the second unfinished end records the repeated_failure would-stop and its block names the repeat", async () => {
    const { done, executor, root, runId, store, records, wouldStops, message, advice } = await runScenario(["object Rules{def score=1}"]);
    // Shadow mode: the run blocks and resumes as before.
    expect(done).toMatchObject({ status: "blocked", reason: "invalid_output" });
    // The first attempt restarts once, the second blocks the run unfinished, the automatic resume
    // (`clarification: assume`) runs the task a third time into the same failure.
    expect(executor.implementations).toBe(3);
    expect(store.latestArtifact(runId, "unfinished/resume-1.json")).not.toBeNull();
    expect(records.map((r) => [r.end, r.previous, r.decision, r.ends])).toEqual([
      ["unfinished", null, "first", 1],
      ["unfinished", "T001", "repeat", 2],
    ]);
    expect(records[1]?.checks.map((c) => c.id)).toEqual(["scalafmt"]);
    expect(records[1]?.checks[0]?.text).toContain("elapsed time: <duration>");
    expect(records[1]?.hash).toBe(records[0]?.hash ?? "");
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({ mode: "shadow", key: "task-T001", inputs: { taskId: "T001", ends: 2, checks: ["scalafmt"], firstDifference: null } });
    expect(wouldStops[0]?.summary).toContain("T001 ended unfinished 2 times in a row with the same failing output of scalafmt");
    expect(message).toContain("Task T001 did not complete its implementation");
    expect(message).toContain("Task T001 ended unfinished 2 times in a row with the same failing output of scalafmt.");
    expect(advice?.summary).toContain("Task T001 ended unfinished 2 times in a row with the same failing output of scalafmt.");
    // The message says a resume repeats the failure, so no resume is offered; each remedy changes
    // an input, and the message names which (#2520, R82 tinyflate deflate 82f19908).
    expect(advice?.remedies.map((r) => r.action)).toEqual(["reroute", "revise", "replan", "cancel"]);
    expect(advice?.message).toContain("What must change is the input behind scalafmt");
    expect(records[1]?.remedies).toEqual(["reroute", "revise", "replan", "cancel"]);

    // The decision replays from the bench trace.
    const dir = mkdtempSync(join(tmpdir(), "unfinished-repeat-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    const tasks = replayed?.repeatedFailures.filter((b) => b.kind === undefined) ?? [];
    expect(tasks.map((b) => [b.taskId, b.previous, b.root, b.recorded, b.replayed])).toEqual([["T001", "T001", "task-T001", "repeat", "repeat"]]);
    // The block's remedies replay from the recorded ends (#2520).
    expect(tasks[0]?.remedies).toEqual({ recorded: ["reroute", "revise", "replan", "cancel"], replayed: ["reroute", "revise", "replan", "cancel"] });
    expect(replayed?.newRepeatStops).toBe(0);
    expect(readFileSync(join(root, "Rules.scala"), "utf8")).toContain("attempt");
  });

  test("an unfinished end whose failure changed records no would-stop", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `object Rules{def score=${i}}`);
    const { done, records, wouldStops, message, advice } = await runScenario(lines);
    expect(done).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(records.map((r) => [r.decision, r.ends])).toEqual([
      ["first", 1],
      ["progress", 1],
    ]);
    expect(records[1]?.firstDifference).toBeGreaterThan(0);
    expect(wouldStops).toEqual([]);
    expect(message).not.toContain("ended unfinished");
    expect(advice?.summary ?? "").not.toContain("ended unfinished");
  });
});
