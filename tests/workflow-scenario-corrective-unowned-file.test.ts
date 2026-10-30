import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { evidencePaths, findingOrigin, hostDecision, SCOPE_EDITS_DIR, type ScopeEdit, type ScopeEvidence, type ScopeRecord, scopeRecord, scopeRecords, stackFrames, unownedBlockAdvice, unownedRemedies, unownedRule } from "../src/core/workflows/corrective-scope.js";
import { recoveryOf } from "../src/core/workflows/remedies.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { InitiativeStore } from "../src/core/workflows/initiatives/store.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest, RuntimeState } from "../src/core/workflows/types.js";

// Bench round 68, url-shortener 67c90258 (#2133). T001 wrote src/storage.ts and T002 the handler.
// The edge probe of T002 printed the wrong value for two legal inputs, and the findings named
// src/handler.ts, so the corrective T008 could write the handler and the server only. The defect
// was in T001's storage.ts (prefixed SQLite parameter keys): T008's session ended `blocked` with
// `unresolved: ["src/storage.ts: change named SQLite parameter bindings ..."]`, the host restarted
// it, then threw OUTPUT_INVALID "Task T008 did not complete its implementation", and every resume
// repeated it: 1.09M tokens in 6 attempts, and the test tasks never started. Here the same shape:
// the host records the owner (shadow, the default) and, enforced, opens T001's correction, lets
// the corrective wait for it and runs the test task.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Shortener", problem: "No links", outcome: "Links resolve", inScope: ["Links"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Links are stored", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "A stored link resolves", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a link", when: "it is stored", then: "storage prints ok", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "a stored link", when: "its code is requested", then: "the handler prints ok", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nStorage, a handler and its tests.\n## Decisions\nDEC-001: FR-001 in storage and handler.\n## Components\nsrc/storage.ts, src/handler.ts\n## Data\nSQLite\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('src/storage.ts').text(); if (!t.includes('export')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned = (id: string, path: string, dependsOn: string[] = [], n = 1): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: [`FR-00${n}`], criterionIds: [`AC-00${n}`], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const PLAN = [planned("T001", "src/storage.ts"), planned("T002", "src/handler.ts", ["T001"], 2), planned("T003", "tests/handler.test.ts", ["T002"], 2)];
// The handler resolves a link once the file with the defect binds unprefixed keys; the probe sees
// the failure only as the value the handler prints, with no frame that names that file. The defect
// sits in T001's storage.ts (route), in a project file no task writes inside the approved paths
// (widen), in an upstream feature's file (park) or in a file nothing in the run may change (refuse).
const resolves = (defect: string, frame = false) => ({ executable: "bun", args: ["-e", `const t = await Bun.file('${defect}').text(); if (!t.includes('unprefixed')) { ${frame ? `console.log('Error: Missing parameter code\\n    at bind (' + process.cwd() + '/${defect}:1:40)\\n    at handle (' + process.cwd() + '/src/handler.ts:1:45)'); ` : ""}console.log('Missing parameter code') } else console.log('ok')`], expected: "ok", criterionId: "AC-002" });
const unresolved = (defect: string) => `${defect}: change named SQLite parameter bindings from prefixed keys such as $code to unprefixed keys such as code`;
const UNRESOLVED_STORAGE = "src/storage.ts: change named SQLite parameter bindings from prefixed keys such as $code to unprefixed keys such as code";
const PREFIXED = "export const bind = (code: string) => ({ $code: code }); // prefixed\n";
const FIXED = "export const bind = (code: string) => ({ code }); // unprefixed\n";

