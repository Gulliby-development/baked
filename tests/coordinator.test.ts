import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import {
  applyBriefEdit,
  BRIEF_MAX_CHARS,
  BriefError,
  BriefStore,
  coordinatorInstructions,
  emptyBrief,
  type ProjectBrief,
} from "../src/core/chat/coordinator.js";
import {
  type ChatAgentHost,
  ChatService,
  type CompactionRequest,
  type CompactionResponse,
  type SessionDetail,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import { assembleCompacted, splitForCompaction } from "../src/core/compaction/manual.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

/** Answers every turn with one text part and a step that fills `fill` of a 1000-token window. */
class FakeHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  fill = 0.1;
  compactions = 0;
  compact = async (request: CompactionRequest): Promise<CompactionResponse> => {
    this.compactions++;
    const { older, recent } = splitForCompaction(request.messages, 4);
    return {
      result: {
        status: "compacted",
        messages: assembleCompacted("SUMMARY", recent),
        summary: "SUMMARY",
        compacted: older.length,
        strategy: "v1",
      },
      systemChars: 0,
      contextWindow: 1000,
    };
  };
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    const fill = this.fill;
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" };
            yield { type: "finish-step", usage: { inputTokens: Math.round(fill * 1000), outputTokens: 0 } };
          })(),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }
  release() {}
  async dispose() {}
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-coordinator-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function service(root: string, host = new FakeHost()) {
  const chat = new ChatService({
    workspace: root,
    config: { defaultModel: "openai/gpt-test" },
    host,
    homeDir: root,
  });
  return { chat, host };
}

async function turn(chat: ChatService, id: string, text: string): Promise<void> {
  const session = chat.get(id);
  session.send(text);
  await session.settled();
}

