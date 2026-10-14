import type { StreamEvent } from "../../../shared/api.js";
import type {
  ChatEvent,
  ChatMessage,
  ChatPlan,
  ChatPrompt,
  ContextFill,
  MessageSegment,
  PlanAction,
  PromptOutcome,
  RedoTurn,
  SessionDetail,
  SessionSummary,
  ToolCall,
  Usage,
} from "../../client/chat.js";

/**
 * The transcript of one chat session as the screen shows it: the saved messages from
 * `GET /v1/sessions/ID`, plus the turn that is streaming, built from session events. Pure, so the
 * screen and the mock backend share it and the tests drive it without a DOM.
 */

export interface TranscriptPrompt {
  prompt: ChatPrompt;
  /** Set once the prompt was answered; resolved prompts stay visible until the turn ends. */
  outcome?: PromptOutcome;
  /** How a plan review was answered. */
  action?: PlanAction;
}

export interface Transcript {
  session: SessionSummary | null;
  messages: ChatMessage[];
  /** The assistant message of the running turn, assembled from deltas. */
  live: ChatMessage | null;
  turnId: string | null;
  prompts: TranscriptPrompt[];
  /** Texts sent from this window that no event has echoed yet. */
  pending: string[];
  usage: Usage;
  turnUsage: Usage | null;
  context: ContextFill | null;
  filesEdited: string[];
  /** The last applied event sequence; events at or below it are replays and are skipped. */
  lastSeq: number;
  /** The server could not resume the stream: refetch the session and resubscribe. */
  needsReset: boolean;
  notice: { kind: "error" | "interrupted"; text: string } | null;
  /** Reasoning durations in milliseconds per message ID, in the order of its reasoning segments. */
  thoughtMs: Record<string, number[]>;
  /** When the reasoning segment that is streaming now started. */
  thinkingSince: number | null;
  /** A manual compaction ("Compact now") is running. */
  compacting: boolean;
  /** The plan being reviewed or carried out, with its step statuses. */
  plan: ChatPlan | null;
  /** Turns an undo dropped that Redo puts back, oldest first. */
  redo: RedoTurn[];
}

export type TranscriptAction =
  | ChatEvent
  | { type: "snapshot"; detail: SessionDetail }
  | { type: "local-send"; text: string }
  | { type: "local-send-failed"; text: string };

const EVENT_TYPES = new Set([
  "turn-start",
  "text",
  "reasoning",
  "tool-call",
  "tool-result",
  "steering",
  "rewind",
  "prompt",
  "prompt-resolved",
  "plan",
  "notice",
  "step",
  "turn-done",
  "compaction-start",
  "compaction-done",
  "session",
  "watch",
  "launched",
]);

/** Reads one SSE frame of `/v1/sessions/ID/events`; null for frames the app does not know. */
export function parseChatEvent(event: StreamEvent): ChatEvent | null {
  if (event.event === "reset") return { type: "reset" };
  if (!EVENT_TYPES.has(event.event)) return null;
  try {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    const seq = typeof data.seq === "number" ? data.seq : Number(event.id);
    if (!Number.isFinite(seq)) return null;
    return {
      ...data,
      type: event.event,
      seq,
      at: typeof data.at === "number" ? data.at : 0,
    } as ChatEvent;
  } catch {
    return null;
  }
}

const EDIT_TOOLS = new Set(["edit_file", "write_file", "create_file", "multi_edit"]);
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0 };

export function emptyTranscript(): Transcript {
  return {
    session: null,
    messages: [],
    live: null,
    turnId: null,
    prompts: [],
    pending: [],
    usage: ZERO,
    turnUsage: null,
    context: null,
    filesEdited: [],
    lastSeq: 0,
    needsReset: false,
    notice: null,
    thoughtMs: {},
    thinkingSince: null,
    compacting: false,
    plan: null,
    redo: [],
  };
}

export function fromDetail(detail: SessionDetail, previous?: Transcript): Transcript {
  const {
    messages,
    prompts,
    queued,
    usage,
    context,
    filesEdited,
    lastSeq,
    plan,
    redo,
    ...session
  } = detail;
  const compacting = session.compacting === true;
  const working = session.state !== "idle" && !compacting;
  return {
    ...emptyTranscript(),
    session,
    messages,
    prompts: prompts.map((prompt) => ({ prompt })),
    usage,
    context,
    filesEdited,
    lastSeq,
    plan: plan ?? null,
    // A turn that runs while the page loads: its finished message arrives with `turn-done`.
    turnId: working ? "running" : null,
    compacting,
    redo: redo ?? [],
    ...(previous?.session?.id === session.id
      ? { pending: previous.pending, thoughtMs: previous.thoughtMs, notice: previous.notice }
      : {}),
  };
}

export const liveId = (turnId: string): string => `live:${turnId}`;

function removeFirst(list: string[], text: string): string[] {
  const index = list.indexOf(text);
  return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
}

function liveMessage(state: Transcript, turnId: string, at: number): ChatMessage {
  return (
    state.live ?? {
      id: liveId(turnId),
      role: "assistant",
      content: "",
      timestamp: at,
      toolCalls: [],
      segments: [],
    }
  );
}