class ShortenerExecutor implements AgentExecutor {
  calls: { output: string; taskId?: string; origin?: string; writes?: string[] }[] = [];
  constructor(private workspace: string, private defect: string, private frame = false) {}
  async execute(request: ExecutionRequest) {
    const task = request.task as Task | undefined;
    this.calls.push({ output: request.profile.output, ...(task ? { taskId: task.id, origin: task.origin, writes: task.writes.map((w) => w.path) } : {}) });
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[]; task?: { id: string } } };
    const root = request.root ?? this.workspace;
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const read = (path: string) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return "";
      }
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/storage.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: PLAN } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "edge-cases":
        // The probe of T002 finds the defect; the probe of T001 tries a case the storage gets right.
        output = { schemaVersion: 1, cases: data.extra.task?.id === "T002" ? [resolves(this.defect, this.frame)] : [{ executable: "bun", args: ["-e", "console.log('ok')"], expected: "ok", criterionId: "AC-001" }], rationale: "Codes at the edge" };
        break;
      case "implementation": {
        if (task?.id === "T001") write("src/storage.ts", PREFIXED);
        else if (task?.id === "T002") write("src/handler.ts", "export const handle = (code: string) => bind(code);\n");
        else if (task?.id === "T003") write("tests/handler.test.ts", "// handler tests\n");
        else if (task?.writes.some((w) => w.path === this.defect)) {
          write(this.defect, FIXED);
          if (task.writes.some((w) => w.path === "src/handler.ts")) write("src/handler.ts", "export const handle = (code: string) => bind(code) ?? null;\n");
        } else if (!read(this.defect).includes("unprefixed")) {
          // T002's corrective: the write-scope guard refuses the file, so the worker names it.
          output = { schemaVersion: 1, taskId: task?.id, outcome: "blocked", summary: "The handler is right; the defect is elsewhere", evidenceIds: [], unresolved: [unresolved(this.defect)] };
          break;
        } else write("src/handler.ts", "export const handle = (code: string) => bind(code) ?? null;\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: ["AC-001", "AC-002"].map((criterionId) => ({ criterionId, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

interface Options {
  enforce: boolean;
  worktree?: boolean;
  /** The file with the defect; a file the plan does not write is in the workspace before the run. */
  defect?: string;
  allowedPaths?: string[];
  /** Initiative boundaries put on the run before its tasks start (the upstream case). */
  bounds?: NonNullable<RuntimeState["initiativeBounds"]>;
  /** The probe's failing output carries a stack frame in the defect's file. */
  frame?: boolean;
  /** `stopModes.upstream_stale_file` (#2485); absent, its default. */
  staleFile?: "enforce";
  /** An initiative feature of `bounds` whose run is linked and completed (accepted, #2485). */
  closedUpstream?: string;
}

async function drive(options: Options) {
  const defect = options.defect ?? "src/storage.ts";
  const root = mkdtempSync(join(tmpdir(), "baked-unowned-file-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (defect !== "src/storage.ts") {
    mkdirSync(dirname(join(root, defect)), { recursive: true });
    writeFileSync(join(root, defect), PREFIXED);
  }
  if (options.worktree) {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    writeFileSync(join(root, "README.md"), "# Shortener\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
  }
  const policy: RunPolicy = {
    ...defaultWorkflowPolicy,
    maxRepairRounds: 3,
    maxConvergenceRounds: 3,
    checks: [check],
    ...(options.enforce ? { stopModes: { corrective_unowned_file: "enforce" as const, ...(options.staleFile ? { upstream_stale_file: options.staleFile } : {}) } } : {}),
    ...(options.allowedPaths ? { autoApproval: { renewal: false, limits: { maxTasks: 1, maxFiles: 1, allowedPaths: options.allowedPaths, allowDelete: false, allowNewDependencies: false as const, maxTotalTokens: 1000 } } } : {}),
  };
  const executor = new ShortenerExecutor(root, defect, options.frame);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", quality: { edgeProbe: "on" as const }, workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Shorten links", ownerLabel: "test", policy, ...(options.worktree ? { executionMode: "worktree" as const, maxConcurrentWriters: 2 } : {}) });
  await service.drive(started.runId, new AbortController().signal);
  if (options.bounds) {
    const state = service.store.state(started.runId);
    service.store.transaction(() => service.store.saveState(started.runId, { ...state, initiativeBounds: options.bounds ?? null }));
  }
  if (options.bounds && options.closedUpstream) {
    // The upstream feature's run is accepted and closed: a completed run linked to the initiative
    // beside this feature's run, as an initiative links them (#2485).
    const upstream = await service.start({ commandId: newId(), featureId: options.closedUpstream, workflowId: "sdd", prompt: "The upstream feature", ownerLabel: "test", policy });
    service.store.connection.run("UPDATE runs SET status='completed' WHERE id=?", [upstream.runId]);
    const initiatives = new InitiativeStore(service.store);
    initiatives.create({ id: "init-2485", title: "Layered CLI", prompt: "A layered CLI", status: "active", settings: { workflowId: "sdd", basePolicy: policy, budget: { maxTotalTokens: 4_000_000, maxAgentCalls: 400, maxActiveMs: 6_000_000 }, featureAutoApproval: null, model: null, ownerLabel: "test" } as never, decomposeRunId: null });
    initiatives.link("init-2485", options.closedUpstream, upstream.runId, 1, "a".repeat(64), "start");
    initiatives.link("init-2485", options.bounds.featureId, started.runId, 1, "b".repeat(64), "start");
  }
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const wouldStops = () => service.store.eventsOfType(started.runId, "decision.would_stop").map((e) => e.payload as { reason: string; key: string; summary: string; inputs: Record<string, unknown> });
  return { root, runId: started.runId, done, executor, service, wouldStops: wouldStops(), records: () => scopeRecords(service.store, started.runId), defect };
}

const implementations = (executor: ShortenerExecutor) => executor.calls.filter((c) => c.output === "implementation");

describe("scenario: R68 url-shortener, a corrective whose evidence names another task's file (#2133)", () => {
  test("shadow (the default): the blocked corrective records the owner T001 and the decision to route", async () => {
    const { root, runId, done, executor, wouldStops, records } = await drive({ enforce: false });
    // The run blocks as before: shadow changes nothing.
    expect(done.status).toBe("blocked");
    const corrective = implementations(executor).find((c) => c.origin !== "planned");
    expect(corrective?.writes).not.toContain("src/storage.ts");
    const unowned = wouldStops.filter((w) => w.reason === "corrective_unowned_file");
    expect(unowned.length).toBeGreaterThan(0);
    expect(unowned[0]?.summary).toContain("src/storage.ts");
    expect(unowned[0]?.summary).toContain("T001");
    const result = records().find((r) => r.at === "result");
    expect(result).toMatchObject({ taskId: corrective?.taskId, host: "route", origins: ["probe"] });
    expect(result?.unowned).toEqual([expect.objectContaining({ path: "src/storage.ts", owner: "T001", openWriters: [], feature: null, decision: "route" })]);
    // The record replays from the bench trace, and an older rule that refuses every path differs.
    const dir = mkdtempSync(join(tmpdir(), "unowned-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.newUnownedDecisions).toBe(0);
    expect(replayed?.correctiveScopes.some((b) => b.at === "result" && b.unownedRecorded === "route" && b.unownedReplayed === "route")).toBe(true);
    const old = replayTrace(out, { unownedRule: () => "refuse" }).runs.find((r) => r.runId === runId);
    expect(old?.newUnownedDecisions).toBeGreaterThan(0);
  }, 120_000);

  for (const worktree of [false, true])
    test(`enforced (${worktree ? "batch workers" : "single writer"}): T001 is corrected, the corrective waits for it and the test task runs`, async () => {
      const { root, runId, done, executor, service, wouldStops } = await drive({ enforce: true, worktree });
      expect(done.status).toBe("completed");
      const calls = implementations(executor);
      const corrective = calls.find((c) => c.origin !== "planned" && !c.writes?.includes("src/storage.ts"));
      const owner = calls.find((c) => c.origin !== "planned" && c.writes?.includes("src/storage.ts"));
      expect(corrective).toBeDefined();
      expect(owner).toBeDefined();
      // T002's corrective blocked once; the host routed storage.ts to T001's correction without a
      // restart of the same session; the corrective ran again after it and T003 ran last.
      expect(calls.map((c) => c.taskId)).toEqual(["T001", "T002", corrective?.taskId, owner?.taskId, corrective?.taskId, "T003"]);
      const graph = service.store.state(runId).graph?.tasks ?? [];
      const repairPredecessor = (id?: string) => graph.find((t) => t.id === id)?.findingIds.map((f) => service.store.state(runId).repairPredecessors[f]);
      expect(repairPredecessor(owner?.taskId)).toEqual(["T001"]);
      const edits = service.store.latestArtifact(runId, `${SCOPE_EDITS_DIR}${corrective?.taskId}.json`);
      expect(JSON.parse(service.store.readArtifact(runId, edits?.id ?? "")) as ScopeEdit[]).toEqual([expect.objectContaining({ path: "src/storage.ts", decision: "route", owner: "T001", correctiveIds: [owner?.taskId] })]);
      expect(wouldStops.filter((w) => w.reason === "corrective_unowned_file")).toEqual([]);
      const worktreePath = service.store.state(runId).worktree?.path;
      expect(readFileSync(join(root, worktreePath ?? "", "src/storage.ts"), "utf8")).toContain("unprefixed");
    }, 120_000);

  test("enforced, a project file no task writes inside the approved paths: the corrective is widened by it and acceptance checks the link", async () => {
    const { root, runId, done, executor, service } = await drive({ enforce: true, defect: "src/sql.ts", allowedPaths: ["src/**", "tests/**"] });
    expect(done.status).toBe("completed");
    const correctives = implementations(executor).filter((c) => c.origin !== "planned");
    // One corrective, twice: blocked without src/sql.ts, then with it.
    expect(new Set(correctives.map((c) => c.taskId)).size).toBe(1);
    expect(correctives.map((c) => c.writes?.includes("src/sql.ts"))).toEqual([false, true]);
    expect(readFileSync(join(root, "src/sql.ts"), "utf8")).toContain("unprefixed");
    const links = service.store.artifacts(runId).filter((a) => a.kind === "correction").map((a) => JSON.parse(service.store.readArtifact(runId, a.id)) as { rule: string; widened?: { path: string }[] });
    expect(links.map((l) => l.rule)).toEqual(["bounded-correction", "host-widen"]);
    expect(links[1]?.widened?.map((w) => w.path)).toEqual(["src/sql.ts"]);
    expect(implementations(executor).at(-1)?.taskId).toBe("T003");
  }, 120_000);

  test("enforced, a file outside every approved path: the corrective blocks with remedies and a plain resume opens no session (#2133 invariant)", async () => {
    const { runId, done, executor, service } = await drive({ enforce: true, defect: "vendor/lib.ts", allowedPaths: ["src/**", "tests/**"] });
    expect(done.status).toBe("blocked");
    const sessions = () => implementations(executor).filter((c) => c.origin !== "planned").length;
    // No restart of the same session: one session, then the block.
    expect(sessions()).toBe(1);
    const blocked = service.store.events(runId).filter((e) => e.type === "run.state_changed").at(-1)?.payload as { reason?: string };
    expect(blocked.reason).toBe("no_progress");
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision });
    const again = await service.drive(runId, new AbortController().signal);
    expect(again.status).toBe("blocked");
    expect(sessions()).toBe(1);
    const edits = service.store.latestArtifact(runId, `${SCOPE_EDITS_DIR}${implementations(executor).find((c) => c.origin !== "planned")?.taskId}.json`);
    expect((JSON.parse(service.store.readArtifact(runId, edits?.id ?? "")) as ScopeEdit[]).map((e) => [e.path, e.decision])).toContainEqual(["vendor/lib.ts", "refuse"]);
  }, 120_000);

  test("enforced, an upstream initiative feature's file (ewvet R68): the run parks with a request naming the path and its owner, then runs on the answer", async () => {
    const bounds = { featureId: "shortener", features: [{ id: "shortener", scope: "Links", paths: ["src/storage.ts", "src/handler.ts", "tests/**"] }, { id: "reader", scope: "Reader", paths: ["src/reader.ts"] }] };
    const { root, runId, done, executor, service } = await drive({ enforce: true, defect: "src/reader.ts", bounds });
    expect(done.status).toBe("waiting");
    const correctives = () => implementations(executor).filter((c) => c.origin !== "planned");
    expect(correctives()).toHaveLength(1);
    const request = service.store.requests(runId).find((r) => r.kind === "manual_evidence" && r.status === "pending");
    const body = JSON.parse(request?.body_json ?? "{}") as { criterionId: string; question: string; upstream: { paths: { path: string; feature: string }[] } };
    expect(body.upstream.paths).toEqual([{ path: "src/reader.ts", feature: "reader" }]);
    expect(body.question).toContain("feature reader");
    // The upstream owner makes the change; the person answers and the corrective runs again.
    writeFileSync(join(root, "src/reader.ts"), FIXED);
    const waiting = await service.get(runId);
    await service.decide(runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "manual-evidence", requestId: request?.id ?? "", criterionId: body.criterionId, evidence: "reader binds unprefixed keys now", accepted: true });
    // The change came from outside the run: the person accepts it, as for any upstream change.
    const changed = await service.drive(runId, new AbortController().signal);
    expect(changed.reason).toBe("input_changed");
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { acceptWorkspace: true });
    const resumed = await service.drive(runId, new AbortController().signal);
    expect(correctives()).toHaveLength(2);
    expect(resumed.status).toBe("completed");
  }, 120_000);

  test("the edge probe names the file of its failing output's first workspace frame, and T001 is corrected at once", async () => {
    const { runId, done, executor, service, records } = await drive({ enforce: false, frame: true });
    expect(done.status).toBe("completed");
    const finding = service.store.findings(runId).map((f) => JSON.parse(f.body_json) as { file: string; claim: string })[0];
    expect(finding?.file).toBe("src/storage.ts");
    expect(finding?.claim).toContain("of T002");
    const correctives = implementations(executor).filter((c) => c.origin !== "planned");
    expect(correctives).toHaveLength(1);
    expect(correctives[0]?.writes).toContain("src/storage.ts");
    const graph = service.store.state(runId).graph?.tasks ?? [];
    expect(graph.find((t) => t.id === correctives[0]?.taskId)?.findingIds.map((id) => service.store.state(runId).repairPredecessors[id])).toEqual(["T001"]);
    // Recorded on the probe's case, and the corrective's precondition fits.
    const probe = service.store.latestArtifact(runId, "probes/edge/T002.json");
    expect((JSON.parse(service.store.readArtifact(runId, probe?.id ?? "")) as { cases: { file?: string }[] }).cases[0]?.file).toBe("src/storage.ts");
    expect(records().every((r) => r.host === "fits")).toBe(true);
  }, 120_000);
});

