import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { BriefStore, type LaunchedEntry } from "../src/core/chat/coordinator.js";
import { closeLaunched, stopLaunched } from "../src/core/chat/coordinator-control.js";
import { type ProjectLauncher, syncLaunched } from "../src/core/chat/coordinator-launch.js";
import type { ProjectStateSource } from "../src/core/chat/project-state.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import type { InitiativeView } from "../src/core/workflows/initiatives/service.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

/** Answers every turn at once, or with `hang` waits until the turn is interrupted. */
class Host implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  hang = false;
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    const hang = this.hang;
    return {
      contextWindow: 1000,
      agent: {
        stream: async ({ abortSignal }: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            // The turn may be interrupted before the stream is read, so check the signal first.
            if (hang && !abortSignal.aborted)
              await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
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
  const host = new Host();
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
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { fixture, chat, host, coordinator, tool, post, server };
}

/** Waits for the coordinator's next prompt and answers it. */
async function answer(coordinator: { pendingPrompts: { id: string; kind: string; description?: string; digest?: string }[]; answer: (id: string, a: { approve: boolean; digest?: string }) => void }, approve: boolean): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const prompt = coordinator.pendingPrompts[0];
    if (prompt) {
      coordinator.answer(prompt.id, { approve, digest: prompt.digest });
      return prompt.description ?? "";
    }
    await Bun.sleep(10);
  }
  throw new Error("no prompt");
}

describe("stopping and closing launched work", () => {
  test("cancelling a run asks first; a closed run no longer counts toward the active limit", async () => {
    const { fixture, chat, coordinator, tool } = await setup(1);
    // start_run asks first on a workflow card.
    const starting = tool("start_run").execute({ prompt: "Create ready value", feature: "fixture", why: "Ship" });
    await answer(coordinator, true);
    const run = await starting;
    const runId = /run ([0-9a-f-]{36})/.exec(run.output)?.[1] ?? "";
    expect(runId).not.toBe("");

    // Active and not stopped: it cannot be closed, and it holds the limit of one.
    expect((await tool("close_launched").execute({ kind: "run", id: runId })).error).toContain("stop it before closing");
    expect((await tool("start_run").execute({ prompt: "Another", why: "More" })).error).toContain("limit 1");

    const kept = tool("stop_launched").execute({ kind: "run", id: runId, why: "Wrong request" });
    expect(await answer(coordinator, false)).toContain(`Cancel workflow run ${runId}`);
    expect((await kept).output).toContain("kept");
    expect((await fixture.service.get(runId)).status).not.toBe("cancelled");

    const stopped = tool("stop_launched").execute({ kind: "run", id: runId, why: "Wrong request" });
    await answer(coordinator, true);
    expect(await stopped).toMatchObject({ success: true, output: `Cancelled run ${runId}` });
    expect((await fixture.service.get(runId)).status).toBe("cancelled");

    expect(await tool("close_launched").execute({ kind: "run", id: runId })).toMatchObject({ success: true });
    const entry = new BriefStore(chat.workspace, coordinator.id).read().launched[0];
    expect(entry).toMatchObject({ kind: "run", id: runId, closed: true });
    // A closed entry is not followed: no notice, no status change.
    expect(await chat.syncLaunched()).toEqual([]);
    const another = tool("start_run").execute({ prompt: "Another value", why: "More" });
    await answer(coordinator, true);
    expect((await another).success).toBe(true);
  }, 60000);

  test("a launched session stops through the API, closes into the archive and reopens", async () => {
    const { fixture, chat, host, tool, post, server } = await setup();
    host.hang = true;
    const launched = await tool("launch_session").execute({
      title: "Survey the auth code",
      brief: "List every place that checks a token.",
      mode: "architect",
      why: "Find the token checks",
    });
    const id = /session ([0-9a-f-]{36})/.exec(launched.output)?.[1] ?? "";
    expect(chat.get(id).summary().state).toBe("working");

    expect((await post("/v1/coordinator/launched/close", { kind: "session", id })).status).toBe(400);
    const stop = await post("/v1/coordinator/launched/stop", { kind: "session", id });
    expect(stop.status).toBe(200);
    expect(stop.body.message).toBe(`Stopped the turn of session ${id}`);
    await chat.get(id).settled();
    expect((await post("/v1/coordinator/launched/stop", { kind: "session", id })).status).toBe(400);

    const closed = await post("/v1/coordinator/launched/close", { kind: "session", id });
    expect(closed.status).toBe(200);
    expect(closed.body.launched).toEqual([expect.objectContaining({ kind: "session", id, closed: true, active: false })]);
    expect(chat.list().map((s) => s.id)).not.toContain(id);
    const listed = (await (
      await fetch(`${server.url}/v1/sessions`, { headers: { Authorization: `Bearer ${server.token}` } })
    ).json()) as { sessions: { id: string }[] };
    expect(listed.sessions.map((s) => s.id)).not.toContain(id);
    // Archived, not deleted: it still opens by id, also after the service reloads it from disk.
    expect(chat.get(id).summary()).toMatchObject({ id, archived: true });
    const reloaded = new ChatService({ workspace: chat.workspace, config: fixture.service.config, host, homeDir: chat.workspace });
    expect(reloaded.list().map((s) => s.id)).not.toContain(id);
    expect(reloaded.get(id).summary().archived).toBe(true);
    await reloaded.shutdown();

    expect((await post("/v1/coordinator/launched/close", { kind: "session", id, reopen: true })).status).toBe(200);
    expect(chat.list().map((s) => s.id)).toContain(id);
    expect(chat.get(id).summary().archived).toBeUndefined();

    expect((await post("/v1/coordinator/launched/stop", { kind: "run", id: "nope" })).status).toBe(404);
  }, 60000);
});

