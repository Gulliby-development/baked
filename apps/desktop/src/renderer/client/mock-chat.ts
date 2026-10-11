import { applyChatEvent, emptyTranscript, type Transcript } from "../screens/chat/transcript.js";
import type {
  ChatEvent,
  ChatEventBody,
  ChatMessage,
  ChatMode,
  ChatPrompt,
  MessageSegment,
  SessionDetail,
  SessionDiffStats,
  SessionSummary,
  ToolCall,
} from "./chat.js";
import { type MockRoute, type MockStream, response } from "./mock-routes.js";

/**
 * Sample chat sessions for the browser preview: a few sessions per sample project, one long
 * conversation like the mockup, and a scripted reply to every message that streams text, reasoning
 * and tool calls and waits for an approval and a question like a real turn.
 */

const MINUTE = 60_000;
const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";

interface MockSession {
  key: string;
  summary: SessionSummary;
  transcript: Transcript;
  listeners: Set<(event: ChatEvent) => void>;
  turn: MockTurn | null;
  queue: string[];
}

interface MockTurn {
  id: string;
  cancelled: boolean;
  startedAt: number;
  waiters: Map<string, (value: boolean | string) => void>;
  /** Pending waits and how to cancel each. */
  timers: Map<ReturnType<typeof setTimeout>, () => void>;
}

class Cancelled extends Error {}