// #2155: in shadow the person answers the block with the act the enforced host would take.
// Bench round 80, ratdec (Elixir) representations 8aa34d83 (#2485). The accepted feature core
// owned test/stdin_test.exs, whose row pinned `unsupported format` for `eval --as mixed` on stdin;
// representations implemented that output, its feature-scope mix-test failed only on that row, and
// its corrective T007 reported it. The host parked on a manual_evidence request (`upstream-T007`)
// that only a hand edit of the run branch could answer: core's run was closed and no command opens
// a task on it. Here the same shape on two stacks: the corrective's unresolved item names only a
// test file of a closed upstream feature. Enforced (`upstream_stale_file`), the file joins this
// feature and the corrective's writes and the run completes; in shadow the park stands and the
// amend is a would-stop; a source file of the same upstream keeps the park.
const STALE_STACKS = [
  { language: "Elixir (ExUnit)", test: "test/stdin_test.exs", source: "lib/ratdec/format.ex", core: ["lib/**", "test/**"] },
  { language: "Python (pytest)", test: "tests/core/test_stdin.py", source: "ratdec/format.py", core: ["ratdec/**", "tests/core/**"] },
];
const layered = (core: string[]) => ({ featureId: "representations", features: [{ id: "core", scope: "Core", paths: core }, { id: "representations", scope: "Representations", paths: ["src/storage.ts", "src/handler.ts", "tests/handler.test.ts"], dependsOn: ["core"] }] });