describe("project brief", () => {
  test("saves with a revision and refuses a stale or oversized write", () => {
    const store = new BriefStore(workspace(), "s1");
    expect(store.read()).toEqual(emptyBrief());
    const saved = store.write({ ...emptyBrief(), decisions: ["Ship on Fridays"] }, 0);
    expect(saved.revision).toBe(1);
    expect(store.read().decisions).toEqual(["Ship on Fridays"]);
    expect(() => store.write({ ...emptyBrief(), decisions: [] }, 0)).toThrow(BriefError);
    const big = Array.from({ length: 20 }, (_, i) => `${String(i)} ${"x".repeat(900)}`);
    expect(() => store.write({ ...emptyBrief(), conventions: big }, 1)).toThrow(
      String(BRIEF_MAX_CHARS),
    );
    expect(store.read().revision).toBe(1);
  });

  test("tool edits add, replace and remove entries by index", () => {
    let content: ProjectBrief = emptyBrief();
    content = { ...content, ...applyBriefEdit(content, { section: "openQuestions", action: "add", text: "Which CI?" }) };
    content = {
      ...content,
      ...applyBriefEdit(content, {
        section: "launched",
        action: "add",
        launched: { kind: "run", id: "run-1", why: "Fix login", status: "running" },
      }),
    };
    content = { ...content, ...applyBriefEdit(content, { section: "openQuestions", action: "replace", index: 0, text: "GitHub Actions" }) };
    expect(content.openQuestions).toEqual(["GitHub Actions"]);
    content = { ...content, ...applyBriefEdit(content, { section: "launched", action: "remove", index: 0 }) };
    expect(content.launched).toEqual([]);
    expect(() => applyBriefEdit(content, { section: "decisions", action: "remove", index: 3 })).toThrow("No entry 3");
    expect(() => applyBriefEdit(content, { section: "launched", action: "add" })).toThrow("launched entry");
  });

  test("recording an item already launched updates its entry instead of listing it twice", () => {
    const launched = { kind: "session" as const, id: "s-1", why: "Deploy the page", status: "working" };
    let content: ProjectBrief = { ...emptyBrief(), launched: [launched] };
    content = {
      ...content,
      ...applyBriefEdit(content, {
        section: "launched",
        action: "add",
        launched: { ...launched, title: "Deploy to Vercel", why: "Publish via an artifact", status: "started" },
      }),
    };
    expect(content.launched).toEqual([{ ...launched, title: "Deploy to Vercel" }]);
  });

  test("a brief saved with duplicate launched entries reads back with one per item", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-brief-dup-"));
    try {
      const store = new BriefStore(dir, "c-1");
      const entry = { kind: "session" as const, id: "s-1", why: "Deploy", status: "waiting for you" };
      mkdirSync(join(store.path, ".."), { recursive: true });
      writeFileSync(store.path, JSON.stringify({ ...emptyBrief(), revision: 2, launched: [entry, { ...entry, why: "Again" }] }));
      expect(store.read().launched).toEqual([entry]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the coordinator prompt carries the brief", () => {
    const text = coordinatorInstructions({
      ...emptyBrief(),
      revision: 4,
      decisions: ["Use Bun"],
      launched: [{ kind: "session", id: "abc", why: "Explore auth", status: "done" }],
    });
    expect(text).toContain("revision 4");
    expect(text).toContain("0. Use Bun");
    expect(text).toContain("session abc [done]: Explore auth");
  });
});

describe("coordinator session", () => {
  test("one per project, hidden from the session list, survives a restart with its brief", async () => {
    const root = workspace();
    const first = service(root);
    expect(await first.chat.coordinator(false)).toBeNull();
    const coordinator = await first.chat.coordinator(true);
    if (!coordinator) throw new Error("no coordinator");
    expect(coordinator.summary()).toMatchObject({ kind: "coordinator", mode: "architect" });
    expect((await first.chat.coordinator(true))?.id).toBe(coordinator.id);
    await first.chat.create({ title: "Ordinary" });
    expect(first.chat.list().map((s) => s.title)).toEqual(["Ordinary"]);
    expect(() => coordinator.update({ mode: "default" })).toThrow("architect");

    await turn(first.chat, coordinator.id, "hello");
    expect(first.host.requests[0]?.coordinator).toBe(true);
    new BriefStore(root, coordinator.id).write({ ...emptyBrief(), decisions: ["Keep it"] }, 0);
    await first.chat.shutdown();

    const second = service(root);
    const reloaded = await second.chat.coordinator(false);
    expect(reloaded?.id).toBe(coordinator.id);
    expect(reloaded?.summary().kind).toBe("coordinator");
    expect(reloaded?.messages.length).toBe(2);
    expect(new BriefStore(root, coordinator.id).read().decisions).toEqual(["Keep it"]);
  });

  test("compacts itself after a turn that passes the trigger, ordinary sessions do not", async () => {
    const { chat, host } = service(workspace());
    const coordinator = await chat.coordinator(true);
    const ordinary = await chat.create({});
    if (!coordinator) throw new Error("no coordinator");
    host.fill = 0.9;
    for (const text of ["a", "b"]) await turn(chat, coordinator.id, text);
    // Too short to summarize yet: nothing is compacted and nothing is held back.
    expect(host.compactions).toBe(0);
    await turn(chat, coordinator.id, "c");
    await coordinator.settled();
    expect(host.compactions).toBe(1);
    expect(coordinator.messages.at(-1)?.content).toContain("Compacted");
    for (const text of ["a", "b", "c"]) await turn(chat, ordinary.id, text);
    expect(host.compactions).toBe(1);
    await chat.shutdown();
  });
});

describe("coordinator API", () => {
  test("create, get, brief revisions and health capability", async () => {
    const fixture = workflowFixture();
    const host = new FakeHost();
    const chat = new ChatService({
      workspace: fixture.root,
      config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
      host,
      homeDir: fixture.root,
    });
    const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
    });
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("coordinator");
    expect((await call("/v1/coordinator")).status).toBe(404);
    expect((await call("/v1/coordinator/brief")).status).toBe(404);
    const created = await call("/v1/coordinator", "POST", {});
    expect(created.status).toBe(201);
    const session = (await created.json()) as SessionDetail;
    expect(session.kind).toBe("coordinator");
    const again = await call("/v1/coordinator", "POST", {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as SessionDetail).id).toBe(session.id);
    const listed = (await (await call("/v1/sessions")).json()) as { sessions: { id: string }[] };
    expect(listed.sessions.map((s) => s.id)).not.toContain(session.id);
    expect((await call(`/v1/sessions/${session.id}`, "PATCH", { mode: "auto" })).status).toBe(400);

    const brief = (await (await call("/v1/coordinator/brief")).json()) as ProjectBrief;
    expect(brief.revision).toBe(0);
    const body = {
      expectedRevision: 0,
      decisions: ["Release on tags"],
      conventions: [],
      openQuestions: [],
      launched: [],
    };
    const saved = await call("/v1/coordinator/brief", "PUT", body);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as ProjectBrief).revision).toBe(1);
    const stale = await call("/v1/coordinator/brief", "PUT", body);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("STALE_REVISION");

    // A turn through the session endpoints reaches the host as a coordinator turn.
    await call(`/v1/sessions/${session.id}/messages`, "POST", { text: "status?" });
    await chat.get(session.id).settled();
    expect(host.requests.at(-1)).toMatchObject({ coordinator: true, mode: "architect" });
  });
});