let ids = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++ids}`;

function user(id: string, content: string, at: number): ChatMessage {
  return { id, role: "user", content, timestamp: at };
}

function assistant(
  id: string,
  at: number,
  parts: (string | { reasoning: string } | ToolCall[])[],
): ChatMessage {
  const segments: MessageSegment[] = [];
  const toolCalls: ToolCall[] = [];
  let content = "";
  for (const part of parts) {
    if (typeof part === "string") {
      segments.push({ type: "text", content: part });
      content += part;
    } else if (Array.isArray(part)) {
      toolCalls.push(...part);
      segments.push({ type: "tools", toolCallIds: part.map((c) => c.id) });
    } else segments.push({ type: "reasoning", id: `r${segments.length}`, content: part.reasoning });
  }
  return { id, role: "assistant", content, timestamp: at, toolCalls, segments, durationMs: 94_000 };
}

function tool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
  success = true,
): ToolCall {
  return { id, name, args, result: { success, output, ...(success ? {} : { error: output }) } };
}

function routerConversation(now: number): ChatMessage[] {
  const at = now - 40 * MINUTE;
  return [
    user(
      "m1",
      "When the provider returns 429, the router should fall back to the next model in the chain instead of failing the turn. Keep the retry-after rule we already have, and add a test.",
      at,
    ),
    assistant("m2", at + 2 * MINUTE, [
      {
        reasoning:
          "A 429 is retryable, so the retries run first. The question is what happens after the last retry: the chain should be asked for the next model. The retry-after rule must stay: a long wait still moves on at once.",
      },
      "I'll do it in three steps: find where a 429 leaves the router, send it to the next model in the chain, and cover both paths with a test. The router file is already in your working set, so I started there.\n\n",
      [
        tool(
          "c1",
          "read",
          {
            files: [
              { path: "src/core/llm/router.ts" },
              { path: "src/core/llm/chain.ts" },
              { path: "src/core/llm/retry.ts" },
            ],
          },
          "3 files, 412 lines",
        ),
        tool(
          "c2",
          "navigate",
          { action: "references", symbol: "routeRequest" },
          "7 references in 4 files",
        ),
      ],
      "Found it. `routeRequest` treats 429 as retryable, but after the retries it rethrows instead of asking the chain for the next model. The retry-after rule lives in `waitFor()` and stays as it is: a wait over 30 seconds still moves on immediately.\n\n",
      [
        tool(
          "c3",
          "edit_file",
          {
            path: "src/core/llm/router.ts",
            oldString: "  if (isRetryable(err) && attempt >= maxRetries) {\n    throw err;\n  }",
            newString:
              "  if (isRetryable(err) && attempt >= maxRetries) {\n    const next = chain.next(model);\n    if (next) return routeRequest(req, next, { attempt: 0 });\n    throw new ProviderUnavailable(model, err);\n  }",
          },
          "Edited src/core/llm/router.ts",
        ),
        tool("c4", "write_file", { path: "tests/router.test.ts" }, "Wrote 41 lines"),
        tool(
          "c5",
          "shell",
          { command: "bun test tests/router.test.ts" },
          "bun test v1.4.2\n\ntests/router.test.ts:\n✓ falls back on 429 [3.1ms]\n✓ fails when the chain is exhausted [0.8ms]\n✓ skips a long retry-after [0.4ms]\n\n 12 pass\n 0 fail\nRan 12 tests across 1 file. [1.40s]",
        ),
      ],
      "Done. A 429 on the primary now tries each fallback model once, and the turn fails only when the whole chain is out. The new test covers three cases:\n\n- the fallback succeeds,\n- the chain is exhausted,\n- a long retry-after skips the wait.\n\nOne thing to decide: a fallback that also returns 429 currently counts against the **same** retry budget. Should each model get its own two retries instead?",
    ]),
  ];
}

function shortConversation(now: number, ask: string, answer: string, minutesAgo: number) {
  const at = now - minutesAgo * MINUTE;
  return [
    user(`m-${minutesAgo}-1`, ask, at),
    assistant(`m-${minutesAgo}-2`, at + MINUTE, [answer]),
  ];
}

function seed(): Map<string, MockSession> {
  const now = Date.now();
  const sessions = new Map<string, MockSession>();
  const add = (
    key: string,
    id: string,
    title: string,
    messages: ChatMessage[],
    context: SessionDetail["context"],
  ): void => {
    const updatedAt = messages.at(-1)?.timestamp ?? now;
    const filesEdited = [
      ...new Set(
        messages.flatMap((m) =>
          (m.toolCalls ?? [])
            .filter((c) => ["edit_file", "write_file"].includes(c.name))
            .map((c) => String(c.args.path)),
        ),
      ),
    ].sort();
    const summary: SessionSummary = {
      id,
      title,
      messageCount: messages.length,
      startedAt: messages[0]?.timestamp ?? now,
      updatedAt,
      state: "idle",
      model: DEFAULT_MODEL,
      mode: "default",
    };
    sessions.set(id, {
      key,
      summary,
      transcript: {
        ...emptyTranscript(),
        session: summary,
        messages,
        usage: { input: 61_000, output: 7_400, cacheRead: 48_000 },
        context,
        filesEdited,
      },
      listeners: new Set(),
      turn: null,
      queue: [],
    });
  };
  add("baked", "4f1c2a90-router", "Router fallback on 429", routerConversation(now), {
    usedTokens: 68_000,
    windowTokens: 200_000,
    percent: 34,
  });
  add(
    "baked",
    "8b2d7e11-locales",
    "Locale validation in CI",
    shortConversation(
      now,
      "Why does the locales check fail on my branch?",
      "`locales/en.json` is generated from source, and a key you removed is still in `locales/de.json`. Remove it there too and `bun scripts/validate-locales.ts` passes.",
      180,
    ),
    { usedTokens: 12_000, windowTokens: 200_000, percent: 6 },
  );
  add(
    "baked",
    "c93a0f27-headless",
    "Headless JSON output",
    shortConversation(
      now,
      "Does `baked run --json` print usage?",
      "Yes: the final line carries `usage` with input, output and cache-read tokens.",
      26 * 60,
    ),
    null,
  );
  add(
    "docs",
    "1d0e5b42-guide",
    "Refresh the setup guide",
    shortConversation(
      now,
      "Update the setup guide for the new installer.",
      "I rewrote the install section for the one-line installer and moved the manual steps under **Other ways to install**.",
      300,
    ),
    { usedTokens: 22_000, windowTokens: 200_000, percent: 11 },
  );
  add(
    "docs",
    "e7a6c3d8-links",
    "Fix broken links",
    shortConversation(
      now,
      "Find broken links in the docs.",
      "Two links point at moved pages: `guide/install.md` and `reference/config.md`. I fixed both.",
      50 * 60,
    ),
    null,
  );
  add(
    "site",
    "5c4b3a21-pricing",
    "Pricing table layout",
    shortConversation(
      now,
      "The pricing table overflows on phones.",
      "The table has a fixed `min-width`. I switched it to a stacked layout below 640px.",
      120,
    ),
    { usedTokens: 30_000, windowTokens: 200_000, percent: 15 },
  );
  add(
    "site",
    "9f8e7d6c-dark",
    "Dark mode toggle",
    shortConversation(
      now,
      "Add a dark mode toggle to the header.",
      "Added a toggle that follows the system setting until you pick one.",
      30 * 60,
    ),
    null,
  );
  add(
    "client",
    "2a3b4c5d-auth",
    "Token refresh",
    shortConversation(
      now,
      "Refresh tokens a minute before they expire.",
      "Done: the client schedules a refresh 60 seconds before `expiresAt`.",
      72 * 60,
    ),
    null,
  );
  return sessions;
}

const sessions = seed();

function find(key: string, id: string): MockSession | undefined {
  const session =
    sessions.get(id) ?? [...sessions.values()].find((s) => s.summary.id.startsWith(id));
  return session?.key === key ? session : undefined;
}

function stateOf(session: MockSession): SessionSummary["state"] {
  if (session.transcript.prompts.some((p) => p.outcome === undefined)) return "waiting";
  return session.turn || session.transcript.compacting ? "working" : "idle";
}

function detail(session: MockSession): SessionDetail {
  const t = session.transcript;
  return {
    ...session.summary,
    messageCount: t.messages.length,
    state: stateOf(session),
    messages: t.messages,
    prompts: t.prompts.filter((p) => p.outcome === undefined).map((p) => p.prompt),
    queued: [...session.queue],
    usage: t.usage,
    context: t.context,
    filesEdited: t.filesEdited,
    lastSeq: t.lastSeq,
  };
}

function emit(session: MockSession, body: ChatEventBody): void {
  const event = { ...body, seq: session.transcript.lastSeq + 1, at: Date.now() } as ChatEvent;
  session.transcript = applyChatEvent(session.transcript, event);
  for (const listener of [...session.listeners]) listener(event);
}

function emitSession(session: MockSession): void {
  session.summary = {
    ...session.summary,
    state: stateOf(session),
    compacting: session.transcript.compacting,
    updatedAt: Date.now(),
    messageCount: session.transcript.messages.length,
  };
  emit(session, { type: "session", session: session.summary });
}

function wait(turn: MockTurn, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (turn.cancelled) return reject(new Cancelled());
    const timer = setTimeout(() => {
      turn.timers.delete(timer);
      if (turn.cancelled) reject(new Cancelled());
      else resolve();
    }, ms);
    turn.timers.set(timer, () => reject(new Cancelled()));
  });
}

function ask(session: MockSession, turn: MockTurn, prompt: ChatPrompt): Promise<boolean | string> {
  return new Promise((resolve, reject) => {
    if (turn.cancelled) return reject(new Cancelled());
    turn.waiters.set(prompt.id, resolve);
    emit(session, { type: "prompt", prompt });
    emitSession(session);
  });
}

/** Streams text in small pieces, steering queued messages in between. */
async function say(
  session: MockSession,
  turn: MockTurn,
  text: string,
  type: "text" | "reasoning" = "text",
) {
  const pieces = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < pieces.length; i += 2) {
    await wait(turn, type === "reasoning" ? 45 : 35);
    emit(session, { type, turnId: turn.id, delta: pieces.slice(i, i + 2).join("") });
  }
  steer(session, turn);
}

function steer(session: MockSession, turn: MockTurn): void {
  if (session.queue.length === 0) return;
  const text = session.queue.splice(0).join("\n\n");
  emit(session, {
    type: "steering",
    turnId: turn.id,
    message: { ...user(nextId("m"), text, Date.now()), isSteering: true },
  });
}

async function runTool(
  session: MockSession,
  turn: MockTurn,
  name: string,
  input: Record<string, unknown>,
  output: string,
  approval?: ChatPrompt,
): Promise<boolean> {
  const toolCallId = nextId("call");
  emit(session, { type: "tool-call", turnId: turn.id, toolCallId, tool: name, input });
  let allowed = true;
  if (approval) allowed = (await ask(session, turn, approval)) === true;
  await wait(turn, allowed ? 700 : 100);
  emit(session, {
    type: "tool-result",
    turnId: turn.id,
    toolCallId,
    tool: name,
    success: allowed,
    output: allowed ? output : "Denied by the user.",
    ...(allowed ? {} : { error: "Denied by the user." }),
  });
  return allowed;
}

async function script(session: MockSession, turn: MockTurn, text: string): Promise<void> {
  const topic = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  await say(
    session,
    turn,
    `The request is "${topic}". I should read the code involved before changing anything, then run the tests.`,
    "reasoning",
  );
  await wait(turn, 400);
  await say(session, turn, "Let me look at the current code first.\n\n");
  await runTool(
    session,
    turn,
    "read",
    { files: [{ path: "src/core/llm/router.ts" }, { path: "src/core/llm/chain.ts" }] },
    "2 files, 298 lines",
  );
  await say(
    session,
    turn,
    "The chain already has a `next()` method, so each model can keep its own retry count. I'll move the counter into the chain entry.\n\n",
  );
  await runTool(
    session,
    turn,
    "edit_file",
    {
      path: "src/core/llm/chain.ts",
      oldString: "export interface ChainEntry {\n  model: string;\n}",
      newString: "export interface ChainEntry {\n  model: string;\n  retries: number;\n}",
    },
    "Edited src/core/llm/chain.ts",
  );
  const passed = await runTool(
    session,
    turn,
    "shell",
    { command: "rm -rf .cache/router && bun test tests/router.test.ts" },
    " 13 pass\n 0 fail\nRan 13 tests across 1 file. [1.52s]",
    {
      id: nextId("prompt"),
      createdAt: Date.now(),
      kind: "destructive",
      description: "rm -rf .cache/router && bun test tests/router.test.ts",
    },
  );
  await say(
    session,
    turn,
    passed
      ? "All 13 tests pass, including a new case where the fallback returns 429 too.\n\n"
      : "Okay, I did not run it. The edit is in place; run the tests when you are ready.\n\n",
  );
  const answer = await ask(session, turn, {
    id: nextId("prompt"),
    createdAt: Date.now(),
    kind: "question",
    question: "Should the per-model retry count also apply to the streaming path?",
    allowSkip: true,
    options: [
      { label: "Yes, both paths", value: "yes", description: "Streaming and plain requests" },
      { label: "Only plain requests", value: "no" },
    ],
  });
  await say(
    session,
    turn,
    answer === "__skipped__" || answer === ""
      ? "I'll leave the streaming path for now."
      : `Noted: **${String(answer)}**. I'll keep that in the summary for the pull request.`,
  );
}

