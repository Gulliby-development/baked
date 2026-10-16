import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { BriefStore, coordinatorInstructions } from "../src/core/chat/coordinator.js";
import {
  chatsProblem,
  type FlowTask,
  githubTasks,
  pathsOverlap,
  type SplitRequest,
  splitShape,
  syncLaunched,
  type TaskTracker,
  wakeLine,
} from "../src/core/chat/coordinator-launch.js";
import { PEER_TOOL, parsePeerMessage } from "../src/core/chat/peer-messages.js";
import { describePrompt, type ProjectStateSource, renderState } from "../src/core/chat/project-state.js";
import { type ChatAgentHost, ChatService, type ChatSession, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import type { CoordinatorWorkStyle } from "../src/types/index.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async ({ messages }: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            if (JSON.stringify(messages.at(-1)?.content ?? "").includes("[fail]"))
              throw new Error("The model lost its tools\nstack line");
            // A brief with "[ask]" asks the person a question mid-turn, as a session's ask tool does.
            if (JSON.stringify(messages.at(-1)?.content ?? "").includes("[ask]")) {
              const picked = await request.callbacks.onAskUser(
                "Which palette?",
                [
                  { label: "Warm", value: "warm" },
                  { label: "Cool", value: "cool" },
                ],
                false,
              );
              yield { type: "text-delta", text: `picked ${picked}` };
            } else yield { type: "text-delta", text: "done" };
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

type Result = { success: boolean; output: string; error?: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(maxActive = 3, tasks?: TaskTracker, wake = false, workStyle?: CoordinatorWorkStyle) {
  const fixture = workflowFixture();
  const host = new RecordingHost();
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test", coordinator: { maxActive, wake, ...(workStyle ? { workStyle } : {}) } },
    host,
    homeDir: fixture.root,
  });
  const server = await startApiServer({
    service: fixture.service,
    chat,
    pollMs: 20,
    log: () => {},
    ...(tasks ? { tasks } : {}),
  });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const coordinator = await chat.coordinator(true);
  if (!coordinator) throw new Error("no coordinator");
  coordinator.send("plan the week");
  await coordinator.settled();
  const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
  const tool = (name: string): Tool => {
    const found = tools[name];
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { fixture, chat, host, coordinator, tool, server };
}

/** Approves the "Run workflow?" card a pending start_run shows, then waits for the tool. */
async function approveWorkflow(coordinator: ChatSession, pending: Promise<Result>): Promise<Result> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const card = coordinator.pendingPrompts.find((p) => p.kind === "workflow");
    if (card?.kind === "workflow") {
      coordinator.answer(card.id, { approve: true, digest: card.digest });
      return pending;
    }
    if (Date.now() > deadline) throw new Error("no workflow card");
    await Bun.sleep(10);
  }
}

/** Syncs until a notice matching `pattern` arrives. */
async function noticeFor(chat: ChatService, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = (await chat.syncLaunched()).find((n) => pattern.test(n));
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`No notice matching ${pattern}`);
}

