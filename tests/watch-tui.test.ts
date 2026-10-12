import { afterEach, expect, test } from "bun:test";
import { register } from "../src/core/commands/watch.js";
import type { CommandContext, CommandHandler } from "../src/core/commands/types.js";
import { type WatchTurn, watchTurnDisplay } from "../src/core/watch/controller.js";
import { useWatchStore } from "../src/stores/watch.js";

afterEach(() => useWatchStore.getState().disable());

function command(activeTabId: string) {
  const messages: string[] = [];
  const ctx = {
    cwd: "/work/app",
    tabMgr: { activeTabId },
    chat: {
      setMessages: (update: (prev: { content: string }[]) => { content: string }[]) => {
        messages.splice(0, messages.length, ...update([]).map((m) => m.content));
      },
    },
  } as unknown as CommandContext;
  const commands = new Map<string, CommandHandler>();
  register(commands);
  const run = async (input: string) => commands.get("/watch")?.(input, ctx);
  return { messages, run };
}

test("/watch on, status and off drive the watch store", async () => {
  const a = command("tab-a");
  await a.run("/watch");
  expect(a.messages.at(-1)).toContain("Watch mode is off");
  await a.run("/watch on");
  expect(useWatchStore.getState().tabId).toBe("tab-a");
  expect(a.messages.at(-1)).toContain("Watch mode is on.");
  useWatchStore.getState().setRunning("poll");
  useWatchStore.getState().noteTurn("src/x.ts:4 (baked!)");
  await a.run("/watch status");
  expect(a.messages.at(-1)).toBe(
    "Watching /work/app by polling in this tab: 1 turn so far. Last: src/x.ts:4 (baked!).",
  );

  const b = command("tab-b");
  await b.run("/watch on");
  expect(useWatchStore.getState().tabId).toBe("tab-b");
  expect(useWatchStore.getState().turns).toBe(0);
  expect(b.messages.at(-1)).toContain("moved to this tab");
  await a.run("/watch status");
  expect(a.messages.at(-1)).toContain("in another tab");

  await b.run("/watch off");
  expect(useWatchStore.getState().tabId).toBeNull();
  await b.run("/watch off");
  expect(b.messages.at(-1)).toBe("Watch mode is already off.");
  await b.run("/watch maybe");
  expect(b.messages.at(-1)).toBe("Usage: /watch on | off | status");
});

test("a watch turn shows where it came from and the first line of the request", () => {
  const turn: WatchTurn = {
    prompt: "full prompt",
    label: "src/load.ts:2 (baked!)",
    kind: "act",
    requests: [
      {
        path: "src/load.ts",
        kind: "act",
        line: 2,
        endLine: 3,
        text: "retry twice on a network error\nthen give up",
      },
    ],
  };
  expect(watchTurnDisplay(turn)).toBe("From src/load.ts:2 (baked!): retry twice on a network error");
  expect(watchTurnDisplay({ ...turn, requests: [{ ...turn.requests[0]!, text: "" }] })).toBe(
    "From src/load.ts:2 (baked!)",
  );
});
