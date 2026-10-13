import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { BriefStore } from "../src/core/chat/coordinator.js";
import {
  chooseWorkflow,
  renderWorkflows,
  resolveControl,
  type WorkflowCatalog,
  wakePrompt,
  workflowCard,
} from "../src/core/chat/coordinator-launch.js";
import type { ProjectStateSource } from "../src/core/chat/project-state.js";
import { ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import {
  type ChatAgentHost,
  type ChatEvent,
  ChatService,
  type ChatSession,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import type { DefinitionSummary } from "../src/core/workflows/v2/definitions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Result = { success: boolean; output: string; error?: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" };
            yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 1 } };
          })(),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }
  release() {}
  async dispose() {}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(host: ChatAgentHost, wake = true) {
  const fixture = workflowFixture();
  const chat = new ChatService({
    workspace: fixture.root,
    config: {
      ...fixture.service.config,
      defaultModel: "openai/gpt-test",
      coordinator: { wake },
    },
    host,
    homeDir: fixture.root,
  });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const coordinator = await chat.coordinator(true);
  if (!coordinator) throw new Error("no coordinator");
  return { fixture, chat, coordinator, server };
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(20);
  }
}

const summary = (id: string, extra: Partial<DefinitionSummary> = {}): DefinitionSummary => ({
  id,
  schemaVersion: 2,
  source: "builtin",
  preset: id,
  description: `The ${id} workflow`,
  stages: ["spec", "plan", "tasks", "check"],
  line: { stages: [], loops: [] },
  writes: true,
  problems: [],
  execution: null,
  worktreeRefusal: null,
  ...extra,
});

const catalog: WorkflowCatalog = {
  list: () => [
    summary("sdd"),
    summary("fix-ci", { stages: ["reproduce", "tasks", "check"] }),
    summary("broken", { source: "project", problems: ["no check stage"] }),
  ],
  propose: () => ({
    workflowId: "fix-ci",
    budget: "standard",
    kind: "ci-fix",
    confidence: "high",
    reason: "a failing check: reproduce it, fix and rerun the same checks",
    signals: ["tests", "failing"],
  }),
};