describe("coordinator launches", () => {
  test("threads write to their coordinator and to each other, marked as theirs", async () => {
    const { chat, host, coordinator, tool } = await setup();
    const start = async (title: string) => {
      const out = await tool("launch_session").execute({ title, brief: `Do ${title}`, mode: "architect", why: title });
      const id = /session ([0-9a-f-]{36})/.exec(out.output)?.[1] ?? "";
      await chat.get(id).settled();
      return id;
    };
    const api = await start("API");
    const ui = await start("UI");
    // A turn of API after UI exists, so it is told about its sibling.
    chat.get(api).send("Continue");
    await chat.get(api).settled();
    const request = host.requests.filter((r) => r.sessionId === api).at(-1);
    expect(request?.instructions).toContain(`"UI" (${ui})`);
    const send = (request?.tools ?? {})[PEER_TOOL] as Tool;

    expect(await send.execute({ to: "coordinator", text: "API is done." })).toMatchObject({ success: true });
    await coordinator.settled();
    const toCoordinator = coordinator.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    expect(parsePeerMessage(toCoordinator)).toEqual({ title: "API", id: api, text: "API is done." });

    expect(await send.execute({ to: ui, text: "Use /v2." })).toMatchObject({ success: true });
    await chat.get(ui).settled();
    expect(chat.get(ui).messages.filter((m) => m.role === "user").at(-1)?.content).toBe(
      `Message from session "API" (${api}):\n\nUse /v2.`,
    );

    const stranger = await chat.create({ title: "Other" });
    expect(await send.execute({ to: stranger.id, text: "Hi" })).toMatchObject({ success: false });
    // An ordinary chat gets no message tool, only the gate tools every chat has.
    stranger.send("Hello");
    await stranger.settled();
    expect(Object.keys(host.requests.filter((r) => r.sessionId === stranger.id).at(-1)?.tools ?? {})).toEqual([
      "list_gates",
      "save_gates",
    ]);
    for (let i = 0; i < 3; i++) await send.execute({ to: "coordinator", text: `note ${i}` });
    expect((await send.execute({ to: "coordinator", text: "too many" })).error).toContain("At most 5");
    await coordinator.settled();
  }, 60000);

  test("message_session sends a launched session a follow-up and its answer comes back", async () => {
    const { chat, coordinator, tool } = await setup();
    const launched = await tool("launch_session").execute({
      title: "Survey the auth code",
      brief: "List every place that checks a token.",
      mode: "architect",
      why: "Find the token checks",
    });
    const sessionId = /session ([0-9a-f-]{36})/.exec(launched.output)?.[1] ?? "";
    await chat.get(sessionId).settled();
    expect(await noticeFor(chat, /^Session/)).toBe('Session "Survey the auth code": done');

    const stranger = await chat.create({ title: "Someone else's chat" });
    expect(await tool("message_session").execute({ id: stranger.id, text: "Hi" })).toMatchObject({
      success: false,
      error: expect.stringContaining("not one you launched"),
    });

    const sent = await tool("message_session").execute({ id: sessionId, text: "Also check the CLI." });
    expect(sent).toMatchObject({ success: true });
    const session = chat.get(sessionId);
    await session.settled();
    expect(session.messages.filter((m) => m.role === "user").at(-1)?.content).toBe(
      "Message from the project coordinator:\n\nAlso check the CLI.",
    );
    // Even when the follow-up's turn ends between two checks, its new answer is reported.
    expect(await noticeFor(chat, /^Session/)).toBe('Session "Survey the auth code": done');
    const notes = coordinator.messages.filter((m) => m.launch?.id === sessionId);
    expect(notes).toHaveLength(2);
    expect(notes.at(-1)?.launch).toMatchObject({ status: "done", result: "done" });
    expect(await chat.syncLaunched()).toEqual([]);
  }, 60000);

  test("a background session and a run show in their lists and report back", async () => {
    const { fixture, chat, coordinator, tool, server } = await setup();

    const session = await tool("launch_session").execute({
      title: "Survey the auth code",
      brief: "List every place that checks a token.",
      mode: "architect",
      why: "Find the token checks",
    });
    expect(session).toMatchObject({ success: true });
    const sessionId = /session ([0-9a-f-]{36})/.exec(session.output)?.[1] ?? "";
    // It is the coordinator's thread: listed with its parent, so front ends group it there.
    expect(chat.list().find((s) => s.id === sessionId)?.parentId).toBe(coordinator.id);
    await chat.get(sessionId).settled();
    expect(await noticeFor(chat, /^Session/)).toBe('Session "Survey the auth code": done');

    const run = await approveWorkflow(coordinator, tool("start_run").execute({ prompt: "Create ready value", feature: "fixture", why: "Ship the value" }));
    expect(run).toMatchObject({ success: true });
    const runId = /run ([0-9a-f-]{36})/.exec(run.output)?.[1] ?? "";
    expect((await fixture.service.list({ limit: 10 })).items.map((r) => r.runId)).toContain(runId);
    expect(await noticeFor(chat, /^Run/)).toBe('Run "Create ready value": waiting: approval');

    const brief = new BriefStore(chat.workspace, coordinator.id).read();
    expect(brief.launched.map((l) => [l.kind, l.id, l.status])).toEqual([
      ["session", sessionId, "done"],
      ["run", runId, "waiting: approval"],
    ]);
    const notices = coordinator.messages.filter((m) => m.role === "system");
    expect(notices.find((m) => m.launch?.kind === "run")).toMatchObject({
      content: 'Run "Create ready value": waiting: approval',
      launch: { kind: "run", id: runId, title: "Create ready value", status: "waiting: approval", why: "Ship the value", event: "status" },
    });
    // Nothing new: no second notice.
    expect(await chat.syncLaunched()).toEqual([]);

    const live = (await (
      await fetch(`${server.url}/v1/coordinator/launched`, { headers: { Authorization: `Bearer ${server.token}` } })
    ).json()) as { launched: { kind: string; id: string; status: string; active: boolean; tokens: number }[] };
    expect(live.launched.map((l) => [l.kind, l.status, l.active])).toEqual([
      ["session", "done", false],
      ["run", "waiting: approval", true],
    ]);
    expect(live.launched[0]?.tokens).toBeGreaterThan(0);
  }, 60000);

  test("a session whose turn failed reports why instead of idling", async () => {
    const { chat, tool } = await setup();
    const session = await tool("launch_session").execute({
      title: "Write the docs",
      brief: "[fail] Write docs/api.md.",
      mode: "architect",
      why: "Document the API",
    });
    const sessionId = /session ([0-9a-f-]{36})/.exec(session.output)?.[1] ?? "";
    await chat.get(sessionId).settled();
    expect(chat.get(sessionId).detail().lastError).toBe("The model lost its tools\nstack line");
    expect(await noticeFor(chat, /^Session/)).toBe('Session "Write the docs": failed: The model lost its tools');

    // A later turn that works clears it.
    chat.get(sessionId).send("Try again.");
    await chat.get(sessionId).settled();
    expect(chat.get(sessionId).detail().lastError).toBeUndefined();
    expect(await noticeFor(chat, /^Session/)).toBe('Session "Write the docs": done');
  }, 60000);

  test("with full access the coordinator starts a writing session at once, and passes it on", async () => {
    const { chat, coordinator, tool } = await setup();
    coordinator.update({ permissions: "full" });
    const launched = await tool("launch_session").execute({
      title: "Fix it",
      brief: "Fix the bug",
      mode: "default",
      why: "Fix",
    });
    expect(launched.success).toBe(true);
    expect(coordinator.pendingPrompts).toEqual([]);
    expect(chat.list().map((s) => [s.mode, s.permissions])).toEqual([["default", "full"]]);
  }, 60000);

  test("a writing session needs the user's yes, and the active limit holds", async () => {
    const { chat, coordinator, tool } = await setup(1);
    const declined = tool("launch_session").execute({
      title: "Fix it",
      brief: "Fix the bug",
      mode: "default",
      why: "Fix",
    });
    await Bun.sleep(10);
    const prompt = coordinator.pendingPrompts[0];
    if (!prompt || prompt.kind !== "destructive") throw new Error("no confirmation prompt");
    expect(prompt.description).toContain("default-mode session");
    coordinator.answer(prompt.id, { approve: false });
    expect(await declined).toMatchObject({ success: false, error: expect.stringContaining("declined") });
    expect(chat.list()).toEqual([]);

    const approved = tool("launch_session").execute({ title: "Fix it", brief: "Fix the bug", mode: "default", why: "Fix" });
    await Bun.sleep(10);
    const second = coordinator.pendingPrompts[0];
    if (!second) throw new Error("no confirmation prompt");
    coordinator.answer(second.id, { approve: true });
    expect((await approved).success).toBe(true);
    expect(chat.list().map((s) => s.mode)).toEqual(["default"]);

    // The launched session is still working on its first turn, so the limit of one is reached.
    const blocked = await tool("start_run").execute({ prompt: "Create ready value", why: "More" });
    expect(blocked.error ?? "").toContain("limit 1");
  }, 60000);
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

const flow = (id: string, paths: string[], dependsOn: string[] = []) => ({
  id,
  title: `Build ${id}`,
  boundary: { scope: `The ${id} part`, paths },
  contract: `${id} works`,
  dependsOn,
  mandatory: true,
});
const split = (flows: ReturnType<typeof flow>[]): SplitRequest => ({
  id: "checkout",
  title: "Checkout redesign",
  goals: ["A faster checkout"],
  completionCriteria: ["Checkout works end to end"],
  flows,
  why: "Too large for one run",
});

/** Waits until `session` has a pending prompt. */
async function promptOf(session: ChatSession) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const prompt = session.pendingPrompts[0];
    if (prompt) return prompt;
    if (Date.now() > deadline) throw new Error("no prompt");
    await Bun.sleep(10);
  }
}

