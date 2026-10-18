import { afterEach, describe, expect, test } from "bun:test";
import { LocalCoordinator } from "../src/core/chat/coordinator-host.js";
import { ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import { WorkflowClient, type WorkflowClientOptions } from "../src/core/workers/workflow-client.js";
import { talkToCoordinator } from "../src/headless/coordinator-chat.js";
import { newId } from "../src/core/workflows/store.js";
import { InitiativeStore } from "../src/core/workflows/initiatives/store.js";
import type { AppConfig } from "../src/types/index.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Replace only the worker entry point, during construction. WorkflowClient's watcher,
// onStalled close notification and stalledOwners handoff all remain production code.
class ScriptedClient extends WorkflowClient {
  commands: string[][] = [];
  constructor(workspace: string, config: AppConfig, hang: boolean, uncertain: boolean,
    exitedOwners: string[] = [], options: WorkflowClientOptions = {}, rejectResume = false) {
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(_url: string | URL, workerOptions?: WorkerOptions) {
        super(`${import.meta.dir}/helpers/coordinator-stalled-worker.ts`, {
          ...workerOptions,
          env: { ...process.env, COORDINATOR_TEST_HANG: hang ? "1" : "0",
            COORDINATOR_TEST_UNCERTAIN: uncertain ? "1" : "0",
            COORDINATOR_TEST_REJECT_RESUME: rejectResume ? "1" : "0" },
        });
      }
    };
    try { super(workspace, config, exitedOwners, undefined, options); }
    finally { globalThis.Worker = NativeWorker; }
  }
  get leaseOwner(): string | null { return Reflect.get(this, "owner") as string | null; }
  override async command(...args: Parameters<WorkflowClient["command"]>) {
    this.commands.push(args[0]);
    return super.command(...args);
  }
  async stopWorker() {
    if (this.closed) return;
    const closed = new Promise<void>((resolve) => this.worker.addEventListener("close", resolve));
    this.worker.terminate();
    await closed;
    this.close();
  }
}

async function waitFor(read: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!read() && Date.now() < deadline) await Bun.sleep(20);
}

async function scenario(options: { autoResumes?: number; graceMs?: number; uncertain?: boolean; peer?: "same" | "foreign"; rejectResume?: boolean } = {}) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  fixture.config.workflows.stall.autoResumes = options.autoResumes ?? 3;
  Object.assign(fixture.config, { coordinator: { wake: false } });
  const clients: ScriptedClient[] = [];
  const createClient = (exitedOwners: string[] = [], clientOptions: WorkflowClientOptions = {}) => {
    const client = new ScriptedClient(fixture.root, fixture.config, clients.length === 0, options.uncertain ?? false, exitedOwners, clientOptions, clients.length > 0 && (options.rejectResume ?? false));
    clients.push(client);
    return client;
  };
  // The fixed client is also supplied so this scenario exercises the old path on origin/main.
  const first = createClient([], { supervisor: { pollMs: 50, graceMs: options.graceMs ?? 100 } });
  let initial = true;
  const local = await LocalCoordinator.open({
    workspace: fixture.root, config: fixture.config, client: first,
    supervisor: { createClient: (exitedOwners, clientOptions) => {
      if (initial) { initial = false; return first; }
      return createClient(exitedOwners, clientOptions);
    }, pollMs: 50, graceMs: options.graceMs ?? 100 },
    model: () => "fixture/model", homeDir: fixture.root, watchMs: 0,
    host: new ScriptedChatHost({ delayMs: 1, turns: [
      { steps: [{ tool: "start_run", run: true, input: { prompt: "Create ready value", feature: "fixture", workflow: "sdd", why: "Ship it" } }] },
      { steps: [{ text: "Following the run." }] },
      { steps: [{ tool: "start_run", run: true, input: { prompt: "Create ready value", feature: "next", workflow: "sdd", why: "More work" } }] },
    ] }),
  });
  cleanups.push(async () => {
    await local.close();
    for (const client of clients) await client.stopWorker();
  });
  const output: string[] = [];
  const io = { out: (text: string) => output.push(text), err: () => {}, ask: null };
  const opts = { json: true, yes: true, follow: false };
  expect(await talkToCoordinator(local.chat, local.session, "Start a run", opts, io, 10)).toBe(0);
  const runId = local.chat.launched(local.session.id)[0]?.id ?? "";
  await waitFor(() => fixture.service.store.run(runId).status === "waiting");
  let peerId: string | null = null;
  if (options.peer) {
    const peer = await fixture.start("peer");
    peerId = peer.runId;
    fixture.service.store.transition(peerId, "running", "none");
    fixture.service.store.putLease({
      resource: "execution:peer", owner_id: options.peer === "same" ? first.leaseOwner! : newId(),
      owner_epoch: 1, run_id: peerId, expires_at: Date.now() - 1,
      process_identity_json: JSON.stringify({ pid: process.pid }),
    });
  }
  await fixture.approve(runId);
  const driving = first.command(["resume", runId, "--expected-revision", String(fixture.service.store.run(runId).revision)], new AbortController().signal).catch(() => {});
  await waitFor(() => fixture.service.store.events(runId, 0, 100_000).some((e) => e.type === "tool.started"));
  return { fixture, local, runId, peerId, first, clients, driving, output, io, opts };
}

