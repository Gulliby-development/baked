import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  type ChatAgentHost,
  type ChatEvent,
  ChatService,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import {
  endAllSessionHooks,
  resetSessionHooks,
  startSessionHooks,
  takeHookContext,
  userPromptHooks,
} from "../src/core/hooks/lifecycle.js";
import { invalidateHooksCache } from "../src/core/hooks/loader.js";
import type { AppConfig } from "../src/types/index.js";

// The loader merges the user's own ~/.claude and ~/.baked hooks; point home at an empty profile.
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const emptyHome = mkdtempSync(join(tmpdir(), "baked-lifecycle-home-"));
beforeAll(() => {
  process.env.HOME = emptyHome;
  process.env.USERPROFILE = emptyHome;
  invalidateHooksCache();
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateHooksCache();
  rmSync(emptyHome, { recursive: true, force: true });
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetSessionHooks();
  invalidateHooksCache();
});

type HookInputLine = Record<string, unknown> & { hook_event_name: string };

/**
 * A workspace whose `.claude/settings.json` registers one hook script for every lifecycle event.
 * The script appends its input to `hooks.log`, gives SessionStart context, and blocks prompts
 * that contain "forbidden".
 */
function workspace(events: string[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-lifecycle-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "hooks.log");
  const script = join(root, "hook.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");
if (input.hook_event_name === "SessionStart")
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "started by " + input.source } }));
if (input.hook_event_name === "UserPromptSubmit" && input.prompt.includes("forbidden")) {
  console.error("no forbidden prompts");
  process.exit(2);
}
`,
  );
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  mkdirSync(join(root, ".claude"));
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command }] }]])),
    }),
  );
  invalidateHooksCache();
  const read = (): HookInputLine[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as HookInputLine)
      : [];
  return { root, read };
}

const ALL = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "Notification"];

describe("session lifecycle hooks", () => {
  test("SessionStart gives its context once and SessionEnd fires once per start", async () => {
    const { root, read } = workspace(ALL);
    await startSessionHooks("s1", root, "startup");
    expect(takeHookContext("s1")).toBe("started by startup");
    expect(takeHookContext("s1")).toBeUndefined();
    await endAllSessionHooks("prompt_input_exit");
    await endAllSessionHooks("prompt_input_exit");
    expect(read().map((i) => [i.hook_event_name, i.source ?? i.reason])).toEqual([
      ["SessionStart", "startup"],
      ["SessionEnd", "prompt_input_exit"],
    ]);
  });

  // #913: UserPromptSubmit ran only when PreToolUse or PostToolUse hooks existed.
  test("UserPromptSubmit runs when it is the only hook, with Claude Code's prompt field", async () => {
    const { root, read } = workspace(["UserPromptSubmit"]);
    expect((await userPromptHooks("s1", root, "hello")).blocked).toBe(false);
    const blocked = await userPromptHooks("s1", root, "a forbidden prompt");
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe("no forbidden prompts");
    expect(read().map((i) => i.prompt)).toEqual(["hello", "a forbidden prompt"]);
  });
});

/** A host whose agent answers "ok" and records what the model was sent. */
class ScriptedHost implements ChatAgentHost {
  seen: ModelMessage[][] = [];
  async agent(_request: TurnAgentRequest) {
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[] }) => {
          this.seen.push(args.messages);
          return {
            stream: (async function* () {
              yield { type: "text-delta", text: "ok" };
              yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 2 } };
            })(),
            responseMessages: Promise.resolve([]),
          };
        },
      },
    };
  }
  release() {}
  async dispose() {}
}

async function turnDone(service: ChatService, id: string, text: string): Promise<ChatEvent> {
  const session = service.get(id);
  const done = new Promise<ChatEvent>((resolve) => {
    const stop = session.subscribe(session.summary().lastSeq, (event) => {
      if (event.type !== "turn-done") return;
      stop?.();
      resolve(event);
    });
  });
  session.send(text);
  return done;
}

describe("a desktop chat (baked serve)", () => {
  test("fires SessionStart, UserPromptSubmit, Stop and SessionEnd, and sends the hook context", async () => {
    const { root, read } = workspace(ALL);
    const host = new ScriptedHost();
    const service = new ChatService({ workspace: root, config: {} as AppConfig, host, homeDir: emptyHome });
    const session = await service.create({ model: "test/model" });

    await turnDone(service, session.id, "first prompt");
    const blocked = await turnDone(service, session.id, "a forbidden prompt");
    expect(blocked).toMatchObject({ status: "failed" });
    expect(String((blocked as { error?: string }).error)).toContain("no forbidden prompts");
    await service.shutdown();
    // Stop runs in the background once the turn is done.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sent = host.seen[0]?.at(-1)?.content;
    expect(String(sent)).toBe("started by startup\n\nfirst prompt");
    expect(host.seen).toHaveLength(1);
    const events = read().map((i) => i.hook_event_name);
    expect(events.filter((e) => e === "SessionStart")).toHaveLength(1);
    expect(events.filter((e) => e === "UserPromptSubmit")).toHaveLength(2);
    expect(events.filter((e) => e === "Stop")).toHaveLength(1);
    expect(read().find((i) => i.hook_event_name === "SessionEnd")).toMatchObject({
      session_id: session.id,
      reason: "prompt_input_exit",
    });
  });
});