describe("coordinator relays a session's question", () => {
  test("the launch note and project_state carry the question; answer_session passes the user's answer", async () => {
    const { chat, coordinator, tool } = await setup();
    const out = await tool("launch_session").execute({ title: "UI audit", brief: "Audit the UI [ask]", mode: "architect", why: "Audit" });
    const id = /session ([0-9a-f-]{36})/.exec(out.output)?.[1] ?? "";
    const session = chat.get(id);
    const prompt = await promptOf(session);

    expect(await noticeFor(chat, /waiting for you/)).toBe('Session "UI audit": waiting for you');
    const note = coordinator.messages.filter((m) => m.launch?.id === id).at(-1)?.launch;
    expect(note?.asks).toBe("Question: Which palette? Options: Warm; Cool.");
    expect(note && wakeLine(note)).toContain("It asks: Question: Which palette?");

    const view = renderState("session", id, null, {
      list: () => [],
      messages: () => ({ title: session.title, messages: session.messages, pending: session.pendingPrompts }),
    });
    expect(view).toContain(`- prompt ${prompt.id}: Question: Which palette? Options: Warm; Cool.`);

    const stranger = await chat.create({ title: "Other" });
    expect(await tool("answer_session").execute({ id: stranger.id, answer: "Warm" })).toMatchObject({ success: false });
    const answering = tool("answer_session").execute({ id, answer: "warm" });
    const confirm = await promptOf(coordinator);
    expect(confirm).toMatchObject({ kind: "destructive" });
    coordinator.answer(confirm.id, { approve: true });
    expect(await answering).toMatchObject({ success: true });
    await session.settled();
    expect(session.messages.at(-1)?.content).toBe("picked warm");
    expect(await tool("answer_session").execute({ id, answer: "Cool" })).toMatchObject({
      success: false,
      error: expect.stringContaining("waits for no answer"),
    });
  }, 60000);

  test("describePrompt names permissions and plans, which stay with the session", () => {
    const base = { id: "p", createdAt: 0 };
    expect(describePrompt({ ...base, kind: "destructive", description: "rm -rf dist" })).toBe("Permission: rm -rf dist");
    expect(
      describePrompt({ ...base, kind: "plan-review", title: "Fix nav", depth: "light", steps: [{ id: "1", label: "Edit nav" }], planFile: "p.md", content: "" }),
    ).toBe("Plan to review: Fix nav. Steps: Edit nav.");
  });
});