async function startTurn(session: MockSession, text: string): Promise<string> {
  const turn: MockTurn = {
    id: nextId("turn"),
    cancelled: false,
    startedAt: Date.now(),
    waiters: new Map(),
    timers: new Map(),
  };
  session.turn = turn;
  emit(session, {
    type: "turn-start",
    turnId: turn.id,
    message: user(nextId("m"), text, Date.now()),
  });
  emitSession(session);
  void (async () => {
    let status: "completed" | "interrupted" = "completed";
    try {
      await script(session, turn, text);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      status = "interrupted";
    }
    for (const p of session.transcript.prompts)
      if (p.outcome === undefined)
        emit(session, { type: "prompt-resolved", promptId: p.prompt.id, outcome: "denied" });
    const live = session.transcript.live;
    const usage = { input: 9_200, output: 640, cacheRead: 7_800 };
    emit(session, { type: "step", turnId: turn.id, step: 1, usage });
    session.turn = null;
    emit(session, {
      type: "turn-done",
      turnId: turn.id,
      status,
      message: live ? { ...live, id: nextId("m"), durationMs: Date.now() - turn.startedAt } : null,
      usage,
      durationMs: Date.now() - turn.startedAt,
    });
    const context = session.transcript.context;
    if (context) {
      const usedTokens = context.usedTokens + 9_840;
      session.transcript = {
        ...session.transcript,
        context: {
          ...context,
          usedTokens,
          percent: Math.round((usedTokens / context.windowTokens) * 100),
        },
      };
    }
    emitSession(session);
    if (session.queue.length > 0 && status === "completed")
      void startTurn(session, session.queue.splice(0).join("\n\n"));
    else session.queue = [];
  })();
  return turn.id;
}