/** Closes the reasoning segment that is streaming, recording how long it took. */
function stopThinking(state: Transcript, at: number): Transcript {
  if (state.thinkingSince === null || !state.live) return state;
  const id = state.live.id;
  return {
    ...state,
    thinkingSince: null,
    thoughtMs: {
      ...state.thoughtMs,
      [id]: [...(state.thoughtMs[id] ?? []), Math.max(0, at - state.thinkingSince)],
    },
  };
}

function withSegment(segments: MessageSegment[], add: MessageSegment): MessageSegment[] {
  const last = segments.at(-1);
  if (add.type === "text" && last?.type === "text")
    return [...segments.slice(0, -1), { type: "text", content: last.content + add.content }];
  if (add.type === "reasoning" && last?.type === "reasoning")
    return [
      ...segments.slice(0, -1),
      { type: "reasoning", id: last.id, content: last.content + add.content },
    ];
  if (add.type === "tools" && last?.type === "tools")
    return [
      ...segments.slice(0, -1),
      { type: "tools", toolCallIds: [...last.toolCallIds, ...add.toolCallIds] },
    ];
  return [...segments, add];
}

function addFiles(files: string[], add: (string | undefined)[]): string[] {
  const next = new Set(files);
  for (const file of add) if (file) next.add(file);
  return next.size === files.length ? files : [...next].sort();
}

/** Applies one session event; replayed events (sequence at or below `lastSeq`) change nothing. */
export function applyChatEvent(state: Transcript, event: ChatEvent): Transcript {
  if (event.type === "reset") return { ...state, needsReset: true };
  if (event.seq <= state.lastSeq) return state;
  const next = applyBody({ ...state, lastSeq: event.seq }, event);
  return next;
}

