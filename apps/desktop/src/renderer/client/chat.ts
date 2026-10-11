import { parseChatEvent } from "../screens/chat/transcript.js";
import { ApiError, call } from "./api.js";
import { bridge } from "./bridge.js";

/**
 * Chat sessions over `/v1/sessions/*`, `GET /v1/models` and `GET /v1/mentions` (docs/desktop/api.md, group A).
 * Shapes mirror `src/core/chat/sessions.ts`; only the fields the chat screen reads are declared.
 */

export type ChatMode = "default" | "architect" | "auto";
export const CHAT_MODES: readonly ChatMode[] = ["default", "architect", "auto"];
export type SessionState = "idle" | "working" | "waiting";

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
  state: SessionState;
  /** `provider/model` of the next turn; null when nothing is configured. */
  model: string | null;
  mode: ChatMode;
  /** True while a manual compaction runs; older servers leave it out. */
  compacting?: boolean;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  filesEdited?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tools"; toolCallIds: string[] }
  | { type: "reasoning"; content: string; id: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  segments?: MessageSegment[];
  durationMs?: number;
  isSteering?: boolean;
  /** What the message's `@` mentions and `!` command attached. */
  inputContext?: InputContextItem[];
}

export interface InputContextItem {
  kind: "file" | "directory" | "symbol" | "command";
  ref: string;
  ok: boolean;
  summary: string;
  output?: string;
}

/** One `@` completion; `insert` is the text that follows the `@`. */
export interface MentionSuggestion {
  kind: "file" | "directory" | "symbol";
  insert: string;
  label: string;
  detail: string;
  indices: number[];
}

export type ChatPrompt = { id: string; createdAt: number } & (
  | { kind: "outside-cwd"; tool: string; path: string }
  | { kind: "destructive"; description: string }
  | { kind: "web-search"; query: string }
  | { kind: "fetch-page"; url: string }
  | {
      kind: "question";
      question: string;
      allowSkip: boolean;
      options: { label: string; value: string; description?: string }[];
    }
);

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ContextFill {
  usedTokens: number;
  windowTokens: number;
  percent: number;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  /** Pending prompts only. */
  prompts: ChatPrompt[];
  queued: string[];
  usage: Usage;
  context: ContextFill | null;
  filesEdited: string[];
  /** Subscribe to events after this sequence to miss nothing. */
  lastSeq: number;
}

export type CompactionStatus = "compacted" | "skipped" | "failed" | "interrupted";

export type FileDiffStatus = "modified" | "added" | "deleted" | "unchanged" | "outside" | "unknown";

/** `GET /v1/sessions/ID/diff`: the session's edited files measured against the last commit. */
export interface SessionDiffStats {
  /** Null outside a git repository, where only the file names are known. */
  base: "HEAD" | null;
  files: {
    path: string;
    status: FileDiffStatus;
    added: number;
    removed: number;
    binary?: boolean;
  }[];
  totals: { files: number; added: number; removed: number };
}

export type PromptOutcome = "approved" | "denied" | "answered" | "skipped";
export type TurnStatus = "completed" | "interrupted" | "failed";

export type ChatEventBody =
  | { type: "turn-start"; turnId: string; message: ChatMessage }
  | { type: "text"; turnId: string; delta: string }
  | { type: "reasoning"; turnId: string; delta: string }
  | { type: "tool-call"; turnId: string; toolCallId: string; tool: string; input: unknown }
  | {
      type: "tool-result";
      turnId: string;
      toolCallId: string;
      tool: string;
      success: boolean;
      output: string;
      error?: string;
      filesEdited?: string[];
    }
  | { type: "steering"; turnId: string; message: ChatMessage }
  | { type: "prompt"; prompt: ChatPrompt }
  | { type: "prompt-resolved"; promptId: string; outcome: PromptOutcome }
  | { type: "step"; turnId: string; step: number; usage: Usage }
  | {
      type: "turn-done";
      turnId: string;
      status: TurnStatus;
      error?: string;
      message: ChatMessage | null;
      usage: Usage;
      durationMs: number;
    }
  | { type: "compaction-start"; compactionId: string }
  | {
      type: "compaction-done";
      compactionId: string;
      status: CompactionStatus;
      message: ChatMessage | null;
      compacted: number;
      error?: string;
      context: ContextFill | null;
    }
  | { type: "rewind"; action: "rewind" | "redo"; checkpoint: number; redo: number }
  | { type: "session"; session: SessionSummary };

/** A numbered session event, or `reset` when the client must refetch the session. */
export type ChatEvent = (ChatEventBody & { seq: number; at: number }) | { type: "reset" };

export interface ModelProvider {
  id: string;
  name: string;
  configured: boolean;
  models: { id: string; name: string; contextWindow?: number }[];
  error?: string;
}

/** What `POST /v1/sessions/ID/fork` with `rollbackFiles` did to the workspace files. */
export interface RollbackReport {
  checkpoint: number;
  snapshot: string | null;
  backupTag: string | null;
  restored: string[];
  removed: string[];
  skipped: { path: string; reason: string }[];
}