describe("coordinator starts parallel chats", () => {
  const chats = (paths: [string[], string[]], mode: "default" | "architect" = "default") => ({
    title: "Polish the site",
    why: "The user wants chats, not a workflow",
    chats: [
      { id: "home", title: "Home page", brief: "Polish the home page", mode, paths: paths[0] },
      { id: "docs", title: "Docs pages", brief: "Polish the docs pages", mode, paths: paths[1] },
    ],
  });

  test("editing chats must not write the same paths; reading chats may", () => {
    expect(chatsProblem(chats([["src/home/**"], ["src/docs/**"]]))).toBeNull();
    expect(chatsProblem(chats([["src/**"], ["src/docs/**"]]))).toContain("both write");
    expect(chatsProblem(chats([["src/**"], ["src/docs/**"]], "architect"))).toBeNull();
  });

  test("an approved card starts every chat and the coordinator follows them", async () => {
    const { fixture, chat, coordinator, tool } = await setup(5);
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");

    const rejected = tool("propose_chats").execute(chats([["src/home/**"], ["src/docs/**"]]));
    const card = await promptOf(coordinator);
    if (card.kind !== "split") throw new Error("no chats card");
    expect(card).toMatchObject({ mode: "chats", title: "Polish the site" });
    expect(card.flows.map((f) => f.task)).toEqual(["chat, edits files", "chat, edits files"]);
    coordinator.answer(card.id, { approve: false });
    expect(await rejected).toMatchObject({ success: false });
    const store = new BriefStore(chat.workspace, coordinator.id);
    expect(store.read().launched).toEqual([]);

    const approved = tool("propose_chats").execute(chats([["src/home/**"], ["src/docs/**"]]));
    const second = await promptOf(coordinator);
    if (second.kind !== "split") throw new Error("no chats card");
    coordinator.answer(second.id, { approve: true, digest: second.digest });
    expect(await approved).toMatchObject({ success: true });
    const launched = store.read().launched;
    expect(launched.map((l) => [l.kind, l.title])).toEqual([
      ["session", "Home page"],
      ["session", "Docs pages"],
    ]);
    for (const entry of launched) {
      const session = chat.get(entry.id);
      expect(session.summary().worktree?.branch).toBeTruthy();
      await session.settled();
    }
    expect(await noticeFor(chat, /Docs pages/)).toBe('Session "Docs pages": done');
  }, 60000);

  test("the work style turns off the other way of working and is in the instructions", async () => {
    const chatsOnly = await setup(5, undefined, false, "chats-only");
    expect(await chatsOnly.tool("start_run").execute({ prompt: "Fix the tests", why: "CI is red" })).toMatchObject({
      success: false,
      error: expect.stringContaining("only through chats"),
    });
    const brief = new BriefStore(chatsOnly.chat.workspace, chatsOnly.coordinator.id).read();
    expect(coordinatorInstructions(brief, "chats-only")).toContain("The user works only through chats");
    expect(coordinatorInstructions(brief)).toContain("The user has not set a work style");
    const workflowsOnly = await setup(5, undefined, false, "workflows-only");
    expect(await workflowsOnly.tool("propose_chats").execute(chats([["a/**"], ["b/**"]]))).toMatchObject({
      success: false,
      error: expect.stringContaining("only through workflows"),
    });
  }, 60000);

  test("the limit on active work counts every chat", async () => {
    const { tool } = await setup(1);
    expect(await tool("propose_chats").execute(chats([["a/**"], ["b/**"]]))).toMatchObject({
      success: false,
      error: expect.stringContaining("limit 1"),
    });
  }, 60000);
});