describe("scenario: R80 ratdec, a downstream feature makes a closed upstream feature's test stale (#2485)", () => {
  for (const stack of STALE_STACKS)
    for (const worktree of stack.language.startsWith("Elixir") ? [false, true] : [false])
      test(`${stack.language}, enforced (${worktree ? "batch workers" : "single writer"}): the stale test joins the feature and the corrective's writes, and the run completes without a person`, async () => {
        const { root, runId, done, executor, service, wouldStops, records } = await drive({ enforce: true, staleFile: "enforce", defect: stack.test, bounds: layered(stack.core), closedUpstream: "core", worktree });
        expect(service.store.requests(runId).filter((r) => r.kind === "manual_evidence")).toEqual([]);
        expect(done.status).toBe("completed");
        const correctives = implementations(executor).filter((c) => c.origin !== "planned");
        expect(new Set(correctives.map((c) => c.taskId)).size).toBe(1);
        expect(correctives.map((c) => c.writes?.includes(stack.test))).toEqual([false, true]);
        const state = service.store.state(runId);
        expect(state.initiativeBounds?.features.find((f) => f.id === "representations")?.paths).toContain(stack.test);
        expect(state.initiativeBounds?.features.find((f) => f.id === "core")?.paths).toEqual(stack.core);
        const links = service.store.artifacts(runId).filter((a) => a.kind === "correction").map((a) => JSON.parse(service.store.readArtifact(runId, a.id)) as { rule: string; widened?: { path: string }[] });
        expect(links.find((l) => l.rule === "host-widen")?.widened?.map((w) => w.path)).toEqual([stack.test]);
        const edits = service.store.latestArtifact(runId, `${SCOPE_EDITS_DIR}${correctives[0]?.taskId}.json`);
        expect(JSON.parse(service.store.readArtifact(runId, edits?.id ?? "")) as ScopeEdit[]).toEqual([expect.objectContaining({ path: stack.test, decision: "amend", owner: "core", hash: expect.any(String) })]);
        const result = records().filter((r) => r.at === "result").at(0);
        expect(result?.unowned).toEqual([expect.objectContaining({ path: stack.test, feature: "core", upstream: { closed: true, testFile: true, sole: true }, decision: "amend" })]);
        expect(wouldStops.filter((w) => w.reason === "upstream_stale_file")).toEqual([]);
        expect(readFileSync(join(root, state.worktree?.path ?? "", stack.test), "utf8")).toContain("unprefixed");
      }, 120_000);

  for (const stack of STALE_STACKS) {
    test(`${stack.language}, upstream_stale_file in shadow (the default): the park stands and the amend is a would-stop`, async () => {
      const { runId, done, wouldStops, service, records } = await drive({ enforce: true, defect: stack.test, bounds: layered(stack.core), closedUpstream: "core" });
      expect(done.status).toBe("waiting");
      const request = service.store.requests(runId).find((r) => r.kind === "manual_evidence" && r.status === "pending");
      expect((JSON.parse(request?.body_json ?? "{}") as { upstream: { paths: { path: string; feature: string }[] } }).upstream.paths).toEqual([{ path: stack.test, feature: "core" }]);
      const stale = wouldStops.filter((w) => w.reason === "upstream_stale_file");
      expect(stale.length).toBeGreaterThan(0);
      expect(stale[0]?.summary).toContain(stack.test);
      expect(records().some((r) => r.host === "amend")).toBe(true);
      const edits = (JSON.parse(service.store.readArtifact(runId, service.store.artifacts(runId).find((a) => a.logical_path.startsWith(SCOPE_EDITS_DIR))?.id ?? "")) as ScopeEdit[]);
      expect(edits.map((e) => [e.path, e.decision])).toEqual([[stack.test, "park"]]);
    }, 120_000);

    test(`${stack.language}, enforced, a source file of the closed upstream: the run still parks`, async () => {
      const { runId, done, wouldStops, service, records } = await drive({ enforce: true, staleFile: "enforce", defect: stack.source, bounds: layered(stack.core), closedUpstream: "core" });
      expect(done.status).toBe("waiting");
      expect(service.store.requests(runId).some((r) => r.kind === "manual_evidence" && r.status === "pending")).toBe(true);
      const result = records().find((r) => r.at === "result");
      expect(result?.unowned).toEqual([expect.objectContaining({ path: stack.source, feature: "core", upstream: { closed: true, testFile: false, sole: true }, decision: "park" })]);
      expect(wouldStops.filter((w) => w.reason === "upstream_stale_file")).toEqual([]);
    }, 120_000);
  }
});

