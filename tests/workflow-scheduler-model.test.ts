import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { ROUTING_ARTIFACT } from "../src/core/llm/model-routing.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { terminalStates } from "../src/core/workflows/state-machine.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// Model-based test of the workflow scheduler (#1721). Random sequences of the commands a person
// or the host gives a run drive the real service with a scripted executor; after every command
// the real state is checked against a small reference model: run states, attempt lineage,
// reservations and the run's token and call accounting.
//
// Commands map to the service as the headless CLI calls it (`src/headless/workflow.ts`): start,
// approve, resume and `extend --resume` drive the run afterwards; pause, cancel, fork and reroute
// do not. A worker crash is the executor dying in the next implementation attempt, and a restart
// is the host process closing and opening the service on the same workspace.
//
// A new scheduler command adds its command to this model in the same pull request (AGENTS.md).

const MODEL_A = "anthropic/claude-sonnet-4-6";
const MODEL_B = "anthropic/claude-haiku-4-5";
/** Implementation and review use enough tokens for a tight run to stop on its budget after the task. */
const heavy = (output: string): number => (["implementation", "review", "convergence"].includes(output) ? 150_000 : 50);
const roomy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 50_000_000 };
const tight: RunPolicy = { ...fixturePolicy, maxTotalTokens: 300_000 };

/** The fixture flow, plus a worker that dies in its next implementation attempt when armed. */
class CrashingExecutor extends FixtureExecutor {
  armed = false;
  crashes = 0;
  constructor(root: string) {
    super(root, heavy);
  }
  override async execute(request: ExecutionRequest) {
    if (this.armed && request.profile.output === "implementation") {
      this.armed = false;
      this.crashes++;
      throw new Error("worker process exited");
    }
    return super.execute(request);
  }
}

/** The host: a workspace, its executor and the service, which a restart opens again. */
class Host {
  readonly root = mkdtempSync(join(tmpdir(), "baked-scheduler-model-"));
  readonly executor = new CrashingExecutor(this.root);
  readonly config = {
    ...DEFAULT_CONFIG,
    defaultModel: MODEL_A,
    workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: roomy, stall: { providerResumes: 0 } as Record<string, number> },
  };
  service = new NativeWorkflowService(this.root, this.config, this.executor);
  /** Run IDs in the order the model knows them. */
  readonly ids: string[] = [];
  /** Each run's accounting at the last check, which only grows. */
  readonly seen = new Map<string, { tokens: number; calls: number; cost: number }>();
  get store() {
    return this.service.store;
  }
  command(runId: string) {
    return { commandId: newId(), expectedRevision: this.store.run(runId).revision };
  }
  async drive(runId: string) {
    await this.service.drive(runId, new AbortController().signal);
  }
  async restart() {
    await this.service.shutdown();
    this.service.close();
    this.service = new NativeWorkflowService(this.root, this.config, this.executor);
  }
  async dispose() {
    await this.service.shutdown();
    this.service.close();
    await removeTempDir(this.root);
  }
}

/** What the model knows of one run. */
interface RunModel {
  parent: number | null;
  status: string;
  reason: string;
  tight: boolean;
  /** A person approved its plan. */
  approved: boolean;
  /** The pending request that holds the run for a person, if any. */
  pending: "approval" | "clarification" | null;
  /** The model the run is routed to. */
  model: string;
  /** Revisions of its routing record. */
  routings: number;
}

interface Model {
  runs: RunModel[];
  /** The executor's next implementation attempt dies. */
  armed: boolean;
}

type Outcome = { status: string; reason?: string };
const terminal = (status: string) => (terminalStates as readonly string[]).includes(status);

/** Where driving a run can stop, from what the model knows before the drive. */
function driveOutcomes(model: Model, run: RunModel, crashed: boolean): Outcome[] {
  // Forks share the parent's workspace: one run's edits change the input another approved.
  const shared: Outcome[] = model.runs.length > 1 ? [{ status: "blocked", reason: "input_changed" }] : [];
  if (!run.approved)
    // A fork plans again: its analysis may ask about the files the parent already wrote.
    return [{ status: "waiting", reason: "approval" }, ...(run.parent !== null ? [{ status: "waiting", reason: "clarification" }] : []), ...shared];
  // A worker that dies is a transient failure: the run stops for a resume, never completes.
  if (crashed) return [{ status: "blocked" }];
  return [{ status: "completed", reason: "none" }, ...(run.tight ? [{ status: "blocked", reason: "budget_exhausted" }] : []), ...shared];
}

