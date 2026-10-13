import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { emitMultiAgentEvent } from "../src/core/agents/subagent-events.js";
import {
  type ChatAgentHost,
  type ChatEvent,
  ChatService,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import {
  compactHooks,
  notificationHooks,
  resetSessionHooks,
  type SessionStartSource,
  startSessionHooks,
  stopHooks,
  takeHookContext,
  userPromptHooks,
  watchSubagentHooks,
} from "../src/core/hooks/lifecycle.js";
import { invalidateHooksCache } from "../src/core/hooks/loader.js";
import { hasToolHooks } from "../src/core/hooks/runner.js";
import type { AppConfig } from "../src/types/index.js";

// Every Claude Code hook event BAKED fires, with the fields and matcher target Claude Code gives it.

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const emptyHome = mkdtempSync(join(tmpdir(), "baked-hook-events-home-"));
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetSessionHooks();
  invalidateHooksCache();
});

type HookInputLine = Record<string, unknown> & { hook_event_name: string };

/** A rule of `.claude/settings.json`: its matcher, and whether its hook prints plain text. */
interface Rule {
  matcher?: string;
  plain?: boolean;
}

/**
 * A workspace whose `.claude/settings.json` has the given rules. Each hook appends its input to
 * `hooks.log`; a `plain` one also prints a line of plain text.
 */
function workspace(rules: Record<string, Rule[]>) {
  const root = mkdtempSync(join(tmpdir(), "baked-hook-events-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "hooks.log");
  const script = join(root, "hook.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");
if (process.argv[2] === "plain") console.log("plain context from " + input.hook_event_name);
`,
  );
  const command = (rule: Rule) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}${rule.plain ? " plain" : ""}`;
  mkdirSync(join(root, ".claude"));
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        Object.entries(rules).map(([event, list]) => [
          event,
          list.map((rule) => ({
            ...(rule.matcher ? { matcher: rule.matcher } : {}),
            hooks: [{ type: "command", command: command(rule) }],
          })),
        ]),
      ),
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

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30));
}

describe("SessionStart", () => {
  const SOURCES: SessionStartSource[] = ["startup", "resume", "clear", "compact", "fork"];

  test("an agent-state script's matcher ^(startup|resume|clear|compact|fork)$ matches every source", async () => {
    const { root, read } = workspace({
      SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$" }],
    });
    for (const source of SOURCES) await startSessionHooks(`s-${source}`, root, source);
    expect(read().map((i) => [i.hook_event_name, i.source, i.session_id])).toEqual(
      SOURCES.map((source) => ["SessionStart", source, `s-${source}`]),
    );
  });

  test("a matcher picks sources", async () => {
    const { root, read } = workspace({ SessionStart: [{ matcher: "compact|fork" }] });
    for (const source of SOURCES) await startSessionHooks(`s-${source}`, root, source);
    expect(read().map((i) => i.source)).toEqual(["compact", "fork"]);
  });

  test("plain stdout is context for the session's next prompt", async () => {
    const { root } = workspace({ SessionStart: [{ plain: true }] });
    await startSessionHooks("s1", root, "startup");
    expect(takeHookContext("s1")).toBe("plain context from SessionStart");
  });
});

describe("UserPromptSubmit", () => {
  test("plain stdout is context for the prompt", async () => {
    const { root } = workspace({ UserPromptSubmit: [{ plain: true }] });
    const result = await userPromptHooks("s1", root, "hello");
    expect(result).toMatchObject({
      blocked: false,
      additionalContext: "plain context from UserPromptSubmit",
    });
  });
});

describe("Stop and StopFailure", () => {
  test("carry Claude Code's top-level fields", async () => {
    const { root, read } = workspace({ Stop: [{}], StopFailure: [{}] });
    await stopHooks("s1", root, { failed: false });
    await stopHooks("s1", root, { failed: true, error: "rate limited" });
    expect(read()).toMatchObject([
      { hook_event_name: "Stop", stop_hook_active: false },
      { hook_event_name: "StopFailure", error: "rate limited" },
    ]);
  });
});