function interrupt(session: MockSession): boolean {
  const turn = session.turn;
  if (!turn) return false;
  turn.cancelled = true;
  for (const [timer, cancel] of turn.timers) {
    clearTimeout(timer);
    cancel();
  }
  turn.timers.clear();
  for (const [id, resolve] of turn.waiters) {
    turn.waiters.delete(id);
    resolve(false);
  }
  return true;
}

function create(
  key: string,
  body: { title?: string; model?: string; mode?: ChatMode; text?: string },
) {
  const now = Date.now();
  const text = body.text?.trim();
  const summary: SessionSummary = {
    id: crypto.randomUUID(),
    title: body.title ?? (text ? text.slice(0, 50) : "New session"),
    messageCount: 0,
    startedAt: now,
    updatedAt: now,
    state: "idle",
    model: body.model ?? DEFAULT_MODEL,
    mode: body.mode ?? "default",
  };
  const session: MockSession = {
    key,
    summary,
    transcript: {
      ...emptyTranscript(),
      session: summary,
      context: { usedTokens: 4_000, windowTokens: 200_000, percent: 2 },
    },
    listeners: new Set(),
    turn: null,
    queue: [],
  };
  sessions.set(summary.id, session);
  if (text) void startTurn(session, text);
  return session;
}

/** Summarizes all but the last four messages after a short pause, as the server would. */
function compact(session: MockSession) {
  if (session.turn || session.transcript.compacting)
    return response(409, { error: { code: "SESSION_BUSY", message: "Busy" } });
  const older = session.transcript.messages.filter((m) => m.role !== "system").length;
  if (older < 2)
    return response(409, {
      error: { code: "NOTHING_TO_COMPACT", message: "Not enough conversation to compact." },
    });
  const compactionId = nextId("compact");
  emit(session, { type: "compaction-start", compactionId });
  emitSession(session);
  setTimeout(() => {
    const context = session.transcript.context;
    const after = context
      ? { ...context, usedTokens: 9_000, percent: Math.round((9_000 / context.windowTokens) * 100) }
      : null;
    emit(session, {
      type: "compaction-done",
      compactionId,
      status: "compacted",
      compacted: older,
      context: after,
      message: {
        id: nextId("m"),
        role: "system",
        content: `Compacted ${older} messages into a summary (v2 strategy).${after ? ` Context is now about ${after.percent}%.` : ""}`,
        timestamp: Date.now(),
      },
    });
    emitSession(session);
  }, 1200);
  return response(202, { compactionId });
}