/** Reads the run's state after a drive into the model, after checking it was an expected outcome. */
function settle(host: Host, model: Model, index: number, outcomes: Outcome[]) {
  const run = model.runs[index] as RunModel;
  const row = host.store.run(host.ids[index] as string);
  const matched = outcomes.some((o) => o.status === row.status && (o.reason === undefined || o.reason === row.reason));
  if (!matched) throw new Error(`Run ${index} is ${row.status}/${row.reason}; the model expected ${JSON.stringify(outcomes)}`);
  run.status = row.status;
  run.reason = row.reason;
  run.pending = row.status === "waiting" && (row.reason === "approval" || row.reason === "clarification") ? row.reason : null;
}

/** Runs a command the model expects the service to refuse; the run must stay as it was. */
async function refused(host: Host, model: Model, index: number, action: () => Promise<unknown>) {
  const id = host.ids[index] as string;
  const before = host.store.run(id);
  let fault: unknown;
  try {
    await action();
  } catch (error) {
    fault = error;
  }
  expect(fault).toBeInstanceOf(WorkflowFault);
  const after = host.store.run(id);
  expect([after.status, after.reason, after.token_usage, after.agent_calls]).toEqual([before.status, before.reason, before.token_usage, before.agent_calls]);
  check(host, model);
}

/** Drives the run after a command, as the CLI does, and checks where it stopped. */
async function driveAndSettle(host: Host, model: Model, index: number) {
  const run = model.runs[index] as RunModel;
  const id = host.ids[index] as string;
  const implementing = run.approved && host.store.tasks(id).some((t) => !["implemented", "verified"].includes(t.status));
  const crashes = host.executor.crashes;
  await host.drive(id);
  const crashed = host.executor.crashes > crashes;
  // An armed crash hits the first implementation attempt the drive makes.
  if (model.armed && implementing) expect(crashed).toBe(true);
  if (crashed) model.armed = false;
  settle(host, model, index, driveOutcomes(model, run, crashed));
  check(host, model);
}

/** The invariants that hold after every command, for every run. */
function check(host: Host, model: Model) {
  const store = host.store;
  host.ids.forEach((id, index) => {
    const run = model.runs[index] as RunModel;
    const row = store.run(id);
    // Run state and lineage.
    expect(`${index}:${row.status}`).toBe(`${index}:${run.status}`);
    expect(row.parent_run_id).toBe(run.parent === null ? null : (host.ids[run.parent] ?? "missing"));
    const pending = store.requests(id).filter((r) => r.status === "pending");
    expect(pending.some((r) => r.kind === "approval")).toBe(run.pending === "approval");
    expect(store.latestArtifact(id, ROUTING_ARTIFACT)?.revision ?? 0).toBe(run.routings);
    // Attempt lineage: every attempt belongs to a step of its run, every step's parent exists,
    // a step's attempts are numbered without gaps, and nothing runs while no driver is active.
    const steps = new Map(store.steps(id).map((s) => [s.id, s]));
    for (const step of steps.values()) if (step.parent_step_id !== null) expect(steps.has(step.parent_step_id)).toBe(true);
    const attempts = store.attempts(id) as (ReturnType<typeof store.attempts>[number] & { ordinal: number })[];
    const ordinals = new Map<string, number[]>();
    for (const attempt of attempts) {
      expect(steps.has(attempt.step_id)).toBe(true);
      ordinals.set(attempt.step_id, [...(ordinals.get(attempt.step_id) ?? []), attempt.ordinal]);
      expect(attempt.status).not.toBe("running");
      // Reservations: never negative; an ended attempt is complete exactly when its usage is known,
      // and one whose usage is unknown keeps its reservation as its charge.
      expect(attempt.reserved_tokens).toBeGreaterThanOrEqual(0);
      if (attempt.used_tokens !== null) expect(attempt.used_tokens).toBeGreaterThanOrEqual(0);
      expect(attempt.usage_complete).toBe(attempt.used_tokens === null ? 0 : 1);
    }
    for (const numbers of ordinals.values()) expect(numbers.sort((a, b) => a - b)).toEqual(numbers.map((_, i) => i + 1));
    // The run's accounting is the sum of its attempts, and it only grows.
    expect(row.token_usage).toBe(attempts.reduce((sum, a) => sum + (a.used_tokens ?? 0), 0));
    expect(row.agent_calls).toBe(attempts.filter((a) => a.model_id !== null).length);
    const cost = store.costUsage(id);
    expect(Number.isFinite(cost.spentUsd) && cost.spentUsd >= 0).toBe(true);
    expect(Number.isFinite(cost.reservedUsd) && cost.reservedUsd >= 0).toBe(true);
    const last = host.seen.get(id) ?? { tokens: 0, calls: 0, cost: 0 };
    expect(row.token_usage).toBeGreaterThanOrEqual(last.tokens);
    expect(row.agent_calls).toBeGreaterThanOrEqual(last.calls);
    expect(cost.spentUsd + 1e-9).toBeGreaterThanOrEqual(last.cost);
    host.seen.set(id, { tokens: row.token_usage, calls: row.agent_calls, cost: cost.spentUsd });
    // Task states: a completed run finished every task; a fork plans the parent's tasks.
    const tasks = store.tasks(id);
    if (row.status === "completed") for (const t of tasks) expect(["implemented", "verified"]).toContain(t.status);
    if (run.parent !== null && tasks.length) {
      const parentTasks = store.tasks(host.ids[run.parent] as string).map((t) => t.id).sort();
      expect(tasks.map((t) => t.id).sort()).toEqual(parentTasks);
    }
  });
}