/** A turn a rewind dropped, which `POST /v1/sessions/ID/redo` brings back (oldest first). */
export interface RedoTurn {
  index: number;
  anchorMessageId: string;
  prompt: string;
  filesRolledBack: boolean;
}

/** `GET /v1/sessions/ID/checkpoints`. */
export interface SessionCheckpoints {
  checkpoints: {
    index: number;
    anchorMessageId: string;
    endMessageId: string;
    prompt: string;
    startedAt: number;
    filesEdited: string[];
    snapshot: boolean;
  }[];
  redo: RedoTurn[];
}

/** What `POST /v1/sessions/ID/rewind` and `/redo` did. */
export interface RewindResult {
  checkpoint: number;
  rollback: RollbackReport | null;
  redo: RedoTurn[];
  session: SessionDetail;
}

export interface WorkingSetSummary {
  workingSet: { entries: string[]; files: { path: string; bytes: number }[] };
}

const sessionPath = (id: string, action?: string): string =>
  `/v1/sessions/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** True when the backend predates the chat API. */
export function isMissingChatApi(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}

export const chat = {
  list: (key: string, limit = 30) =>
    call<{ sessions: SessionSummary[] }>(key, "GET", `/v1/sessions?limit=${limit}`),
  create: (
    key: string,
    body: { title?: string; model?: string; mode?: ChatMode; text?: string } = {},
  ) => call<SessionDetail>(key, "POST", "/v1/sessions", body),
  get: (key: string, id: string) => call<SessionDetail>(key, "GET", sessionPath(id)),
  update: (key: string, id: string, body: { title?: string; model?: string; mode?: ChatMode }) =>
    call<SessionSummary>(key, "PATCH", sessionPath(id), body),
  /** A new session with the messages up to `atMessageId`, optionally with the files rolled back. */
  fork: (
    key: string,
    id: string,
    body: { atMessageId?: string; rollbackFiles?: boolean; force?: boolean },
  ) =>
    call<SessionDetail & { rollback?: RollbackReport }>(key, "POST", sessionPath(id, "fork"), body),
  send: (key: string, id: string, text: string) =>
    call<{ turnId: string; queued: boolean }>(key, "POST", sessionPath(id, "messages"), {
      text,
    }),
  /** Starts a manual compaction; its progress arrives as `compaction-*` events. */
  compact: (key: string, id: string) =>
    call<{ compactionId: string }>(key, "POST", sessionPath(id, "compact"), {}),
  diff: (key: string, id: string) => call<SessionDiffStats>(key, "GET", sessionPath(id, "diff")),
  checkpoints: (key: string, id: string) =>
    call<SessionCheckpoints>(key, "GET", sessionPath(id, "checkpoints")),
  /** Keeps the turns up to `checkpoint` in this session; later ones can be redone. */
  rewind: (
    key: string,
    id: string,
    body: { checkpoint: number; rollbackFiles?: boolean; force?: boolean },
  ) => call<RewindResult>(key, "POST", sessionPath(id, "rewind"), body),
  redo: (key: string, id: string, body: { force?: boolean } = {}) =>
    call<RewindResult>(key, "POST", sessionPath(id, "redo"), body),
  interrupt: (key: string, id: string) =>
    call<{ interrupted: boolean }>(key, "POST", sessionPath(id, "interrupt"), {}),
  approve: (key: string, id: string, promptId: string, approve: boolean) =>
    call<{ resolved: true }>(
      key,
      "POST",
      `${sessionPath(id, "prompts")}/${encodeURIComponent(promptId)}`,
      { approve },
    ),
  /** Answers a question prompt; an empty answer skips a question that allows it. */
  answer: (key: string, id: string, promptId: string, answer: string) =>
    call<{ resolved: true }>(
      key,
      "POST",
      `${sessionPath(id, "prompts")}/${encodeURIComponent(promptId)}`,
      { answer },
    ),
  /** The capability groups of `GET /v1/health`; null when the answer could not be read. */
  capabilities: (key: string): Promise<string[] | null> =>
    call<{ capabilities?: string[] }>(key, "GET", "/v1/health").then(
      (health) => health.capabilities ?? [],
      () => null,
    ),
  models: (key: string) => call<{ providers: ModelProvider[] }>(key, "GET", "/v1/models"),
  mentions: (key: string, query: string) =>
    call<{ mentions: MentionSuggestion[] }>(
      key,
      "GET",
      `/v1/mentions?q=${encodeURIComponent(query)}&limit=20`,
    ),
  /** The project summary of `GET /v1/projects/current`, read for the working set chip. */
  project: (key: string) => call<WorkingSetSummary>(key, "GET", "/v1/projects/current"),
  /** Follows a session's events after `afterSeq`; returns the unsubscribe function. */
  subscribe: (
    key: string,
    id: string,
    afterSeq: number,
    listener: (event: ChatEvent) => void,
  ): (() => void) =>
    bridge.subscribe(
      key,
      `${sessionPath(id, "events")}?after=${afterSeq}`,
      (frame) => {
        const event = parseChatEvent(frame);
        if (event) listener(event);
      },
      String(afterSeq),
    ),
};