describe("PreCompact and PostCompact", () => {
  test("carry the trigger and match against it", async () => {
    const { root, read } = workspace({
      PreCompact: [{ matcher: "auto" }],
      PostCompact: [{ matcher: "manual" }],
    });
    for (const trigger of ["manual", "auto"] as const) {
      await compactHooks("s1", root, "pre", trigger);
      await compactHooks("s1", root, "post", trigger);
    }
    expect(read().map((i) => [i.hook_event_name, i.trigger])).toEqual([
      ["PostCompact", "manual"],
      ["PreCompact", "auto"],
    ]);
  });
});

describe("Notification", () => {
  test("matches against notification_type and carries the message", async () => {
    const { root, read } = workspace({ Notification: [{ matcher: "permission_prompt" }] });
    await notificationHooks({ sessionId: "s1", cwd: root, type: "question", message: "Which?" });
    await notificationHooks({
      sessionId: "s1",
      cwd: root,
      type: "permission_prompt",
      message: "BAKED needs your permission",
    });
    expect(read()).toMatchObject([
      {
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "BAKED needs your permission",
      },
    ]);
  });
});

describe("SubagentStart and SubagentStop", () => {
  test("fire for this turn's subagents with agent_id and agent_type, matched by role", async () => {
    const { root, read } = workspace({
      SubagentStart: [{ matcher: "explore" }],
      SubagentStop: [{}],
    });
    const stop = watchSubagentHooks({ cwd: root, sessionId: () => "s1" }, (id) => id === "call-1");
    emitMultiAgentEvent({ type: "agent-start", parentToolCallId: "call-1", agentId: "a1", role: "explore" });
    emitMultiAgentEvent({ type: "agent-start", parentToolCallId: "call-1", agentId: "a2", role: "code" });
    emitMultiAgentEvent({ type: "agent-start", parentToolCallId: "other", agentId: "a3", role: "explore" });
    emitMultiAgentEvent({ type: "agent-done", parentToolCallId: "call-1", agentId: "a1", role: "explore" });
    stop();
    emitMultiAgentEvent({ type: "agent-done", parentToolCallId: "call-1", agentId: "a2", role: "code" });
    await eventually(() => read().length >= 2);
    await new Promise((r) => setTimeout(r, 200));
    const lines = read().sort((a, b) => a.hook_event_name.localeCompare(b.hook_event_name));
    expect(lines).toMatchObject([
      { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "explore", session_id: "s1" },
      { hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "explore", stop_hook_active: false },
    ]);
    expect(lines).toHaveLength(2);
  });
});

describe("PostToolUseFailure", () => {
  // #913: tools were wrapped only for PreToolUse or PostToolUse hooks.
  test("a config with only PostToolUseFailure hooks wraps the tools", () => {
    const { root } = workspace({ PostToolUseFailure: [{}] });
    expect(hasToolHooks(root)).toBe(true);
  });
});

/** A host whose agent answers "ok". */
class ScriptedHost implements ChatAgentHost {
  async agent(_request: TurnAgentRequest) {
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[] }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" };
            yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 2 } };
          })(),
          responseMessages: Promise.resolve([]),
        }),
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
  test("a forked chat starts with the source fork", async () => {
    const { root, read } = workspace({ SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$" }] });
    const service = new ChatService({
      workspace: root,
      config: {} as AppConfig,
      host: new ScriptedHost(),
      homeDir: emptyHome,
    });
    const first = await service.create({ model: "test/model" });
    await turnDone(service, first.id, "first prompt");
    const { session: fork } = await service.fork(first.id);
    await turnDone(service, fork.id, "in the fork");
    await service.shutdown();
    expect(read().map((i) => [i.session_id, i.source])).toEqual([
      [first.id, "startup"],
      [fork.id, "fork"],
    ]);
  });
});