/** Made-up line counts per edited file, stable for a path. */
function diffStats(session: MockSession): SessionDiffStats {
  const files = session.transcript.filesEdited.map((path) => {
    const seed = [...path].reduce((sum, c) => sum + c.charCodeAt(0), 0);
    return { path, status: "modified" as const, added: (seed % 40) + 2, removed: seed % 9 };
  });
  return {
    base: "HEAD",
    files,
    totals: {
      files: files.length,
      added: files.reduce((sum, f) => sum + f.added, 0),
      removed: files.reduce((sum, f) => sum + f.removed, 0),
    },
  };
}

const SESSION_PATH =
  /^\/v1\/sessions\/([A-Za-z0-9-]+)(?:\/(messages|interrupt|prompts|fork|compact|diff)(?:\/([A-Za-z0-9-]+))?)?$/;

const chatRoutes: MockRoute = async ({ key, method, path, query, body }) => {
  if (path === "/v1/models" && method === "GET")
    return response(200, {
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          configured: true,
          models: [
            {
              id: "anthropic/claude-sonnet-5-5",
              name: "Claude Sonnet 5.5",
              contextWindow: 200_000,
            },
            { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000 },
            { id: "anthropic/claude-haiku-5", name: "Claude Haiku 5", contextWindow: 200_000 },
          ],
        },
        { id: "openai", name: "OpenAI", configured: false, models: [] },
      ],
    });
  if (path === "/v1/mentions" && method === "GET") {
    const q = (query.get("q") ?? "").toLowerCase();
    const all = [
      { kind: "directory", insert: "src/core/llm/", detail: "directory" },
      { kind: "file", insert: "src/core/llm/models.ts", detail: "file" },
      { kind: "file", insert: "src/core/llm/provider.ts", detail: "file" },
      { kind: "file", insert: "README.md", detail: "file" },
      { kind: "symbol", insert: "resolveModel", detail: "function · src/core/llm/provider.ts:42" },
    ];
    const mentions = all
      .filter((m) => m.insert.toLowerCase().includes(q))
      .map((m) => ({ ...m, label: m.insert, indices: [] }));
    return response(200, { mentions });
  }
  if (path === "/v1/projects/current" && method === "GET")
    return response(200, {
      workingSet: {
        entries: ["src/core/llm/"],
        files: Array.from({ length: 11 }, (_, i) => ({
          path: `src/core/llm/f${i}.ts`,
          bytes: 2048,
        })),
      },
    });
  if (path === "/v1/sessions") {
    if (method === "GET") {
      const limit = Number(query.get("limit") ?? 50);
      const list = [...sessions.values()]
        .filter((s) => s.key === key)
        .map((s) => ({ ...s.summary, state: stateOf(s) }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
      return response(200, { sessions: list });
    }
    return response(201, detail(create(key, (body ?? {}) as Parameters<typeof create>[1])));
  }
  const match = SESSION_PATH.exec(path);
  if (!match?.[1]) return undefined;
  const session = find(key, match[1]);
  if (!session)
    return response(404, { error: { code: "NOT_FOUND", message: `No session ${match[1]}` } });
  const [, , action, sub] = match;
  if (!action) {
    if (method === "GET") return response(200, detail(session));
    const changes = (body ?? {}) as { title?: string; model?: string; mode?: ChatMode };
    session.summary = {
      ...session.summary,
      ...(changes.title ? { title: changes.title } : {}),
      ...(changes.model ? { model: changes.model } : {}),
      ...(changes.mode ? { mode: changes.mode } : {}),
    };
    emitSession(session);
    return response(200, session.summary);
  }
  if (action === "messages") {
    const text = String((body as { text?: unknown } | null)?.text ?? "").trim();
    if (!text) return response(400, { error: { code: "INVALID_REQUEST", message: "Empty text" } });
    if (session.turn) {
      session.queue.push(text);
      return response(202, { turnId: session.turn.id, queued: true });
    }
    return response(202, { turnId: await startTurn(session, text), queued: false });
  }
  if (action === "interrupt") return response(200, { interrupted: interrupt(session) });
  if (action === "fork") {
    const request = (body ?? {}) as { atMessageId?: string; rollbackFiles?: boolean };
    const all = session.transcript.messages;
    const at = request.atMessageId
      ? all.findIndex((m) => m.id === request.atMessageId)
      : all.length - 1;
    if (at < 0) return response(404, { error: { code: "NOT_FOUND", message: "No such message" } });
    const forked = create(key, {
      title: `${session.summary.title} (fork)`,
      mode: session.summary.mode,
    });
    forked.transcript = { ...forked.transcript, messages: all.slice(0, at + 1) };
    forked.summary = { ...forked.summary, messageCount: at + 1 };
    const rollback = request.rollbackFiles
      ? { checkpoint: 1, snapshot: null, backupTag: null, restored: [], removed: [], skipped: [] }
      : undefined;
    return response(201, { ...detail(forked), ...(rollback ? { rollback } : {}) });
  }
  if (action === "compact") return compact(session);
  if (action === "diff") return response(200, diffStats(session));
  const resolve = sub ? session.turn?.waiters.get(sub) : undefined;
  if (!sub || !resolve)
    return response(409, { error: { code: "STALE_PROMPT", message: "Not waiting" } });
  const answer = (body ?? {}) as { approve?: boolean; answer?: string };
  session.turn?.waiters.delete(sub);
  const outcome =
    answer.answer !== undefined
      ? answer.answer === ""
        ? "skipped"
        : "answered"
      : answer.approve
        ? "approved"
        : "denied";
  emit(session, { type: "prompt-resolved", promptId: sub, outcome });
  emitSession(session);
  resolve(answer.answer !== undefined ? answer.answer || "__skipped__" : answer.approve === true);
  return response(200, { resolved: true });
};

const EVENTS_PATH = /^\/v1\/sessions\/([A-Za-z0-9-]+)\/events/;

const chatStream: MockStream = ({ key, path, emit: send }) => {
  const match = EVENTS_PATH.exec(path);
  if (!match?.[1]) return undefined;
  const session = find(key, match[1]);
  if (!session) return () => {};
  const listener = (event: ChatEvent): void => {
    if (event.type === "reset") return;
    send({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
  };
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
};

export const MOCK_CHAT_ROUTES: MockRoute[] = [chatRoutes];
export const MOCK_CHAT_STREAMS: MockStream[] = [chatStream];
