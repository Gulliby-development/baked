import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { PROCESS_SCOPE_ENV, parseScopedPs } from "../src/core/platform/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { PlanSchema, type RunPolicy, type Spec } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }], dependencies: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

class FixtureExecutor implements AgentExecutor {
  calls: string[] = [];
  constructor(private root: string, private repair = false) {}
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": {
        const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        writeFileSync(join(this.root, "value.txt"), this.repair && request.task?.id === "T001" ? "broken" : "ready");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }; break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Command checked value" }], findings: [] }; break;
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Command checked the value" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}
function setup(repair = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-workflow-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new FixtureExecutor(root, repair);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  return { root, executor, service, config };
}
async function start(service: NativeWorkflowService) {
  const request = { commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy };
  return { run: await service.start(request), request };
}
async function approve(service: NativeWorkflowService, runId: string) {
  const run = await service.get(runId); const request = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  expect(request).toBeDefined();
  return service.decide(runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "approve", requestId: request!.id, digest: request!.digest });
}

test("review followup: correction of a failed corrective task restores the full chain", async () => {
  const { service, executor, root } = setup();
  const taskPolicy = { ...policy, maxRepairRounds: 5, checks: policy.checks.map(c => ({ ...c, scope: "task" as const })) };
  const original = executor.execute.bind(executor);
  const implementations: string[] = [];
  executor.execute = async request => {
    if (request.profile.output === "implementation") {
      implementations.push(request.task!.id);
      const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, taskPolicy, request.task);
      expect(guard.validate("edit_file", { path: "value.txt" })).toBe("value.txt");
      expect(request.task!.writes[0]!.action).toBe(implementations.length === 1 ? "create" : "modify");
      await guard.execute("edit_file", { path: "value.txt" }, async () => {
        writeFileSync(join(root, "value.txt"), implementations.length < 3 ? `broken-${implementations.length}` : "ready");
      });
      return { output: { schemaVersion: 1, taskId: request.task!.id, outcome: "implemented", summary: "Write fixture", evidenceIds: [], unresolved: [] }, inputTokens: 20, outputTokens: 30 };
    }
    const result = await original(request);
    if (request.profile.output === "plan") {
      const p = PlanSchema.parse(result.output); p.taskGraph.tasks[0]!.checkIds = ["check"]; result.output = p;
    }

    return result;
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "review", policy: taskPolicy });
  await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
  const result = await service.drive(run.runId, new AbortController().signal);
  expect(implementations).toEqual(["T001", "T002", "T003"]);
  expect(service.store.checks(run.runId).at(-1)?.status).toBe("passed");
  expect(result.status).toBe("completed");
  expect(service.store.tasks(run.runId).every(t => t.status === "verified")).toBe(true);
});

test("review followup: recovery cancel rejects a different live command and rolls back atomically", async () => {
  const { service } = setup(); const { run } = await start(service);
  const step = service.store.beginStep(run.runId, "crashed-check");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const selected = service.store.prepareEffect(run.runId, attempt, "command", { checkId: "check" }, null, null);
  service.store.prepareEffect(run.runId, attempt, "command", { checkId: "other", pid: process.pid }, null, null);
  service.store.putLease({ resource: "execution", owner_id: "dead-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: 2147483647 }) });
  const resumed = await service.resume(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision });
  const request = service.store.requests(run.runId).find(r => JSON.parse(r.body_json).effectId === selected)!;
  await expect(service.decide(run.runId, { commandId: newId(), expectedRevision: resumed.revision }, { kind: "recovery", requestId: request.id, effectId: selected, resolution: "cancel", evidence: "Abandon run" })).rejects.toThrow("All owned commands must be stopped");
  expect((await service.get(run.runId)).status).toBe("waiting");
  expect(service.store.requests(run.runId).filter(r=>r.status === "pending")).toHaveLength(2);
  expect(service.store.lease("execution")?.owner_id).toBe("dead-owner");
  expect(service.store.artifacts(run.runId).some(a=>a.logical_path.startsWith("abandoned-effects/"))).toBe(false);
});

test("review followup: scheduler propagates heartbeat loss to its active check", async () => {
  const { service } = setup();
  const sleepingPolicy = { ...policy, checks: policy.checks.map(c => ({ ...c, args: ["-e", "setTimeout(() => {}, 30000)"], timeoutMs: 10000 })) };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "review", policy: sleepingPolicy });
  await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
  const original = service.scheduler.processes.execute.bind(service.scheduler.processes);
  let stoppedAfterLoss = false;
  service.scheduler.processes.execute = async (executable,args,options) => {
    const result = await original(executable,args,{...options,onSpawn: pid=>{
      options.onSpawn?.(pid);
      const db = new Database(service.store.path);
      try {
        db.exec("CREATE TRIGGER injected_heartbeat_failure BEFORE INSERT ON workspace_leases BEGIN SELECT RAISE(FAIL, 'injected heartbeat write failure'); END;");
        Reflect.get(service.leases,"heartbeat").call(service.leases);
        db.exec("DROP TRIGGER injected_heartbeat_failure");
        expect(service.store.lease("mutation")?.owner_id).toBe(service.leases.owner);
      } finally {db.close();}
    }});
    stoppedAfterLoss = result.cancelled;
    return result;
  };
  const result = await service.drive(run.runId,new AbortController().signal);
  expect(stoppedAfterLoss).toBe(true);
  expect(result.status).toBe("blocked");
  expect(service.store.lease("execution")).toBeNull();
  expect(service.store.lease("mutation")).toBeNull();
});