describe("scenario: a person answers a blocked corrective's unowned file with a remedy (#2155)", () => {
  for (const worktree of [false, true])
    test(`shadow (${worktree ? "batch workers" : "single writer"}): the block offers route to T001, and applying it corrects T001 and the run completes`, async () => {
      const { runId, done, executor, service } = await drive({ enforce: false, worktree });
      expect(done.status).toBe("blocked");
      const recovery = stopRecovery(service.store, runId);
      const route = recovery?.remedies.find((r) => r.action === "route");
      const corrective = implementations(executor).find((c) => c.origin !== "planned");
      expect(route).toEqual({ action: "route", runId, taskId: corrective?.taskId, paths: ["src/storage.ts"], owner: "T001" });
      expect(recovery?.message).toContain(`baked workflow resume ${runId} --remedy route`);
      // A remedy the block does not offer is refused.
      await expect(service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { remedy: "widen" })).rejects.toThrow("does not offer the remedy widen");
      await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { remedy: "route" });
      const resumed = await service.drive(runId, new AbortController().signal);
      expect(resumed.status).toBe("completed");
      const calls = implementations(executor);
      const owner = calls.find((c) => c.origin !== "planned" && c.writes?.includes("src/storage.ts"));
      const graph = service.store.state(runId).graph?.tasks ?? [];
      expect(graph.find((t) => t.id === owner?.taskId)?.findingIds.map((f) => service.store.state(runId).repairPredecessors[f])).toEqual(["T001"]);
      expect(calls.at(-1)?.taskId).toBe("T003");
      const edits = service.store.latestArtifact(runId, `${SCOPE_EDITS_DIR}${corrective?.taskId}.json`);
      expect(JSON.parse(service.store.readArtifact(runId, edits?.id ?? "")) as ScopeEdit[]).toEqual([expect.objectContaining({ path: "src/storage.ts", decision: "route", owner: "T001", approvedBy: "user" })]);
      expect(service.store.artifacts(runId).some((a) => a.logical_path.startsWith(`decisions/unowned-${corrective?.taskId}-`))).toBe(true);
      expect(service.store.state(runId).unownedRemedies).toEqual({});
    }, 120_000);

  test("shadow, a project file no task writes inside the approved paths: the widen remedy lets the corrective write it", async () => {
    const { root, runId, done, executor, service } = await drive({ enforce: false, defect: "src/sql.ts", allowedPaths: ["src/**", "tests/**"] });
    expect(done.status).toBe("blocked");
    expect(stopRecovery(service.store, runId)?.remedies.map((r) => r.action)).toEqual(["widen", "resume", "revise", "cancel"]);
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { remedy: "widen" });
    const resumed = await service.drive(runId, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(readFileSync(join(root, "src/sql.ts"), "utf8")).toContain("unprefixed");
    const links = service.store.artifacts(runId).filter((a) => a.kind === "correction").map((a) => JSON.parse(service.store.readArtifact(runId, a.id)) as { rule: string });
    expect(links.map((l) => l.rule)).toContain("host-widen");
    expect(service.store.state(runId).personWidened).toEqual(["src/sql.ts"]);
    expect(implementations(executor).at(-1)?.taskId).toBe("T003");
  }, 120_000);

  test("shadow, an upstream initiative feature's file: the upstream remedy parks the run with a request to that feature", async () => {
    const bounds = { featureId: "shortener", features: [{ id: "shortener", scope: "Links", paths: ["src/storage.ts", "src/handler.ts", "tests/**"] }, { id: "reader", scope: "Reader", paths: ["src/reader.ts"] }] };
    const { runId, done, service } = await drive({ enforce: false, defect: "src/reader.ts", bounds });
    expect(done.status).toBe("blocked");
    expect(stopRecovery(service.store, runId)?.remedies[0]).toMatchObject({ action: "upstream", owner: "reader", paths: ["src/reader.ts"] });
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { remedy: "upstream" });
    const parked = await service.drive(runId, new AbortController().signal);
    expect(parked.status).toBe("waiting");
    const request = service.store.requests(runId).find((r) => r.kind === "manual_evidence" && r.status === "pending");
    expect((JSON.parse(request?.body_json ?? "{}") as { upstream: { paths: { path: string; feature: string }[] } }).upstream.paths).toEqual([{ path: "src/reader.ts", feature: "reader" }]);
  }, 120_000);
});

