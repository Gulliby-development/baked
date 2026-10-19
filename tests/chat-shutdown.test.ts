import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedChatHost } from "../src/core/chat/scripted-host.js";
import { ChatService, type ChatSession } from "../src/core/chat/sessions.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(["turn", "compaction"] as const)(
  "shutdown during a %s's final save discards its queued work",
  async (operation) => {
    const root = mkdtempSync(join(tmpdir(), "baked-chat-shutdown-"));
    const chat = new ChatService({
      workspace: root,
      config: { defaultModel: "openai/gpt-test", compaction: { keepRecent: 2 } } as never,
      host: new ScriptedChatHost({
        delayMs: 0,
        turns: Array.from({ length: 5 }, () => ({ steps: [{ text: "done" }] })),
      }),
      homeDir: root,
    });
    const session = (await chat.coordinator(true)) as ChatSession;
    const saving = deferred();
    const release = deferred();
    const persist = chat.persist.bind(chat);
    cleanups.push(async () => {
      release.resolve();
      // Also drain an escaped turn when checking the unfixed implementation.
      await session.settled();
      await chat.shutdown();
      rmSync(root, { recursive: true, force: true });
    });
    if (operation === "compaction") {
      for (let i = 0; i < 3; i++) {
        session.send(`Question ${i}`);
        await session.settled();
      }
    }
    let held = false;
    chat.persist = async (savingSession) => {
      await persist(savingSession);
      if (!held && savingSession === session && !session.busy) {
        held = true;
        saving.resolve();
        await release.promise;
      }
    };
    if (operation === "turn") session.send("go");
    else session.compact();
    expect(session.sendRequest("queued work", "queued work").queued).toBe(true);
    await saving.promise;
    const closing = chat.shutdown();
    release.resolve();
    await closing;

    expect(session.busy).toBe(false);
    expect(session.detail().queued).toEqual([]);
    expect(session.messages.some((message) => message.content === "queued work")).toBe(false);
    expect(() => session.send("after shutdown")).toThrow("The server is shutting down");
    expect(() => session.compact()).toThrow("The server is shutting down");
    expect(session.wake(["after shutdown"])).toBe(false);
    expect(() => session.sendRequest("after shutdown", "after shutdown")).toThrow(
      "The server is shutting down",
    );
  },
);