type Command = fc.AsyncCommand<Model, Host>;
const runIndex = fc.nat({ max: 3 });
/** The run a command addresses: commands name one of the runs the model knows. */
const pick = (model: Model, n: number) => n % model.runs.length;

class Approve implements Command {
  constructor(readonly n: number) {}
  check = (m: Readonly<Model>) => m.runs.some((r) => r.pending === "approval" && !terminal(r.status));
  async run(m: Model, h: Host) {
    const candidates = m.runs.flatMap((r, i) => (r.pending === "approval" && !terminal(r.status) ? [i] : []));
    const i = candidates[this.n % candidates.length] as number;
    const id = h.ids[i] as string;
    const request = h.store.requests(id).find((r) => r.kind === "approval" && r.status === "pending");
    expect(request).toBeDefined();
    if (!request) return;
    await h.service.decide(id, h.command(id), { kind: "approve", requestId: request.id, digest: request.digest });
    const run = m.runs[i] as RunModel;
    run.approved = true;
    run.pending = null;
    await driveAndSettle(h, m, i);
  }
  toString = () => `approve(${this.n})`;
}

class Resume implements Command {
  constructor(readonly n: number) {}
  check = () => true;
  async run(m: Model, h: Host) {
    const i = pick(m, this.n);
    const run = m.runs[i] as RunModel;
    const id = h.ids[i] as string;
    // A terminal run is historical, and a pending request is decided before the run goes on.
    if (terminal(run.status) || run.pending) return refused(h, m, i, () => h.service.resume(id, h.command(id)));
    await h.service.resume(id, h.command(id));
    await driveAndSettle(h, m, i);
  }
  toString = () => `resume(${this.n})`;
}

class Extend implements Command {
  constructor(readonly n: number) {}
  check = () => true;
  async run(m: Model, h: Host) {
    const i = pick(m, this.n);
    const run = m.runs[i] as RunModel;
    const id = h.ids[i] as string;
    // Only a run that stopped on its budget can be extended.
    if (run.status !== "blocked" || run.reason !== "budget_exhausted")
      return refused(h, m, i, () => h.service.extendBudget(id, h.command(id)));
    const extended = await h.service.extendBudget(id, h.command(id));
    expect([extended.status, extended.reason]).toEqual(["paused", "none"]);
    await h.service.resume(id, h.command(id));
    await driveAndSettle(h, m, i);
  }
  toString = () => `extend(${this.n})`;
}

class Pause implements Command {
  constructor(readonly n: number) {}
  check = () => true;
  async run(m: Model, h: Host) {
    const i = pick(m, this.n);
    const run = m.runs[i] as RunModel;
    const id = h.ids[i] as string;
    if (terminal(run.status)) return refused(h, m, i, () => h.service.pause(id, h.command(id)));
    await h.service.pause(id, h.command(id));
    run.status = "paused";
    run.reason = "user_pause";
    check(h, m);
  }
  toString = () => `pause(${this.n})`;
}

