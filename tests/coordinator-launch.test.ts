import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { BriefStore } from "../src/core/chat/coordinator.js";
import { pathsOverlap, type SplitRequest, splitShape } from "../src/core/chat/coordinator-launch.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "done" };
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

async function setup(maxActive = 3) {
  const fixture = workflowFixture();
  const host = new RecordingHost();
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test", coordinator: { maxActive } },
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
    expect(chat.list().map((s) => s.id)).toContain(sessionId);
    await chat.get(sessionId).settled();
    expect(await noticeFor(chat, /^session/)).toContain(`session ${sessionId}: done (Find the token checks)`);

    const run = await tool("start_run").execute({ prompt: "Create ready value", feature: "fixture", why: "Ship the value" });
    expect(run).toMatchObject({ success: true });
    const runId = /run ([0-9a-f-]{36})/.exec(run.output)?.[1] ?? "";
    expect((await fixture.service.list({ limit: 10 })).items.map((r) => r.runId)).toContain(runId);
    expect(await noticeFor(chat, /^run/)).toBe(`run ${runId}: waiting: approval (Ship the value)`);

    const brief = new BriefStore(chat.workspace, coordinator.id).read();
    expect(brief.launched.map((l) => [l.kind, l.id, l.status])).toEqual([
      ["session", sessionId, "done"],
      ["run", runId, "waiting: approval"],
    ]);
    const notices = coordinator.messages.filter((m) => m.role === "system").map((m) => m.content);
    expect(notices).toContain(`Launched run ${runId}: waiting: approval (Ship the value)`);
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

describe("coordinator splits", () => {
  test("independent flows run in parallel worktrees; any dependency makes one initiative", () => {
    expect(pathsOverlap("src/api/**", "src/api/cart.ts")).toBe(true);
    expect(pathsOverlap("src/api/**", "src/ui/**")).toBe(false);
    expect(pathsOverlap("**/*.ts", "docs/a.md")).toBe(true);
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"])]))).toMatchObject({ mode: "runs" });
    expect(splitShape(split([flow("api", ["src/**"]), flow("ui", ["src/ui/**"])]))).toMatchObject({ problem: expect.stringContaining("both write") });
    expect(splitShape(split([flow("api", []), flow("ui", ["src/ui/**"])]))).toMatchObject({ problem: expect.stringContaining("boundary paths") });
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"])]))).toMatchObject({ problem: expect.stringContaining("at least 3") });
    expect(splitShape(split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"]), flow("docs", ["docs/**"])]))).toMatchObject({ mode: "initiative" });
    expect(splitShape(split([flow("api", ["a"], ["ui"]), flow("ui", ["b"], ["api"]), flow("docs", ["c"])]))).toMatchObject({ problem: expect.stringContaining("ycle") });
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
    const { chat, coordinator, tool, server } = await setup(5);
    const pending = tool("propose_split").execute(
      split([flow("api", ["src/api/**"]), flow("ui", ["src/ui/**"], ["api"]), flow("docs", ["docs/**"])]) as unknown as Record<string, unknown>,
    );
    await Bun.sleep(10);
    const card = coordinator.pendingPrompts[0];
    if (!card || card.kind !== "split") throw new Error("no split card");
    expect(card.mode).toBe("initiative");
    coordinator.answer(card.id, { approve: true, digest: card.digest });
    expect(await pending).toMatchObject({ success: true });
    const launched = new BriefStore(chat.workspace, coordinator.id).read().launched;
    expect(launched.map((l) => [l.kind, l.id])).toEqual([["initiative", "checkout"]]);
    const view = (await (
      await fetch(`${server.url}/v1/initiatives/checkout`, { headers: { Authorization: `Bearer ${server.token}` } })
    ).json()) as { approvedPlanRevision: number | null; pendingDecisions: { kind: string }[] };
    expect(view.approvedPlanRevision).not.toBeNull();
    expect(view.pendingDecisions.filter((d) => d.kind === "split_approval")).toEqual([]);
  }, 60000);
});
