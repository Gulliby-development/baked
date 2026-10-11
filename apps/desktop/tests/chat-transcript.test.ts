import { describe, expect, test } from "bun:test";
import type { ChatEvent, ChatEventBody, SessionDetail } from "../src/renderer/client/chat.ts";
import {
  applyChatEvent,
  emptyTranscript,
  fromDetail,
  isBusy,
  liveId,
  reduceTranscript,
  type Transcript,
} from "../src/renderer/screens/chat/transcript.ts";

const USAGE = { input: 10, output: 5, cacheRead: 0 };

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1",
    title: "Router fallback",
    messageCount: 0,
    startedAt: 1,
    updatedAt: 1,
    state: "idle",
    model: "anthropic/claude-sonnet",
    mode: "default",
    messages: [],
    prompts: [],
    queued: [],
    usage: { input: 0, output: 0, cacheRead: 0 },
    context: null,
    filesEdited: [],
    lastSeq: 0,
    ...overrides,
  };
}

function numbered(bodies: ChatEventBody[], first = 1): ChatEvent[] {
  return bodies.map((body, i) => ({ ...body, seq: first + i, at: 1000 * (first + i) }));
}

const TURN: ChatEventBody[] = [
  {
    type: "turn-start",
    turnId: "t1",
    message: { id: "u1", role: "user", content: "Fix the router", timestamp: 1 },
  },
  { type: "reasoning", turnId: "t1", delta: "Look at " },
  { type: "reasoning", turnId: "t1", delta: "routeRequest." },
  { type: "text", turnId: "t1", delta: "I'll " },
  { type: "text", turnId: "t1", delta: "start there." },
  {
    type: "tool-call",
    turnId: "t1",
    toolCallId: "c1",
    tool: "edit_file",
    input: { path: "src/router.ts", oldString: "a", newString: "b" },
  },
  {
    type: "tool-result",
    turnId: "t1",
    toolCallId: "c1",
    tool: "edit_file",
    success: true,
    output: "Edited",
  },
];

const apply = (state: Transcript, events: ChatEvent[]): Transcript =>
  events.reduce(applyChatEvent, state);