describe("scenario: headless coordinator replaces a stalled workflow worker (#1554)", () => {
  test("follow finishes after takeover and the same coordinator launches through the replacement", async () => {
    const s = await scenario();
    const following = talkToCoordinator(s.local.chat, s.local.session, "Follow it", { ...s.opts, follow: true }, s.io, 10);
    try {
      await waitFor(() => s.fixture.service.store.run(s.runId).status === "completed");
      expect(s.fixture.service.store.run(s.runId).status).toBe("completed");
    } finally {
      // Let follow exit even on origin/main, where the stopped worker leaves the run running.
      if (s.fixture.service.store.run(s.runId).status === "running")
        s.fixture.service.store.transition(s.runId, "cancelled", "none");
      await following;
    }
    expect(s.first.closed).toBe(true);
    expect(s.clients).toHaveLength(2);
    expect(s.clients[1]?.commands).toEqual([]);
    expect(s.first.exitedOwner).toBe(s.first.stalledOwner);
    expect(s.first.stalledOwner).toBeTruthy();
    expect(s.fixture.service.store.state(s.runId).stallResumes).toBe(1);
    expect(s.fixture.service.store.latestArtifact(s.runId, "stalled/takeover-1.json")).not.toBeNull();
    await s.driving;
    expect(JSON.parse(s.output.at(-1) ?? "{}").launched[0].status).toBe("completed");
    expect(await talkToCoordinator(s.local.chat, s.local.session, "Start another", s.opts, s.io, 10)).toBe(0);
    expect(s.clients[1]?.commands.some((args) => args[0] === "run" && args.includes("next"))).toBe(true);
  }, 60_000);

  test("autoResumes zero blocks for a person without replaying the launch", async () => {
    const s = await scenario({ autoResumes: 0 });
    await waitFor(() => s.fixture.service.store.run(s.runId).status === "blocked");
    expect(s.fixture.service.store.run(s.runId)).toMatchObject({ status: "blocked", reason: "step_stalled" });
    expect(s.clients[1]?.commands).toEqual([]);
    expect(s.fixture.service.store.state(s.runId).stallResumes).toBe(0);
  }, 60_000);

  test("an unknown command outcome still requires recovery instead of automatic execution", async () => {
    const s = await scenario({ uncertain: true });
    await waitFor(() => s.fixture.service.store.run(s.runId).status === "waiting");
    expect(s.fixture.service.store.run(s.runId)).toMatchObject({ status: "waiting", reason: "interrupted_effect" });
    expect(s.clients[1]?.commands).toEqual([]);
    expect(s.fixture.service.store.requests(s.runId).some((r) => r.kind === "recovery" && r.status === "pending")).toBe(true);
  }, 60_000);

  test("supervisorGraceMs zero leaves the worker unsupervised", async () => {
    const s = await scenario({ graceMs: 0 });
    await Bun.sleep(300);
    expect(s.fixture.service.store.run(s.runId).status).toBe("running");
    expect(s.clients).toHaveLength(1);
    expect(s.first.closed).toBe(false);
  }, 60_000);

  test("another worker's expired lease in the same host is never taken over", async () => {
    const s = await scenario({ peer: "foreign" });
    await waitFor(() => s.fixture.service.store.run(s.runId).status === "completed");
    expect(s.fixture.service.store.run(s.runId).status).toBe("completed");
    expect(s.fixture.service.store.run(s.peerId!).status).toBe("running");
    expect(s.fixture.service.store.latestArtifact(s.peerId!, "stalled/takeover-1.json")).toBeNull();
    expect(s.clients[1]?.commands).toEqual([]);
  }, 60_000);

  test("other running runs owned by the stopped worker also recover", async () => {
    const s = await scenario({ peer: "same" });
    await waitFor(() => s.fixture.service.store.latestArtifact(s.peerId!, "stalled/takeover-1.json") !== null);
    expect(s.fixture.service.store.latestArtifact(s.peerId!, "stalled/takeover-1.json")).not.toBeNull();
    expect(s.clients[1]?.commands).toEqual([]);
    expect(s.fixture.service.store.state(s.peerId!).stallResumes).toBe(1);
  }, 60_000);

  test("a failed recovery drive does not prevent the coordinator from launching another run", async () => {
    const s = await scenario({ rejectResume: true });
    const recorded = () => s.clients[1]?.driveError(s.runId) === "Recovery drive failed";
    await waitFor(recorded);
    expect(recorded()).toBe(true);
    await talkToCoordinator(s.local.chat, s.local.session, "Continue", s.opts, s.io, 10);
    expect(await talkToCoordinator(s.local.chat, s.local.session, "Start another", s.opts, s.io, 10)).toBe(0);
    expect(s.clients[1]?.commands.some((args) => args[0] === "run" && args.includes("next"))).toBe(true);
  }, 60_000);

  test("a stalled initiative decomposer continues through the initiative drive", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const clients: ScriptedClient[] = [];
    const createClient = (exitedOwners: string[] = [], clientOptions: WorkflowClientOptions = {}) => {
      const client = new ScriptedClient(fixture.root, fixture.config, clients.length === 0, false, exitedOwners, clientOptions);
      clients.push(client);
      return client;
    };
    const first = createClient([], { supervisor: { pollMs: 50, graceMs: 100 } });
    let initial = true;
    const local = await LocalCoordinator.open({
      workspace: fixture.root, config: fixture.config, client: first,
      supervisor: { createClient: (exitedOwners, clientOptions) => { if (initial) { initial = false; return first; } return createClient(exitedOwners, clientOptions); }, pollMs: 50, graceMs: 100 },
      model: () => "fixture/model", homeDir: fixture.root, watchMs: 0,
      host: new ScriptedChatHost({ turns: [] }),
    });
    cleanups.push(async () => { await local.close(); for (const client of clients) await client.stopWorker(); });
    await first.startInitiative({ initiativeId: "values", prompt: "Create three values" });
    const initiatives = new InitiativeStore(fixture.service.store);
    await waitFor(() => initiatives.list()[0]?.status === "awaiting_approval");
    expect(initiatives.list()[0]?.status).toBe("awaiting_approval");
    expect(clients).toHaveLength(2);
    expect(clients[1]?.commands).toEqual([]);
    const runId = initiatives.list()[0]?.decompose_run_id ?? "";
    expect(fixture.service.store.run(runId).status).toBe("completed");
    expect(fixture.service.store.state(runId).stallResumes).toBe(1);
  }, 60_000);
});
