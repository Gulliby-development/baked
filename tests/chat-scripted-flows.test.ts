/**
 * The scripted chat host's scenario features (matched turns, questions, compaction) and the
 * session behaviors the desktop end-to-end tests rely on: replaying a running turn, and a
 * coordinator confirm worded as a step to approve.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatScript, ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import { type ChatEvent, ChatService, type ChatSession } from "../src/core/chat/sessions.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function service(script: ChatScript) {
  const root = mkdtempSync(join(tmpdir(), "baked-scripted-flows-"));
  const chat = new ChatService({
    workspace: root,
    config: { defaultModel: "openai/gpt-test" } as never,
    host: new ScriptedChatHost(script),
    homeDir: root,
  });
  cleanups.push(async () => {
    await chat.shutdown();
    await removeTempDir(root);
  });
  return chat;
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

const answer = (session: ChatSession) => session.messages.at(-1)?.content ?? "";

describe("scripted chat scenarios", () => {
  test("a turn with `when` answers the message that contains it, whatever the order", async () => {
    const chat = service({
      delayMs: 1,
      turns: [
        { when: "about cats", steps: [{ text: "Cats." }] },
        { steps: [{ text: "Anything else." }] },
        { when: "about dogs", steps: [{ text: "Dogs." }] },
      ],
    });
    const a = await chat.create({});
    const b = await chat.create({});
    a.send("Tell me about dogs");
    b.send("Tell me about cats");
    await Promise.all([a.settled(), b.settled()]);
    expect(answer(a)).toBe("Dogs.");
    expect(answer(b)).toBe("Cats.");
    a.send("Something unrelated");
    await a.settled();
    expect(answer(a)).toBe("Anything else.");
  });

  test("an ask step waits for the answer and only the matching reply streams", async () => {
    const chat = service({
      delayMs: 1,
      turns: [
        {
          steps: [
            { ask: "Which one?", options: ["Left", "Right"] },
            { ifAnswer: "Left", reply: "Went left." },
            { ifAnswer: "Right", reply: "Went right." },
          ],
        },
      ],
    });
    const session = await chat.create({});
    session.send("Pick a way");
    await until(() => session.pendingPrompts.length > 0);
    const prompt = session.pendingPrompts[0];
    expect(prompt?.kind).toBe("question");
    session.answer(prompt?.id ?? "", { answer: "Right" });
    await session.settled();
    expect(answer(session)).toBe("Went right.");
  });

  test("the streamed text is kept as history, so compaction has messages to summarize", async () => {
    const turns = ["one", "two", "three"].map((n) => ({ steps: [{ text: `Answer ${n}.` }] }));
    const chat = service({ delayMs: 1, compaction: "Three answers so far.", turns });
    const session = await chat.create({});
    for (const n of ["one", "two", "three"]) {
      session.send(`Question ${n}`);
      await session.settled();
    }
    session.compact();
    await session.settled();
    expect(session.messages.at(-1)?.content).toContain("Compacted 4 messages into a summary");
  });

  test("while a turn runs, subscribing after turnSeq replays what it streamed so far", async () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const chat = service({ delayMs: 5, turns: [{ steps: [{ text: words }] }] });
    const session = await chat.create({});
    expect(session.detail().turnSeq).toBeUndefined();
    session.send("Go");
    let streamed = "";
    const stopLive = session.subscribe(session.detail().lastSeq, (event: ChatEvent) => {
      if (event.type === "text") streamed += event.delta;
    });
    await until(() => streamed.includes("w5 "));
    const detail = session.detail();
    expect(detail.turnSeq).toBeLessThan(detail.lastSeq);
    let replayed = "";
    let started = false;
    const stop = session.subscribe(detail.turnSeq ?? detail.lastSeq, (event: ChatEvent) => {
      if (event.type === "turn-start") started = true;
      if (event.type === "text") replayed += event.delta;
    });
    expect(started).toBe(true);
    expect(replayed.startsWith("w0 w1 w2 w3 w4 w5")).toBe(true);
    await session.settled();
    stop?.();
    stopLive?.();
    expect(session.detail().turnSeq).toBeUndefined();
  });

  test("a turn whose answer is saved but not yet announced has no turnSeq to replay from", async () => {
    const chat = service({ delayMs: 1, turns: [{ steps: [{ text: "Answer one." }] }] });
    const session = await chat.create({});
    // Hold the save at the end of the turn, between storing the answer and turn-done.
    const owner = chat as unknown as { persist: (s: ChatSession) => Promise<void> };
    const persist = owner.persist.bind(chat);
    let release = () => {};
    let held: ReturnType<ChatSession["detail"]> | null = null;
    owner.persist = async (s) => {
      if (s.messages.at(-1)?.role === "assistant" && !held) {
        held = s.detail();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return persist(s);
    };
    session.send("Question one");
    await until(() => held !== null);
    const detail = held as unknown as ReturnType<ChatSession["detail"]>;
    release();
    await session.settled();
    expect(detail.messages.at(-1)?.content).toBe("Answer one.");
    expect(detail.turnSeq).toBeUndefined();
  });

  test("a coordinator's confirm is a step to approve, not a destructive command", async () => {
    const chat = service({ delayMs: 1, turns: [] });
    const session = await chat.create({});
    const confirmed = session.confirm("Start a session");
    await until(() => session.pendingPrompts.length > 0);
    const prompt = session.pendingPrompts[0];
    expect(prompt).toMatchObject({ kind: "destructive", description: "Start a session", confirm: true });
    session.answer(prompt?.id ?? "", { approve: true });
    expect(await confirmed).toBe(true);
  });
});