describe("unownedRemedies offers one remedy per host decision (#2155)", () => {
  const record = (decisions: ("route" | "widen" | "park" | "wait" | "refuse")[]): ScopeRecord => ({
    taskId: "T009", at: "result", failing: [], checks: [], diagnosed: [], writes: ["src/handler.ts"], missing: [], decision: "fits",
    unowned: decisions.map((decision, i) => ({ path: `src/f${i}.ts`, owner: decision === "route" ? "T001" : null, openWriters: decision === "wait" ? ["T003"] : [], feature: decision === "park" ? "reader" : null, allowed: decision === "widen", hash: "h", decision })),
  });
  test("route, widen and park become route, widen and upstream; wait and refuse offer none", () => {
    expect(unownedRemedies("R1", record(["route"]))).toEqual([{ action: "route", runId: "R1", taskId: "T009", paths: ["src/f0.ts"], owner: "T001" }]);
    expect(unownedRemedies("R1", record(["widen"]))).toEqual([{ action: "widen", runId: "R1", taskId: "T009", paths: ["src/f0.ts"] }]);
    expect(unownedRemedies("R1", record(["park"]))).toEqual([{ action: "upstream", runId: "R1", taskId: "T009", paths: ["src/f0.ts"], owner: "reader" }]);
    expect(unownedRemedies("R1", record(["wait", "refuse"]))).toEqual([]);
    expect(unownedRemedies("R1", record(["refuse", "widen", "route"])).map((r) => r.action)).toEqual(["route", "widen"]);
    // Every host decision a block can be answered with has its remedy (the #2155 invariant).
    for (const decision of ["route", "widen", "park"] as const) expect(unownedRemedies("R1", record([decision]))).toHaveLength(1);
    expect(unownedBlockAdvice("R1", "Task T009 did not complete", record(["wait"]))).toBeUndefined();
    expect(recoveryOf(unownedBlockAdvice("R1", "Task T009 did not complete", record(["route"])))?.remedies[0]).toMatchObject({ action: "route", paths: ["src/f0.ts"] });
  });
});