describe("stopping an initiative", () => {
  test("pauses it through the launcher, and closing it closes its feature entries", async () => {
    const fixture = workflowFixture();
    const chat = new ChatService({ workspace: fixture.root, config: fixture.service.config, host: new Host(), homeDir: fixture.root });
    cleanups.push(async () => {
      await chat.shutdown();
      await fixture.dispose();
    });
    let status = "active";
    const view = () =>
      ({
        initiativeId: "init",
        status,
        pendingDecisions: [],
        budget: { used: { tokens: 5 } },
        features: [{ id: "a", state: status === "paused" ? "paused" : "running", pendingRequests: [], usage: { tokens: 5 } }],
      }) as unknown as InitiativeView;
    const state = {
      runs: () => [],
      run: () => {
        throw new Error("no run");
      },
      initiatives: () => [view()],
      initiative: () => view(),
      attention: () => [],
    } as unknown as ProjectStateSource;
    const paused: string[] = [];
    const launcher = {
      startRun: async () => ({ runId: "r" }),
      startInitiative: async () => ({ initiativeId: "init" }),
      pauseInitiative: async (id: string) => {
        paused.push(id);
        status = "paused";
      },
    } satisfies ProjectLauncher;
    const coordinator = await chat.coordinator(true);
    if (!coordinator) throw new Error("no coordinator");
    const store = new BriefStore(chat.workspace, coordinator.id);
    const entries: LaunchedEntry[] = [
      { kind: "initiative", id: "init", why: "Split", status: "started" },
      { kind: "initiative", id: "init", feature: "a", why: "Flow a", status: "started" },
    ];
    store.write({ ...store.read(), launched: entries }, 0);

    expect(await stopLaunched(chat, coordinator.id, state, launcher, { kind: "initiative", id: "init" })).toContain(
      "Paused initiative init",
    );
    expect(paused).toEqual(["init"]);
    await closeLaunched(chat, coordinator.id, state, { kind: "initiative", id: "init" });
    expect(store.read().launched.map((e) => e.closed)).toEqual([true, true]);
    expect(await syncLaunched(chat, coordinator, state)).toEqual([]);
    await expect(stopLaunched(chat, coordinator.id, state, launcher, { kind: "initiative", id: "init" })).rejects.toThrow("is closed");
  });
});