function applyBody(state: Transcript, event: Exclude<ChatEvent, { type: "reset" }>): Transcript {
  switch (event.type) {
    case "turn-start": {
      const known = state.messages.some((m) => m.id === event.message.id);
      return {
        ...state,
        messages: known ? state.messages : [...state.messages, event.message],
        pending: removeFirst(state.pending, event.message.content),
        live: null,
        turnId: event.turnId,
        turnUsage: null,
        notice: null,
        thinkingSince: null,
        session: state.session ? { ...state.session, state: "working" } : null,
      };
    }
    case "text": {
      const stopped = stopThinking(state, event.at);
      const live = liveMessage(stopped, event.turnId, event.at);
      return {
        ...stopped,
        turnId: event.turnId,
        live: {
          ...live,
          content: live.content + event.delta,
          segments: withSegment(live.segments ?? [], { type: "text", content: event.delta }),
        },
      };
    }
    case "reasoning": {
      const live = liveMessage(state, event.turnId, event.at);
      const segments = live.segments ?? [];
      const continues = segments.at(-1)?.type === "reasoning";
      return {
        ...state,
        turnId: event.turnId,
        thinkingSince: continues && state.thinkingSince !== null ? state.thinkingSince : event.at,
        live: {
          ...live,
          segments: withSegment(segments, {
            type: "reasoning",
            id: `reasoning-${segments.length}`,
            content: event.delta,
          }),
        },
      };
    }
    case "tool-call": {
      const stopped = stopThinking(state, event.at);
      const live = liveMessage(stopped, event.turnId, event.at);
      if (live.toolCalls?.some((c) => c.id === event.toolCallId)) return stopped;
      const args =
        event.input && typeof event.input === "object"
          ? (event.input as Record<string, unknown>)
          : {};
      return {
        ...stopped,
        turnId: event.turnId,
        live: {
          ...live,
          toolCalls: [...(live.toolCalls ?? []), { id: event.toolCallId, name: event.tool, args }],
          segments: withSegment(live.segments ?? [], {
            type: "tools",
            toolCallIds: [event.toolCallId],
          }),
        },
      };
    }
    case "tool-result": {
      const stopped = stopThinking(state, event.at);
      const live = liveMessage(stopped, event.turnId, event.at);
      const calls = live.toolCalls ?? [];
      const existing = calls.find((c) => c.id === event.toolCallId);
      const result = {
        success: event.success,
        output: event.output,
        ...(event.error ? { error: event.error } : {}),
        ...(event.filesEdited ? { filesEdited: event.filesEdited } : {}),
      };
      const call: ToolCall = existing
        ? { ...existing, result }
        : { id: event.toolCallId, name: event.tool, args: {}, result };
      const path = typeof call.args.path === "string" ? call.args.path : undefined;
      return {
        ...stopped,
        turnId: event.turnId,
        filesEdited: addFiles(stopped.filesEdited, [
          ...(EDIT_TOOLS.has(call.name) && event.success ? [path] : []),
          ...(event.filesEdited ?? []),
        ]),
        live: {
          ...live,
          toolCalls: existing ? calls.map((c) => (c.id === call.id ? call : c)) : [...calls, call],
          segments: existing
            ? live.segments
            : withSegment(live.segments ?? [], { type: "tools", toolCallIds: [call.id] }),
        },
      };
    }
    case "steering": {
      if (state.messages.some((m) => m.id === event.message.id)) return state;
      return {
        ...state,
        messages: [...state.messages, event.message],
        pending: removeFirst(state.pending, event.message.content),
      };
    }
    case "rewind":
      // The screen refetches the session, which carries the rewound messages.
      return state;
    case "prompt":
      if (state.prompts.some((p) => p.prompt.id === event.prompt.id)) return state;
      return { ...state, prompts: [...state.prompts, { prompt: event.prompt }] };
    case "prompt-resolved":
      return {
        ...state,
        prompts: state.prompts.map((p) =>
          p.prompt.id === event.promptId
            ? { ...p, outcome: event.outcome, ...(event.action ? { action: event.action } : {}) }
            : p,
        ),
      };
    case "plan":
      return { ...state, plan: event.plan };
    case "notice":
      if (state.messages.some((m) => m.id === event.message.id)) return state;
      return { ...state, messages: [...state.messages, event.message] };
    case "step":
      return { ...state, turnUsage: event.usage };
    case "turn-done": {
      const stopped = stopThinking(state, event.at);
      const message = event.message;
      const known = message !== null && stopped.messages.some((m) => m.id === message.id);
      const thoughts = stopped.live ? stopped.thoughtMs[stopped.live.id] : undefined;
      const thoughtMs = { ...stopped.thoughtMs };
      if (stopped.live) delete thoughtMs[stopped.live.id];
      if (message && thoughts) thoughtMs[message.id] = thoughts;
      return {
        ...stopped,
        messages: message && !known ? [...stopped.messages, message] : stopped.messages,
        live: null,
        turnId: null,
        turnUsage: null,
        prompts: stopped.prompts.filter((p) => p.outcome === undefined),
        usage: {
          input: stopped.usage.input + event.usage.input,
          output: stopped.usage.output + event.usage.output,
          cacheRead: stopped.usage.cacheRead + event.usage.cacheRead,
        },
        thoughtMs,
        notice:
          event.status === "failed"
            ? { kind: "error", text: event.error ?? "The turn failed." }
            : event.status === "interrupted"
              ? { kind: "interrupted", text: "Interrupted." }
              : null,
        session: stopped.session ? { ...stopped.session, state: "idle" } : null,
      };
    }
    case "compaction-start":
      return {
        ...state,
        compacting: true,
        notice: null,
        session: state.session ? { ...state.session, state: "working", compacting: true } : null,
      };
    case "compaction-done": {
      const message = event.message;
      const known = message !== null && state.messages.some((m) => m.id === message.id);
      return {
        ...state,
        compacting: false,
        messages: message && !known ? [...state.messages, message] : state.messages,
        context: event.context ?? state.context,
        notice:
          event.status === "failed"
            ? { kind: "error", text: `Compaction failed: ${event.error ?? "unknown error"}` }
            : event.status === "interrupted"
              ? { kind: "interrupted", text: "Compaction stopped." }
              : null,
        session: state.session ? { ...state.session, state: "idle", compacting: false } : null,
      };
    }
    case "session":
      return { ...state, session: event.session };
    case "watch":
    case "launched":
      // The chat section keeps watch mode's state, the coordinator's panel its launched work.
      return state;
  }
}

export function reduceTranscript(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case "snapshot":
      // A snapshot behind what the events already showed would drop them, unless the server
      // asked for the refetch (its sequences start over after a restart).
      if (
        state.session?.id === action.detail.id &&
        !state.needsReset &&
        action.detail.lastSeq < state.lastSeq
      )
        return {
          ...state,
          context: action.detail.context,
          filesEdited: action.detail.filesEdited,
        };
      return fromDetail(action.detail, state);
    case "local-send":
      return { ...state, pending: [...state.pending, action.text], notice: null };
    case "local-send-failed":
      return { ...state, pending: removeFirst(state.pending, action.text) };
    default:
      return applyChatEvent(state, action);
  }
}

/** The number of turns in the transcript: user messages that are not steering. */
export function turnCount(state: Transcript): number {
  return state.messages.filter((m) => m.role === "user" && !m.isSteering).length;
}

/**
 * The last assistant message of each turn but the latest, by id, with the turn's number: undoing
 * to that checkpoint keeps the whole turn. Turns are counted as the server counts them, from each
 * user message that was not sent while working.
 */
export function turnEnds(messages: readonly ChatMessage[]): Map<string, number> {
  const ends = new Map<string, number>();
  let turn = 0;
  let last: string | null = null;
  for (const m of messages) {
    if (m.role === "user" && !m.isSteering) {
      if (last !== null) ends.set(last, turn);
      turn += 1;
      last = null;
    } else if (m.role === "assistant" && turn > 0) last = m.id;
  }
  return ends;
}

/** True while a turn runs, waits for a prompt answer, or the session is being compacted. */
export function isBusy(state: Transcript): boolean {
  return (
    state.turnId !== null ||
    state.compacting ||
    (state.session !== null && state.session.state !== "idle")
  );
}