class Cancel implements Command {
  constructor(readonly n: number) {}
  check = () => true;
  async run(m: Model, h: Host) {
    const i = pick(m, this.n);
    const run = m.runs[i] as RunModel;
    const id = h.ids[i] as string;
    if (terminal(run.status)) return refused(h, m, i, () => h.service.cancel(id, h.command(id)));
    await h.service.cancel(id, h.command(id));
    run.status = "cancelled";
    check(h, m);
  }
  toString = () => `cancel(${this.n})`;
}

class Fork implements Command {
  constructor(readonly n: number) {}
  check = (m: Readonly<Model>) => m.runs.length < 4;
  async run(m: Model, h: Host) {
    const i = pick(m, this.n);
    const parent = m.runs[i] as RunModel;
    const id = h.ids[i] as string;
    const child = await h.service.fork(id, h.command(id));
    h.ids.push(child.runId);
    // A fork starts again at the analysis on the parent's models and budget, without its approval.
    m.runs.push({ parent: i, status: "created", reason: "none", tight: parent.tight, approved: false, pending: null, model: parent.model, routings: h.store.latestArtifact(child.runId, ROUTING_ARTIFACT)?.revision ?? 0 });
    check(h, m);
  }
  toString = () => `fork(${this.n})`;
}

class Reroute implements Command {
  constructor(
    readonly n: number,
    readonly target: string,
  ) {}
  check = () => true;
  async run(m: Model, h: Host) {
    const i = pick(m, this.n);
    const run = m.runs[i] as RunModel;
    const id = h.ids[i] as string;
    // A terminal run cannot move, and moving to the model it already uses changes nothing.
    if (terminal(run.status) || run.model === this.target)
      return refused(h, m, i, () => h.service.reroute(id, h.command(id), { model: this.target }));
    await h.service.reroute(id, h.command(id), { model: this.target });
    run.model = this.target;
    run.routings++;
    check(h, m);
  }
  toString = () => `reroute(${this.n}, ${this.target})`;
}

class WorkerCrash implements Command {
  check = (m: Readonly<Model>) => !m.armed;
  async run(m: Model, h: Host) {
    h.executor.armed = true;
    m.armed = true;
    check(h, m);
  }
  toString = () => "workerCrash";
}

class Restart implements Command {
  check = () => true;
  async run(m: Model, h: Host) {
    await h.restart();
    check(h, m);
  }
  toString = () => "restart";
}

// Approve, resume and extend move runs forward, so they come up more often than the others.
const commands = [
  runIndex.map((n) => new Approve(n)),
  runIndex.map((n) => new Approve(n)),
  runIndex.map((n) => new Approve(n)),
  runIndex.map((n) => new Resume(n)),
  runIndex.map((n) => new Resume(n)),
  runIndex.map((n) => new Extend(n)),
  runIndex.map((n) => new Extend(n)),
  runIndex.map((n) => new Pause(n)),
  runIndex.map((n) => new Cancel(n)),
  runIndex.map((n) => new Fork(n)),
  fc.tuple(runIndex, fc.constantFrom(MODEL_A, MODEL_B)).map(([n, target]) => new Reroute(n, target)),
  fc.constant(new WorkerCrash()),
  fc.constant(new Restart()),
];

describe("scheduler model (#1721)", () => {
  test("random command sequences keep run states, attempt lineage, reservations and accounting consistent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.commands(commands, { maxCommands: 12 }), async (isTight, sequence) => {
        const host = new Host();
        try {
          // Start, as `baked workflow start` does: the run is created and driven to its plan approval.
          const started = await host.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: isTight ? tight : roomy });
          host.ids.push(started.runId);
          const model: Model = {
            runs: [{ parent: null, status: "created", reason: "none", tight: isTight, approved: false, pending: null, model: MODEL_A, routings: host.store.latestArtifact(started.runId, ROUTING_ARTIFACT)?.revision ?? 0 }],
            armed: false,
          };
          check(host, model);
          await driveAndSettle(host, model, 0);
          await fc.asyncModelRun(() => ({ model, real: host }), sequence);
        } finally {
          await host.dispose();
        }
      }),
      { numRuns: 25 },
    );
  }, 180_000);
});