describe("chat transcript", () => {
  test("deltas append to one live assistant message", () => {
    const state = apply(fromDetail(detail()), numbered(TURN.slice(0, 5)));
    expect(state.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(state.live?.id).toBe(liveId("t1"));
    expect(state.live?.content).toBe("I'll start there.");
    expect(state.live?.segments).toEqual([
      { type: "reasoning", id: "reasoning-0", content: "Look at routeRequest." },
      { type: "text", content: "I'll start there." },
    ]);
    // Reasoning ran from the first reasoning delta (2000) to the first text delta (4000).
    expect(state.thoughtMs[liveId("t1")]).toEqual([2000]);
    expect(isBusy(state)).toBe(true);
  });

  test("tool calls start and finish in place and record edited files", () => {
    const state = apply(fromDetail(detail()), numbered(TURN));
    expect(state.live?.toolCalls).toEqual([
      {
        id: "c1",
        name: "edit_file",
        args: { path: "src/router.ts", oldString: "a", newString: "b" },
        result: { success: true, output: "Edited" },
      },
    ]);
    expect(state.live?.segments?.at(-1)).toEqual({ type: "tools", toolCallIds: ["c1"] });
    expect(state.filesEdited).toEqual(["src/router.ts"]);
  });

  test("prompts wait, resolve and clear when the turn ends", () => {
    let state = apply(fromDetail(detail()), numbered(TURN.slice(0, 1)));
    state = apply(
      state,
      numbered(
        [
          {
            type: "prompt",
            prompt: { id: "p1", createdAt: 1, kind: "destructive", description: "rm -rf out" },
          },
          {
            type: "prompt",
            prompt: { id: "p1", createdAt: 1, kind: "destructive", description: "rm -rf out" },
          },
        ],
        2,
      ),
    );
    expect(state.prompts).toHaveLength(1);
    state = applyChatEvent(state, {
      type: "prompt-resolved",
      promptId: "p1",
      outcome: "approved",
      seq: 4,
      at: 4,
    });
    expect(state.prompts[0]?.outcome).toBe("approved");
    state = applyChatEvent(state, {
      type: "turn-done",
      turnId: "t1",
      status: "completed",
      message: { id: "a1", role: "assistant", content: "Done.", timestamp: 5 },
      usage: USAGE,
      durationMs: 4,
      seq: 5,
      at: 5,
    });
    expect(state.prompts).toEqual([]);
    expect(state.live).toBeNull();
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(state.usage).toEqual(USAGE);
    expect(isBusy(state)).toBe(false);
  });

  test("a replay after reconnect does not duplicate anything", () => {
    const events = numbered(TURN);
    const once = apply(fromDetail(detail()), events);
    // The stream reconnects and the server replays from an older Last-Event-ID.
    const again = apply(once, events.slice(2));
    expect(again).toEqual(once);
  });

  test("subscribing after a snapshot skips events the snapshot already holds", () => {
    const snapshot = fromDetail(
      detail({
        lastSeq: 1,
        state: "working",
        messages: [{ id: "u1", role: "user", content: "Fix the router", timestamp: 1 }],
      }),
    );
    const state = apply(snapshot, numbered(TURN));
    expect(state.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(state.live?.content).toBe("I'll start there.");
  });

  test("reasoning durations move to the saved message", () => {
    let state = apply(fromDetail(detail()), numbered(TURN));
    state = applyChatEvent(state, {
      type: "turn-done",
      turnId: "t1",
      status: "interrupted",
      message: { id: "a1", role: "assistant", content: "I'll start there.", timestamp: 9 },
      usage: USAGE,
      durationMs: 9,
      seq: 8,
      at: 9000,
    });
    expect(state.thoughtMs).toEqual({ a1: [2000] });
    expect(state.notice?.kind).toBe("interrupted");
    // The refetch after the turn keeps what only this window knows.
    const refetched = reduceTranscript(state, {
      type: "snapshot",
      detail: detail({ lastSeq: 8, messages: state.messages }),
    });
    expect(refetched.notice?.kind).toBe("interrupted");
    expect(refetched.thoughtMs).toEqual({ a1: [2000] });
  });

  test("a reset asks for a refetch and the next snapshot replaces the transcript", () => {
    let state = apply(fromDetail(detail()), numbered(TURN));
    state = applyChatEvent(state, { type: "reset" });
    expect(state.needsReset).toBe(true);
    state = reduceTranscript(state, { type: "snapshot", detail: detail({ lastSeq: 2 }) });
    expect(state.needsReset).toBe(false);
    expect(state.lastSeq).toBe(2);
    expect(state.live).toBeNull();
  });

  test("a stale snapshot keeps the events already applied", () => {
    const state = apply(fromDetail(detail()), numbered(TURN));
    const next = reduceTranscript(state, {
      type: "snapshot",
      detail: detail({ lastSeq: 3, filesEdited: ["a.ts"] }),
    });
    expect(next.live).toEqual(state.live);
    expect(next.filesEdited).toEqual(["a.ts"]);
  });

  test("pending sends clear when the server echoes them", () => {
    let state = reduceTranscript(fromDetail(detail()), { type: "local-send", text: "Fix the router" });
    expect(state.pending).toEqual(["Fix the router"]);
    state = apply(state, numbered(TURN.slice(0, 1)));
    expect(state.pending).toEqual([]);
    state = reduceTranscript(state, { type: "local-send", text: "also tests" });
    state = applyChatEvent(state, {
      type: "steering",
      turnId: "t1",
      message: { id: "u2", role: "user", content: "also tests", timestamp: 2, isSteering: true },
      seq: 2,
      at: 2,
    });
    expect(state.pending).toEqual([]);
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  test("a failed turn shows its error", () => {
    const state = applyChatEvent(emptyTranscript(), {
      type: "turn-done",
      turnId: "t1",
      status: "failed",
      error: "Provider unavailable",
      message: null,
      usage: USAGE,
      durationMs: 1,
      seq: 1,
      at: 1,
    });
    expect(state.notice).toEqual({ kind: "error", text: "Provider unavailable" });
  });

  test("a compaction keeps the session busy, adds its note and updates the context", () => {
    let state = fromDetail(detail({ context: { usedTokens: 900, windowTokens: 1000, percent: 90 } }));
    state = applyChatEvent(state, { type: "compaction-start", compactionId: "c1", seq: 1, at: 1 });
    expect(state.compacting).toBe(true);
    expect(isBusy(state)).toBe(true);
    expect(state.turnId).toBeNull();
    state = applyChatEvent(state, {
      type: "compaction-done",
      compactionId: "c1",
      status: "compacted",
      compacted: 6,
      context: { usedTokens: 200, windowTokens: 1000, percent: 20 },
      message: { id: "n1", role: "system", content: "Compacted 6 messages", timestamp: 2 },
      seq: 2,
      at: 2,
    });
    expect(state.compacting).toBe(false);
    expect(state.messages.map((m) => m.id)).toEqual(["n1"]);
    expect(state.context?.percent).toBe(20);
    expect(isBusy(state)).toBe(false);
  });

  test("a session loaded while compacting shows the compaction, not a turn", () => {
    const state = fromDetail(detail({ state: "working", compacting: true }));
    expect(state.compacting).toBe(true);
    expect(state.turnId).toBeNull();
    const failed = applyChatEvent(state, {
      type: "compaction-done",
      compactionId: "c1",
      status: "failed",
      error: "model unavailable",
      compacted: 0,
      context: null,
      message: null,
      seq: 1,
      at: 1,
    });
    expect(failed.notice).toEqual({ kind: "error", text: "Compaction failed: model unavailable" });
  });
});
