/**
 * `baked session coordinator send`: a coordinator turn from the headless CLI answers its prompts
 * without hanging and follows launched work until it finishes (#890).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BriefStore } from "../src/core/chat/coordinator.js";
import { ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import { type ChatPrompt, ChatService, type ChatSession } from "../src/core/chat/sessions.js";
import {
  answerPrompt,
  type CoordinatorChatIO,
  launchedLines,
  talkToCoordinator,
} from "../src/headless/coordinator-chat.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function service(host: ScriptedChatHost) {
  const root = mkdtempSync(join(tmpdir(), "baked-coord-cli-"));
  const chat = new ChatService({ workspace: root, config: { defaultModel: "openai/gpt-test" } as never, host, homeDir: root });
  cleanups.push(async () => {
    await chat.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, chat };
}

function capture(ask: CoordinatorChatIO["ask"] = null) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CoordinatorChatIO = { out: (t) => out.push(t), err: (t) => err.push(t), ask };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

const destructiveTurn = {
  steps: [
    { tool: "bash", input: { command: "rm -rf build" }, approval: { destructive: "rm -rf build" } },
    { ifApproved: "removed build." },
    { ifDenied: "kept build." },
  ],
};

describe("coordinator send (scripted scenario)", () => {
  test("without a terminal or --yes an approval is denied, with --yes it is allowed", async () => {
    const { chat } = service(new ScriptedChatHost({ delayMs: 1, turns: [destructiveTurn, destructiveTurn] }));
    const coordinator = (await chat.coordinator(true)) as ChatSession;

    const denied = capture();
    expect(await talkToCoordinator(chat, coordinator, "clean up", { json: false, yes: false, follow: true }, denied.io)).toBe(0);
    expect(denied.out()).toContain("kept build.");
    expect(denied.err()).toContain("Denied: rm -rf build");
    expect(coordinator.pendingPrompts).toEqual([]);

    const allowed = capture();
    expect(await talkToCoordinator(chat, coordinator, "clean up", { json: true, yes: true, follow: true }, allowed.io)).toBe(0);
    const result = JSON.parse(allowed.out()) as { sessionId: string; reply: string; launched: unknown[] };
    expect(result).toMatchObject({ sessionId: coordinator.id, reply: "removed build.", launched: [] });
  }, 30_000);

  test("a terminal answer decides the prompt", async () => {
    const { chat } = service(new ScriptedChatHost({ delayMs: 1, turns: [destructiveTurn] }));
    const coordinator = (await chat.coordinator(true)) as ChatSession;
    const asked: string[] = [];
    const io = capture(async (question) => {
      asked.push(question);
      return "y";
    });
    await talkToCoordinator(chat, coordinator, "clean up", { json: false, yes: false, follow: true }, io.io);
    expect(asked[0]).toContain("rm -rf build");
    expect(io.out()).toContain("removed build.");
  }, 30_000);

  test("follows a launched session until it finishes and prints its news", async () => {
    const { root, chat } = service(
      new ScriptedChatHost({
        delayMs: 20,
        turns: [{ steps: [{ text: "Surveying the auth code now and for a little while longer." }] }, { steps: [{ text: "Started it." }] }],
      }),
    );
    const coordinator = (await chat.coordinator(true)) as ChatSession;
    const session = await chat.create({ title: "Survey auth" });
    const briefs = new BriefStore(root, coordinator.id);
    const brief = briefs.read();
    briefs.write(
      { ...brief, launched: [{ kind: "session", id: session.id, title: "Survey auth", why: "Find token checks", status: "working" }] },
      brief.revision,
    );
    session.send("survey");
    expect(session.summary().state).toBe("working");

    const io = capture();
    await talkToCoordinator(chat, coordinator, "how is it going", { json: false, yes: false, follow: true }, io.io, 10);
    expect(session.summary().state).toBe("idle");
    expect(io.out()).toContain("Started it.");
    expect(io.err()).toContain('Session "Survey auth": done');
    expect(io.err()).toContain('○ Session "Survey auth": done');
  }, 30_000);
});

describe("coordinator CLI helpers", () => {
  test("a split is approved with its digest, a question without a terminal is skipped", async () => {
    const split = { id: "p", createdAt: 0, kind: "split", title: "Auth", mode: "runs", flows: [], digest: "d1" } as ChatPrompt;
    const io = capture().io;
    expect(await answerPrompt(split, { yes: true }, io)).toEqual({ approve: true, digest: "d1" });
    expect(await answerPrompt(split, { yes: false }, io)).toEqual({ approve: false });
    const question = { id: "q", createdAt: 0, kind: "question", question: "Which?", allowSkip: true, options: [] } as ChatPrompt;
    expect(await answerPrompt(question, { yes: true }, io)).toEqual({ answer: "" });
  });

  test("lists open launched work and counts closed items", () => {
    expect(launchedLines([])).toEqual(["The coordinator has launched nothing yet."]);
    expect(
      launchedLines([
        { kind: "run", id: "r1", title: "Fix login", why: "", status: "running", active: true, tokens: 1200 },
        { kind: "session", id: "s1", why: "", status: "completed", active: false, tokens: 5, closed: true },
      ]),
    ).toEqual(['● Run "Fix login": running · 1200 tokens', "1 closed"]);
  });
});