describe("scopeRecord reads the files every corrective origin names (#2133)", () => {
  const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [...PLAN, { ...planned("T004", "src/handler.ts", [], 2), origin: "repair" as const, findingIds: ["F1"], writes: [{ path: "src/handler.ts", action: "modify" as const }] }] };
  const rows = [{ id: "T001", status: "verified" }, { id: "T002", status: "implemented" }, { id: "T003", status: "pending" }, { id: "T004", status: "running" }];
  const known = graph.tasks.flatMap((t) => t.writes.map((w) => w.path));
  const evidence = (unresolved: string[] = [], extra: Partial<ScopeEvidence> = {}): ScopeEvidence => ({ unresolved, rows, paths: (text) => evidencePaths(text, "/w", known), allowedPaths: [], hash: () => "h", ...extra });
  const state = { graph, repairScope: {}, repairPredecessors: { F1: "T002" } };
  const policy = { checks: [] };
  const corrective = graph.tasks[3] as Task;
  const frame = "Error: Missing parameter code\n    at bind (/w/src/storage.ts:91:53)\n    at handle (/w/src/handler.ts:1:9)";
  const origins: [string, { claim: string; file: string; repro?: { actual: string } }, string[]][] = [
    ["review", { claim: "The handler returns a missing link for a stored code", file: "src/handler.ts", repro: { actual: frame } }, []],
    ["probe", { claim: "Edge input 1 of T002, legal under AC-002: prints \"x\" where \"ok\" is required", file: "src/handler.ts", repro: { actual: frame } }, []],
    ["battery", { claim: "Battery case F1 of src/handler.ts shows its reported behavior again after T004: x", file: "src/handler.ts", repro: { actual: frame } }, []],
    ["unresolved", { claim: "Task T004 reported unresolved in its own files: lookups fail", file: "src/handler.ts" }, [UNRESOLVED_STORAGE]],
  ];
  for (const [origin, finding, unresolved] of origins)
    test(`${origin}: a file its evidence names outside the corrective's writes is routed to its owner`, () => {
      expect(findingOrigin(finding)).toBe(origin as ReturnType<typeof findingOrigin>);
      const record = scopeRecord(state, policy, corrective, [{ id: "F1", ...finding }], "start", undefined, evidence(unresolved));
      expect(record).toMatchObject({ origins: [origin], decision: "fits", host: "route" });
      expect(record?.unowned).toEqual([{ path: "src/storage.ts", owner: "T001", openWriters: [], feature: null, allowed: false, hash: "h", decision: "route" }]);
    });

  test("without named files outside the writes the record fits, and without evidence it is the #2094 record", () => {
    const finding = { id: "F1", claim: "The handler returns a missing link", file: "src/handler.ts" };
    expect(scopeRecord(state, policy, corrective, [finding], "create", undefined, evidence())).toMatchObject({ host: "fits", unowned: [], named: ["src/handler.ts"] });
    expect(scopeRecord(state, policy, corrective, [finding], "create")).toBeNull();
  });

  test("an upstream initiative feature's file parks; an approved path no task writes widens; an unfinished writer waits; anything else refuses", () => {
    const bounds = { featureId: "scanner", features: [{ id: "scanner", scope: "Scanner", paths: ["src/handler.ts", "src/storage.ts", "src/scan/**"] }, { id: "reader", scope: "Reader", paths: ["src/Ewvet/Scan/Reader.cs"] }] };
    // ewvet R68: the worker names the upstream file by its bare name.
    const reader = scopeRecord({ ...state, initiativeBounds: bounds }, policy, corrective, [{ id: "F1", claim: "The Reader-backed facade is missing", file: "src/handler.ts" }], "result", undefined, evidence(["Reader.cs has no public classification helper to forward to, and Reader.cs is outside T004's approved write paths"], { paths: (text) => evidencePaths(text, "/w", [...known, "src/Ewvet/Scan/Reader.cs"]) }));
    expect(reader?.unowned).toEqual([expect.objectContaining({ path: "src/Ewvet/Scan/Reader.cs", feature: "reader", owner: null, decision: "park" })]);
    expect(reader?.host).toBe("park");
    expect(unownedRule({ path: "src/scan/sql.ts", owner: null, openWriters: [], feature: null, allowed: true })).toBe("widen");
    expect(unownedRule({ path: "tests/handler.test.ts", owner: null, openWriters: ["T003"], feature: null, allowed: true })).toBe("wait");
    expect(unownedRule({ path: "vendor/lib.ts", owner: null, openWriters: [], feature: null, allowed: false })).toBe("refuse");
    // #2485: only a lone test file of a closed upstream feature is amended; any missing input parks.
    const upstream = { closed: true, testFile: true, sole: true };
    expect(unownedRule({ path: "test/stdin_test.exs", owner: null, openWriters: [], feature: "core", allowed: false, upstream })).toBe("amend");
    for (const missing of ["closed", "testFile", "sole"] as const) expect(unownedRule({ path: "test/stdin_test.exs", owner: null, openWriters: [], feature: "core", allowed: false, upstream: { ...upstream, [missing]: false } })).toBe("park");
    expect(hostDecision([{ decision: "park" }, { decision: "amend" }])).toBe("amend");
    expect(hostDecision([{ decision: "refuse" }, { decision: "widen" }, { decision: "route" }])).toBe("route");
    expect(hostDecision([])).toBe("fits");
  });

  test("evidencePaths and stackFrames: frames of every runtime, a frame from another machine and a bare name", () => {
    const paths = ["src/storage.ts", "src/handler.ts", "src/Storage.java", "src/Ewvet/Reader.cs"];
    expect(evidencePaths("    at getLink (C:\\Users\\b\\url\\src\\storage.ts:91:53)", "/w", paths)).toEqual(["src/storage.ts"]);
    expect(evidencePaths("    at getLink (/w/src/storage.ts:91:53)", "/w", [])).toEqual([]);
    expect(evidencePaths("see /w/src/new.ts:3", "/w", [], (p) => p === "src/new.ts")).toEqual(["src/new.ts"]);
    expect(evidencePaths("\tat com.x.Storage.getLink(Storage.java:91)", "/w", paths)).toEqual(["src/Storage.java"]);
    expect(evidencePaths("Reader.cs is outside the paths; call Reader.IsEncodingToken", "/w", paths)).toEqual(["src/Ewvet/Reader.cs"]);
    expect(stackFrames("the value is wrong\nsrc/storage.ts mentioned in prose\n  File \"/w/a.py\", line 3, in f\n   at R.Read() in /w/R.cs:line 9")).toBe("  File \"/w/a.py\", line 3, in f\n   at R.Read() in /w/R.cs:line 9");
  });
});