describe("coordinator workflows", () => {
  test("a suggested workflow runs after the card, shows live, and its news wakes the coordinator", async () => {
    // The scripted coordinator: a turn that starts a workflow run through its real tool, then the
    // turn the wake-up on that run starts.
    const host = new ScriptedChatHost({
      delayMs: 1,
      turns: [
        {
          steps: [
            { text: "This changes code, so a workflow fits." },
            {
              tool: "start_run",
              run: true,
              input: { prompt: "Create ready value", feature: "fixture", workflow: "sdd", why: "Ship the value" },
            },
          ],
        },
        { steps: [{ text: "The sdd run waits for your approval of its plan. Shall I approve it?" }] },
      ],
    });
    const { fixture, chat, coordinator } = await serve(host);
    const events: ChatEvent[] = [];
    coordinator.subscribe(coordinator.detail().lastSeq, (event) => events.push(event));

    coordinator.send("Fix the value; the check fails");
    const card = await until(
      () => coordinator.pendingPrompts.find((p) => p.kind === "workflow"),
      (p) => p !== undefined,
    );
    if (card?.kind !== "workflow") throw new Error("no workflow card");
    expect(card).toMatchObject({ workflow: "sdd", prompt: "Create ready value", why: "Ship the value", writes: true });
    expect(card.stages).toContain("specify");
    // Nothing starts before the user says yes.
    expect((await fixture.service.list({ limit: 10 })).items).toEqual([]);
    expect(() => coordinator.answer(card.id, { approve: true, digest: "stale" })).toThrow("digest");
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    await coordinator.settled();

    const [run] = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(run).toMatchObject({ kind: "run", workflow: "sdd", why: "Ship the value" });
    const runId = run?.id ?? "";
    expect((await fixture.service.list({ limit: 10 })).items.map((r) => r.runId)).toEqual([runId]);

    // The run stops at its approval: a notice, then a turn the user did not type.
    const notices = await until(
      () => chat.syncLaunched(),
      (n) => n.length > 0,
    );
    expect(notices).toEqual([`run ${runId}: waiting: approval (Ship the value)`]);
    await until(
      () => coordinator.messages.filter((m) => m.role === "assistant").length,
      (n) => n >= 2,
    );
    await coordinator.settled();
    const wake = coordinator.messages.find((m) => m.role === "user" && m.showInChat === false);
    expect(wake?.content).toContain(`- run ${runId}: waiting: approval (Ship the value)`);
    expect(wake?.content).toContain("Take control back");
    expect(coordinator.messages.at(-1)?.content).toBe(
      "The sdd run waits for your approval of its plan. Shall I approve it?",
    );
    expect(coordinator.detail().queued).toEqual([]);

    // The panel follows the run's stages from `launched` events, not by polling.
    const launched = events.filter((e) => e.type === "launched").at(-1);
    if (launched?.type !== "launched") throw new Error("no launched event");
    const progress = launched.launched[0]?.progress;
    expect(progress?.stages.length).toBeGreaterThan(1);
    expect(progress?.stages.map((s) => s.id)).toContain("specify");

    // Nothing changed: no second wake-up.
    expect(await chat.syncLaunched()).toEqual([]);
    expect(coordinator.messages.filter((m) => m.showInChat === false)).toHaveLength(1);
  }, 60_000);

  test("coordinator.wake false keeps the notice and starts no turn", async () => {
    const host = new RecordingHost();
    const { fixture, chat, coordinator } = await serve(host, false);
    const tools = () => (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
    coordinator.send("hello");
    await coordinator.settled();
    const pending = tools().start_run?.execute({ prompt: "Create ready value", feature: "fixture", why: "Ship" });
    const card = await until(() => coordinator.pendingPrompts[0], (p) => p !== undefined);
    if (card?.kind !== "workflow") throw new Error("no workflow card");
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    expect(await pending).toMatchObject({ success: true });
    await until(() => chat.syncLaunched(), (n) => n.length > 0);
    expect(coordinator.state).toBe("idle");
    expect(host.requests).toHaveLength(1);
    expect((await fixture.service.list({ limit: 10 })).items).toHaveLength(1);
  }, 60_000);

  test("control_run approves a launched run's request only after the user's yes", async () => {
    const host = new RecordingHost();
    const { fixture, chat, coordinator } = await serve(host, false);
    coordinator.send("hello");
    await coordinator.settled();
    const tool = (name: string) => {
      const found = ((host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>)[name];
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    const answerNext = async (session: ChatSession, approve: boolean) => {
      const prompt = await until(() => session.pendingPrompts[0], (p) => p !== undefined);
      if (!prompt) throw new Error("no prompt");
      session.answer(prompt.id, "digest" in prompt ? { approve, digest: prompt.digest } : { approve });
      return prompt;
    };
    const started = tool("start_run").execute({ prompt: "Create ready value", feature: "fixture", why: "Ship" });
    await answerNext(coordinator, true);
    await started;
    const runId = new BriefStore(chat.workspace, coordinator.id).read().launched[0]?.id ?? "";
    await until(() => chat.syncLaunched(), (n) => n.length > 0);

    expect(await tool("control_run").execute({ runId: "someone-else", action: "cancel" })).toMatchObject({
      success: false,
      error: "Run someone-else was not launched by you; the user controls it in Runs",
    });

    const declined = tool("control_run").execute({ runId, action: "approve" });
    const card = await answerNext(coordinator, false);
    expect(card).toMatchObject({ kind: "destructive", description: `Approve the approval of run ${runId}` });
    expect(await declined).toMatchObject({ success: false });
    expect(fixture.service.store.requests(runId).filter((r) => r.status === "pending")).toHaveLength(1);

    const approved = tool("control_run").execute({ runId, action: "approve" });
    await answerNext(coordinator, true);
    expect(await approved).toMatchObject({ success: true });
    const after = await until(
      () => chat.launched(coordinator.id)[0]?.status ?? "",
      (status) => !status.startsWith("waiting: approval"),
    );
    expect(after).not.toContain("approval");
  }, 60_000);
});

describe("workflow choice", () => {
  test("a named workflow must exist and be able to start; without one the proposal is used", () => {
    expect(chooseWorkflow(catalog, "x", "sdd")).toMatchObject({ id: "sdd", reason: "chosen for this request" });
    expect(chooseWorkflow(catalog, "x", "nope")).toEqual({
      problem: "There is no workflow nope; the project has sdd, fix-ci",
    });
    expect(chooseWorkflow(catalog, "x", "broken")).toEqual({
      problem: "Workflow broken cannot start: no check stage. Pick one of sdd, fix-ci",
    });
    const proposed = chooseWorkflow(catalog, "the tests are failing", undefined);
    expect(proposed).toMatchObject({ id: "fix-ci", reason: "a failing check: reproduce it, fix and rerun the same checks" });
    if ("problem" in proposed) throw new Error("no workflow");
    const card = workflowCard(proposed, "Fix the tests", "CI is red", "acme/widget#5");
    expect(card).toMatchObject({
      kind: "workflow",
      workflow: "fix-ci",
      stages: ["reproduce", "tasks", "check"],
      issue: "acme/widget#5",
    });
    // The digest binds the card to the workflow and the request.
    expect(workflowCard(proposed, "Fix the tests", "other why", "acme/widget#5").digest).toBe(card.digest);
    expect(workflowCard(proposed, "Fix other tests", "CI is red", "acme/widget#5").digest).not.toBe(card.digest);
  });

  test("the workflow list names stages, writes and problems, with the proposal first", () => {
    const text = renderWorkflows(catalog, "tests are failing");
    expect(text.split("\n")[0]).toBe(
      "Proposed for this request: fix-ci (a failing check: reproduce it, fix and rerun the same checks; high confidence, budget standard)",
    );
    expect(text).toContain("- sdd (built in, writes files): The sdd workflow. Stages: spec > plan > tasks > check.");
    expect(text).toContain("- broken (project, writes files): The broken workflow. Stages: spec > plan > tasks > check. CANNOT START: no check stage");
  });

  test("a control names the pending request and refuses what the user answers in the run", () => {
    const state = (pending: { id: string; kind: string; digest?: string }[]) =>
      ({ run: () => ({ pendingRequests: pending }) }) as unknown as ProjectStateSource;
    const control = (s: ProjectStateSource, action: "approve" | "reject" | "cancel", reason?: string) =>
      resolveControl(s, { runId: "r1", action, requestId: undefined, reason });
    expect(control(state([]), "cancel").input).toEqual({ runId: "r1", action: "cancel" });
    expect(() => control(state([]), "approve")).toThrow("waits for nothing");
    expect(control(state([{ id: "q1", kind: "approval", digest: "d1" }]), "approve").input).toEqual({
      runId: "r1",
      action: "approve",
      requestId: "q1",
      digest: "d1",
    });
    expect(() => control(state([{ id: "q1", kind: "clarification" }]), "approve")).toThrow("answers it in the run");
    expect(() => control(state([{ id: "q1", kind: "approval" }]), "reject")).toThrow("reason");
    expect(() =>
      control(state([{ id: "q1", kind: "approval" }, { id: "q2", kind: "delivery" }]), "approve"),
    ).toThrow("several pending requests");
  });

  test("the wake-up lists the news and hands control back", () => {
    const text = wakePrompt(["run r1: completed (Ship)", "session s1: done (Survey)"]);
    expect(text).toContain("BAKED sent this, not the user");
    expect(text).toContain("- run r1: completed (Ship)\n- session s1: done (Survey)");
    expect(text).toContain("use control_run only after they say yes");
  });
});