test("stopping a run whose owner process died releases its workspace leases", async () => {
  const { service } = setup();
  const { assertWorkspaceMutationAllowed } = await import("../src/core/workflows/leases.js");
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  const dead = JSON.stringify({ pid: 2147483647 });
  service.store.transaction(() => {
    service.store.transition(run.runId, "running");
    for (const resource of ["execution", "mutation"] as const)
      service.store.putLease({ resource, owner_id: "dead-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: dead });
  });
  expect(() => assertWorkspaceMutationAllowed(service.workspace)).toThrow("owns this workspace");
  const current = await service.get(run.runId);
  await service.pause(run.runId, { commandId: newId(), expectedRevision: current.revision });
  expect(service.store.lease("execution")).toBeNull();
  expect(service.store.lease("mutation")).toBeNull();
  expect(service.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("released-leases/"))).toBe(true);
  expect(() => assertWorkspaceMutationAllowed(service.workspace)).not.toThrow();
});

test("stopping a run keeps leases of a live owner or a possibly running command", async () => {
  const { service } = setup();
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  service.store.transaction(() => {
    service.store.transition(run.runId, "running");
    service.store.putLease({ resource: "execution", owner_id: "live-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: process.pid }) });
  });
  let current = await service.get(run.runId);
  await service.pause(run.runId, { commandId: newId(), expectedRevision: current.revision });
  expect(service.store.lease("execution")?.owner_id).toBe("live-owner");

  const step = service.store.beginStep(run.runId, "checks");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  service.store.transaction(() => {
    service.store.prepareEffect(run.runId, attempt, "command", { checkId: "check", pid: process.pid }, null, null);
    service.store.putLease({ resource: "execution", owner_id: "dead-owner", owner_epoch: 2, run_id: run.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: 2147483647 }) });
  });
  current = await service.get(run.runId);
  await service.cancel(run.runId, { commandId: newId(), expectedRevision: current.revision });
  expect(service.store.lease("execution")?.owner_id).toBe("dead-owner");
});

test("the planner receives package validation; requirement ids are derived by the host, an unknown criterion is still corrected", async () => {
  const { service, executor } = setup();
  const seen: string[][] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    const response = await original(request);
    if (request.profile.output === "plan") {
      expect(request.validate).toBeDefined();
      const output = response.output as { taskGraph: { tasks: { requirementIds: string[]; criterionIds: string[] }[] } };
      const broken = structuredClone(output);
      broken.taskGraph.tasks[0]!.requirementIds = ["FR-999"];
      const unknown = structuredClone(output);
      unknown.taskGraph.tasks[0]!.criterionIds = ["AC-404"];
      seen.push(request.validate!(broken), request.validate!(output), request.validate!(unknown));
    }
    return response;
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  // A wrong requirement id is replaced by the ones the task's criteria verify.
  expect(seen[0]).toEqual([]);
  expect(seen[1]).toEqual([]);
  expect(seen[2]?.some((e) => e.includes("unknown criterion AC-404"))).toBe(true);
  expect((await service.get(run.runId)).reason).toBe("approval");
});

test("an orphaned descendant of an exited command still blocks recovery and lease takeover", async () => {
  const { service } = setup();
  const { commandMayBeRunning } = await import("../src/core/workflows/leases.js");
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  const step = service.store.beginStep(run.runId, "checks");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const effectId = service.store.transaction(() =>
    service.store.prepareEffect(run.runId, attempt, "command", { checkId: "check" }, null, null),
  );
  // The command starts a detached long-lived grandchild and exits at once; the grandchild outlives it.
  const script = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true }); g.unref(); console.log(g.pid);`;
  // A detached grandchild leaves the command's process group on POSIX; the inherited scope marker still links it.
  const scope = newId();
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore", env: { ...process.env, [PROCESS_SCOPE_ENV]: scope } });
  service.store.transaction(() => service.store.recordProcess(run.runId, effectId, child.pid, scope));
  const grandchild = Number((await new Response(child.stdout).text()).trim());
  await child.exited;
  try {
    expect(grandchild).toBeGreaterThan(0);
    // The grandchild reports its pid as soon as it is spawned; until its exec completes its
    // environment, and so its scope marker, can read as empty.
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      seen = commandMayBeRunning(service.store, run.runId);
      if (!seen) await Bun.sleep(20);
    }
    expect(seen).toBe(true);
  } finally {
    try { process.kill(grandchild, "SIGKILL"); } catch {}
  }
  for (let i = 0; i < 50; i++) {
    try { process.kill(grandchild, 0); } catch { break; }
    await Bun.sleep(100);
  }
  expect(commandMayBeRunning(service.store, run.runId)).toBe(false);
});

// Windows has no readable process environment, so a descendant there is linked only by parent PID.
test.skipIf(process.platform === "win32")("cancelling a command also stops a descendant that left its process group", async () => {
  const { scopedProcesses } = await import("../src/core/platform/index.js");
  const script = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true }).unref(); setTimeout(() => {}, 60000);`;
  const controller = new AbortController();
  let scope = "";
  const done = new ProcessScope().execute(process.execPath, ["-e", script], {
    cwd: tmpdir(),
    env: process.env,
    timeoutMs: 20000,
    signal: controller.signal,
    sandbox: null,
    onSpawn: (_pid, marker) => { scope = marker; },
  });
  let started: number[] = [];
  for (let i = 0; i < 100 && started.length < 2; i++) {
    await Bun.sleep(50);
    started = scope ? (scopedProcesses(scope) ?? []) : [];
  }
  controller.abort();
  const result = await done;
  try {
    expect(started.length).toBe(2);
    expect(result.cancelled).toBe(true);
    let left = scopedProcesses(scope) ?? [];
    for (let i = 0; i < 50 && left.length; i++) {
      await Bun.sleep(100);
      left = scopedProcesses(scope) ?? [];
    }
    expect(left).toEqual([]);
  } finally {
    for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

test("the scope marker is found in the environment column of macOS ps", () => {
  const scope = "3f1c";
  const table = [
    `  101 /usr/bin/node app.js PATH=/usr/bin ${PROCESS_SCOPE_ENV}=${scope} HOME=/Users/a`,
    `  102 /bin/sleep 60 ${PROCESS_SCOPE_ENV}=${scope}`,
    `  103 /bin/sleep 60 ${PROCESS_SCOPE_ENV}=${scope}5 HOME=/Users/a`,
    "  104 /bin/zsh HOME=/Users/a",
  ].join("\n");
  expect(parseScopedPs(table, scope)).toEqual([101, 102]);
});

test("recover --resolution cancel from the terminal warns that it cancels the whole run", async () => {
  const { spyOn } = await import("bun:test");
  const { executeWorkflowCommand } = await import("../src/headless/workflow.js");
  const { parseWorkflowArgs } = await import("../src/headless/workflow-parse.js");
  const { service, root } = setup(); const { run } = await start(service);
  writeFileSync(join(root, "evidence.txt"), "The file does not contain the change");
  const step = service.store.beginStep(run.runId, "crashed-check");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const effect = service.store.prepareEffect(run.runId, attempt, "command", { checkId: "check" }, null, null);
  service.store.putLease({ resource: "execution", owner_id: "dead-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: 2147483647 }) });
  const resumed = await service.resume(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision });
  const request = service.store.requests(run.runId).find((r) => JSON.parse(r.body_json).effectId === effect)!;
  const written: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as never);
  try {
    const recover = (resolution: string, revision: number) =>
      executeWorkflowCommand(service, parseWorkflowArgs(["recover", run.runId, "--request", request.id, "--effect", effect, "--resolution", resolution, "--file", join(root, "evidence.txt"), "--expected-revision", String(revision)]), new AbortController().signal);
    expect(written.join("")).not.toContain("cancels the whole run");
    const cancelled = (await recover("cancel", resumed.revision)) as { status: string };
    expect(cancelled.status).toBe("cancelled");
    expect(written.join("")).toContain("cancels the whole run");
  } finally { stderr.mockRestore(); }
});