describe("coordinator splits", () => {
  test("two independent flows run in parallel worktrees; three or more make one initiative", () => {
    expect(pathsOverlap("src/api/**", "src/api/cart.ts")).toBe(true);
    expect(pathsOverlap("src/api/**", "src/ui/**")).toBe(false);
    expect(pathsOverlap("**/*.ts", "docs/a.md")).toBe(true);
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"])]))).toMatchObject({ mode: "runs" });
    expect(splitShape(split([flow("api", ["src/**"]), flow("ui", ["src/ui/**"])]))).toMatchObject({ problem: expect.stringContaining("both write") });
    expect(splitShape(split([flow("api", []), flow("ui", ["src/ui/**"])]))).toMatchObject({ problem: expect.stringContaining("boundary paths") });
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"])]))).toMatchObject({ problem: expect.stringContaining("at least 3") });
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"]), flow("docs", ["docs/**"])]))).toMatchObject({ mode: "initiative" });
    expect(splitShape(split([flow("api", ["a"], ["ui"]), flow("ui", ["b"], ["api"]), flow("docs", ["c"])]))).toMatchObject({ problem: expect.stringContaining("ycle") });
    // Independent flows too: the initiative runs them side by side, each under its own workflow.
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"]), flow("docs", ["docs/**"])]))).toMatchObject({ mode: "initiative" });
  });

  test("an approved split starts its flows and records the decision; a stale digest is refused", async () => {
    const { fixture, chat, coordinator, tool } = await setup(5);
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");

    const rejected = tool("propose_split").execute(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"])]) as unknown as Record<string, unknown>);
    await Bun.sleep(10);
    const card = coordinator.pendingPrompts[0];
    if (!card || card.kind !== "split") throw new Error("no split card");
    expect(card).toMatchObject({ mode: "runs", title: "Checkout redesign" });
    expect(card.flows.map((f) => f.id)).toEqual(["api", "ui"]);
    expect(() => coordinator.answer(card.id, { approve: true, digest: "0".repeat(64) })).toThrow("digest");
    coordinator.answer(card.id, { approve: false });
    expect((await rejected).success).toBe(false);
    const store = new BriefStore(chat.workspace, coordinator.id);
    expect(store.read().openQuestions.at(-1)).toContain("rejected");
    expect(store.read().launched).toEqual([]);

    const approved = tool("propose_split").execute(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"])]) as unknown as Record<string, unknown>);
    await Bun.sleep(10);
    const second = coordinator.pendingPrompts[0];
    if (!second || second.kind !== "split") throw new Error("no split card");
    coordinator.answer(second.id, { approve: true, digest: second.digest });
    const result = await approved;
    expect(result).toMatchObject({ success: true });
    const brief = store.read();
    expect(brief.decisions.at(-1)).toContain(`approved (digest ${second.digest.slice(0, 12)})`);
    expect(brief.launched.map((l) => l.kind)).toEqual(["run", "run"]);
    for (const entry of brief.launched) {
      const policy = JSON.parse(fixture.service.store.run(entry.id).policy_json) as { executionMode?: string };
      expect(policy.executionMode).toBe("worktree");
    }
  }, 60000);

  test("a split with dependencies starts one initiative whose split is already approved", async () => {
    const { fixture, chat, coordinator, tool, server } = await setup(5);
    // Feature runs in worktrees need Git; an initiative without it is refused at start (#1345).
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
    const pending = tool("propose_split").execute(
      split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"]), { ...flow("docs", ["docs/**"]), workflow: "quick" }]) as unknown as Record<string, unknown>,
    );
    await Bun.sleep(10);
    const card = coordinator.pendingPrompts[0];
    if (!card || card.kind !== "split") throw new Error("no split card");
    expect(card.mode).toBe("initiative");
    expect(card.flows.find((f) => f.id === "docs")?.workflow).toBe("quick");
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    expect(await pending).toMatchObject({ success: true });
    const launched = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(launched.map((l) => [l.kind, l.id])).toEqual([["initiative", "checkout"]]);
    const view = (await (
      await fetch(`${server.url}/v1/initiatives/checkout`, { headers: { Authorization: `Bearer ${server.token}` } })
    ).json()) as {
      approvedPlanRevision: number | null;
      pendingDecisions: { kind: string }[];
      features: { id: string; workflowId: string }[];
    };
    expect(view.approvedPlanRevision).not.toBeNull();
    // The flow's own workflow is kept; flows that name none get the one that fits them.
    expect(view.features.find((f) => f.id === "docs")?.workflowId).toBe("quick");
    expect(view.features.find((f) => f.id === "api")?.workflowId).toBe("sdd");
    expect(view.pendingDecisions.filter((d) => d.kind === "split_approval")).toEqual([]);
  }, 60000);
});

/** An in-memory issue tracker for acme/widget. */
class FakeTasks implements TaskTracker {
  created: { title: string; body: string; parent?: string }[] = [];
  closedRefs = new Set<string>();
  constructor(private repository: string | null = "acme/widget") {}
  async target() {
    return this.repository;
  }
  async link(reference: string): Promise<FlowTask> {
    const number = Number(/(\d+)$/.exec(reference)?.[1]);
    const ref = `acme/widget#${number}`;
    return { ref, url: `https://github.com/acme/widget/issues/${number}`, state: this.closedRefs.has(ref) ? "closed" : "open" };
  }
  async create(input: { title: string; body: string; parent?: string }) {
    this.created.push(input);
    const number = 200 + this.created.length;
    return { task: { ref: `acme/widget#${number}`, url: `https://github.com/acme/widget/issues/${number}`, state: "open" as const } };
  }
  async closed(ref: string) {
    return this.closedRefs.has(ref);
  }
}

/** Answers GitHub issue reads for acme/widget; everything else goes to the real fetch. */
function fakeGitHub(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = /^https:\/\/api\.github\.com\/repos\/acme\/widget\/issues\/(\d+)$/.exec(url);
    if (!match) return real(input, init);
    const number = Number(match[1]);
    return new Response(
      JSON.stringify({ number, html_url: `https://github.com/acme/widget/issues/${number}`, title: `Task ${number}`, body: "Do it", state: "open" }),
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe("coordinator tasks", () => {
  test("approving a split links or creates one issue per flow and starts each run from it", async () => {
    const tasks = new FakeTasks();
    const { fixture, chat, coordinator, tool } = await setup(5, tasks);
    const restore = fakeGitHub();
    cleanups.push(async () => restore());
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");

    const request = split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"])]);
    const pending = tool("propose_split").execute({
      ...request,
      parentIssue: "#100",
      flows: [{ ...request.flows[0], issue: "#120" }, request.flows[1]],
    } as unknown as Record<string, unknown>);
    await Bun.sleep(10);
    const card = coordinator.pendingPrompts[0];
    if (!card || card.kind !== "split") throw new Error("no split card");
    expect(card.flows.map((f) => f.task)).toEqual(["acme/widget#120", "new issue"]);
    expect(tasks.created).toEqual([]);
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    const result = await pending;
    expect(result).toMatchObject({ success: true });
    expect(tasks.created).toHaveLength(1);
    expect(tasks.created[0]).toMatchObject({ title: "Build ui", parent: "#100" });
    expect(tasks.created[0]?.body).toContain("Checkout works end to end");

    const launched = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(launched.map((l) => l.task?.ref)).toEqual(["acme/widget#120", "acme/widget#201"]);
    const features = launched.map((l) => fixture.service.store.run(l.id).feature_id);
    expect(features).toEqual(["issue-120-task-120", "issue-201-task-201"]);
  }, 60000);

  test("an approved dependent split gives each feature its issue and tracks each task", async () => {
    const tasks = new FakeTasks();
    const { fixture, chat, coordinator, tool, server } = await setup(5, tasks);
    // Feature runs in worktrees need Git; an initiative without it is refused at start (#1345).
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
    const request = split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"]), flow("docs", ["docs/**"])]);
    const pending = tool("propose_split").execute({
      ...request,
      flows: [{ ...request.flows[0], issue: "#120" }, request.flows[1], request.flows[2]],
    } as unknown as Record<string, unknown>);
    await Bun.sleep(10);
    const card = coordinator.pendingPrompts[0];
    if (!card || card.kind !== "split") throw new Error("no split card");
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    expect(await pending).toMatchObject({ success: true });

    const launched = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(launched.map((l) => [l.kind, l.id, l.feature ?? null, l.task?.ref ?? null])).toEqual([
      ["initiative", "checkout", null, null],
      ["initiative", "checkout", "api", "acme/widget#120"],
      ["initiative", "checkout", "ui", "acme/widget#201"],
      ["initiative", "checkout", "docs", "acme/widget#202"],
    ]);
    const view = (await (
      await fetch(`${server.url}/v1/initiatives/checkout`, { headers: { Authorization: `Bearer ${server.token}` } })
    ).json()) as { features: { id: string; issue: { repository: string; number: number } | null }[] };
    expect(view.features.map((f) => [f.id, f.issue?.number ?? null])).toEqual([
      ["api", 120],
      ["ui", 201],
      ["docs", 202],
    ]);
  }, 60000);

  test("an accepted feature's issue closed by its merge is reported like a run's", async () => {
    const fixture = workflowFixture();
    cleanups.push(() => fixture.dispose());
    const chat = new ChatService({ workspace: fixture.root, config: { ...fixture.service.config, defaultModel: "openai/gpt-test" }, host: new RecordingHost(), homeDir: fixture.root });
    const coordinator = await chat.coordinator(true);
    if (!coordinator) throw new Error("no coordinator");
    const store = new BriefStore(chat.workspace, coordinator.id);
    const task: FlowTask = { ref: "acme/widget#120", state: "open" };
    store.write({ ...store.read(), launched: [{ kind: "initiative", id: "checkout", feature: "api", why: "Build api", status: "started", task }] }, 0);
    const state = {
      initiative: () => ({ features: [{ id: "api", state: "accepted", pendingRequests: [], usage: { tokens: 9 } }] }),
    } as unknown as ProjectStateSource;
    const tasks = new FakeTasks();
    tasks.closedRefs.add("acme/widget#120");
    expect(await syncLaunched(chat, coordinator, state, tasks)).toEqual([
      'Feature "api" of initiative checkout (acme/widget#120): completed',
      'Task acme/widget#120 closed: the pull request of Feature "api" of initiative checkout merged',
    ]);
  });

  test("without a token every flow gets a local task; a closed issue cannot be linked", async () => {
    const tasks = new FakeTasks(null);
    tasks.closedRefs.add("acme/widget#7");
    const { fixture, chat, coordinator, tool } = await setup(5, tasks);
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");

    const closed = await tool("start_run").execute({ prompt: "Again", issue: "#7", why: "Redo" });
    expect(closed.error ?? "").toContain("already closed");

    const pending = tool("propose_split").execute(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"])]) as unknown as Record<string, unknown>);
    await Bun.sleep(10);
    const card = coordinator.pendingPrompts[0];
    if (!card || card.kind !== "split") throw new Error("no split card");
    expect(card.flows.map((f) => f.task)).toEqual(["local task", "local task"]);
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    expect(await pending).toMatchObject({ success: true });
    const launched = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(launched.map((l) => l.task)).toEqual([
      { ref: "local:checkout/api", state: "local" },
      { ref: "local:checkout/ui", state: "local" },
    ]);
    expect(launched.map((l) => fixture.service.store.run(l.id).feature_id)).toEqual(["checkout-api", "checkout-ui"]);
    expect(tasks.created).toEqual([]);
  }, 60000);

  test("a completed run's issue closed by its merge is reported once", async () => {
    const fixture = workflowFixture();
    cleanups.push(() => fixture.dispose());
    const chat = new ChatService({ workspace: fixture.root, config: { ...fixture.service.config, defaultModel: "openai/gpt-test" }, host: new RecordingHost(), homeDir: fixture.root });
    const coordinator = await chat.coordinator(true);
    if (!coordinator) throw new Error("no coordinator");
    const store = new BriefStore(chat.workspace, coordinator.id);
    const task: FlowTask = { ref: "acme/widget#120", state: "open" };
    store.write({ ...store.read(), launched: [{ kind: "run", id: "run-1", why: "Ship", status: "running", task }] }, 0);
    const state = {
      run: () => ({ summary: { pendingKind: null, snapshot: { status: "completed", reason: "none", tokenUsage: 5 } } }),
    } as unknown as ProjectStateSource;
    const tasks = new FakeTasks();

    expect(await syncLaunched(chat, coordinator, state, tasks)).toEqual(["Run run-1 (acme/widget#120): completed"]);
    expect(store.read().launched[0]?.task?.state).toBe("open");
    tasks.closedRefs.add("acme/widget#120");
    expect(await syncLaunched(chat, coordinator, state, tasks)).toEqual([
      "Task acme/widget#120 closed: the pull request of Run run-1 merged",
    ]);
    expect(store.read().launched[0]?.task?.state).toBe("closed");
    expect(await syncLaunched(chat, coordinator, state, tasks)).toEqual([]);
  });

  test("GitHub tasks create sub-issues in the origin repository and read issue state", async () => {
    const fixture = workflowFixture();
    cleanups.push(() => fixture.dispose());
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "remote", "add", "origin", "https://github.com/acme/widget.git");
    const calls: { url: string; method: string; body: unknown; auth: string | undefined }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.authorization });
      if (String(url).endsWith("/sub_issues")) return new Response("{}", { status: 422 });
      if (init?.method === "POST") return new Response(JSON.stringify({ id: 9001, number: 301, html_url: "https://github.com/acme/widget/issues/301" }), { status: 201 });
      return new Response(JSON.stringify({ number: 301, title: "Build ui", body: "", state: "closed", html_url: "https://github.com/acme/widget/issues/301" }), { status: 200 });
    }) as typeof fetch;
    const config = { ...fixture.service.config, workflows: { ...fixture.service.config.workflows, delivery: { tokenEnv: "BAKED_TEST_GH", apiUrl: "https://api.github.com" } } };

    expect(await githubTasks(fixture.root, config, { fetch: fetcher, env: {} }).target()).toBeNull();
    const tracker = githubTasks(fixture.root, config, { fetch: fetcher, env: { BAKED_TEST_GH: "t0k" } });
    expect(await tracker.target()).toBe("acme/widget");
    const created = await tracker.create({ title: "Build ui", body: "Scope", parent: "#100" });
    expect(created.task).toEqual({ ref: "acme/widget#301", url: "https://github.com/acme/widget/issues/301", state: "open" });
    expect(created.warning).toContain("not a sub-issue of acme/widget#100");
    expect(calls.map((c) => [c.method, c.url, c.auth])).toEqual([
      ["POST", "https://api.github.com/repos/acme/widget/issues", "Bearer t0k"],
      ["POST", "https://api.github.com/repos/acme/widget/issues/100/sub_issues", "Bearer t0k"],
    ]);
    expect(calls[1]?.body).toEqual({ sub_issue_id: 9001 });
    expect(await tracker.closed("acme/widget#301")).toBe(true);
    expect(await tracker.link("#301")).toMatchObject({ ref: "acme/widget#301", state: "closed" });
  });
});
