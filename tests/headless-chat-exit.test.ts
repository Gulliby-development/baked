import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { getCwd, setCwd } from "../src/core/cwd.js";
import * as realProvider from "../src/core/llm/provider.js";
import { EXIT_ERROR, EXIT_OK } from "../src/headless/constants.js";
import type { HeadlessEvent } from "../src/headless/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";

/** Each prompt the chat sends gets the next of these answers: text, or a provider error. */
let answers: ({ text: string } | { error: string })[] = [];

const finish: LanguageModelV3StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};

const model = new MockLanguageModelV3({
  doStream: async () => {
    const answer = answers.shift() ?? { text: "no more answers" };
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if ("error" in answer) {
            controller.enqueue({ type: "error", error: new Error(answer.error) });
          } else {
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: answer.text });
            controller.enqueue({ type: "text-end", id: "0" });
          }
          controller.enqueue(finish);
          controller.close();
        },
      }),
    };
  },
});

// Bun keeps a module mock for the rest of the process, so later test files would get this model.
const originalProvider = { ...realProvider };
mock.module("../src/core/llm/provider.js", () => ({
  ...originalProvider,
  resolveModel: () => model,
}));

const { runChat } = await import("../src/headless/run.js");

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let dir = "";
let previousCwd = "";

beforeAll(() => {
  previousCwd = getCwd();
  dir = mkdtempSync(join(tmpdir(), "baked-chat-exit-"));
  setCwd(dir);
});

afterAll(async () => {
  // mock.restore does not undo module replacements in Bun.
  mock.module("../src/core/llm/provider.js", () => originalProvider);
  setCwd(previousCwd);
  await removeTempDir(dir);
});

/** Runs a `--chat --events` session over the given prompts and returns its exit code and events. */
async function chat(prompts: string[]): Promise<{ code: number; events: HeadlessEvent[] }> {
  const events: HeadlessEvent[] = [];
  const queue = [...prompts];
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(Number(code ?? 0));
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await runChat(
      {
        modelId: "anthropic/claude-sonnet-4-5",
        noRepomap: true,
        quiet: true,
        readPrompt: async () => queue.shift() ?? null,
        onEvent: (event) => events.push(event),
      },
      { ...DEFAULT_CONFIG, telemetry: false, mcpServers: [] },
    );
    throw new Error("runChat returned without exiting");
  } catch (err) {
    if (err instanceof Exit) return { code: err.code, events };
    throw err;
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
    process.removeAllListeners("SIGINT");
  }
}

describe("baked --headless --chat exit code", () => {
  test("a chat whose turns all succeed exits 0", async () => {
    answers = [{ text: "one" }, { text: "two" }];
    const { code, events } = await chat(["first", "second"]);
    expect(events.filter((e) => e.type === "turn-done")).toHaveLength(2);
    expect(code).toBe(EXIT_OK);
  });

  test("a turn that fails ends the chat with exit 1", async () => {
    answers = [{ text: "one" }, { error: "You have no credits remaining" }];
    const { code, events } = await chat(["first", "second", "never sent"]);
    const done = events.filter((e) => e.type === "turn-done");
    expect(done).toHaveLength(2);
    expect(done.at(-1)).toMatchObject({ error: "You have no credits remaining" });
    expect(events.at(-1)?.type).toBe("chat-done");
    expect(code).toBe(EXIT_ERROR);
  });
});
