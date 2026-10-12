import type { ChatExportFormat } from "../../shared/bridge.js";
import { parseChatEvent } from "../screens/chat/transcript.js";
import { ApiError, call } from "./api.js";
import { bridge } from "./bridge.js";

/**
 * Chat sessions over `/v1/sessions/*`, `GET /v1/models` and `GET /v1/mentions` (docs/desktop/api.md, group A).
 * Shapes mirror `src/core/chat/sessions.ts`; only the fields the chat screen reads are declared.
 */

export type ChatMode = "default" | "architect" | "plan" | "auto";
export const CHAT_MODES: readonly ChatMode[] = ["default", "architect", "plan", "auto"];
/** How a plan review is answered; `revise` sends feedback with it. */
export type PlanAction = "execute" | "clear-execute" | "revise" | "cancel";

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

/** The plan the agent proposed or is carrying out. */
export interface ChatPlan {
  title: string;
  depth: "light" | "full";
  steps: { id: string; label: string; status: PlanStepStatus }[];
  createdAt: number;
}
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
  /** Images attached to a user message. */
  images?: StoredImage[];
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** An image as the server stores it with a message. */
export interface StoredImage {
  label: string;
  base64: string;
  mediaType: ImageMediaType;
}

/** An image as the composer sends it: base64 without a `data:` prefix. */
export interface ImageUpload {
  mediaType: ImageMediaType;
  data: string;
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
  | {
      kind: "plan-review";
      title: string;
      depth: "light" | "full";
      steps: { id: string; label: string }[];
      planFile: string;
      /** The plan as Markdown. */
      content: string;
    }
  | {
      kind: "split";
      title: string;
      mode: "runs" | "initiative";
      flows: { id: string; title: string; paths: string[]; dependsOn: string[] }[];
      digest: string;
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
  /** The plan being reviewed or carried out; older servers leave it out. */
  plan?: ChatPlan | null;
  /** Turns an undo dropped that Redo puts back, oldest first; older servers leave it out. */
  redo?: RedoTurn[];
  /** Subscribe to events after this sequence to miss nothing. */
  lastSeq: number;
}

/** A turn an undo dropped: its number and the first line of its prompt. */
export interface RedoTurn {
  index: number;
  prompt: string;
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
  | { type: "rewind"; action: "undo" | "redo"; checkpoint: number; messageCount: number }
  | { type: "prompt"; prompt: ChatPrompt }
  | { type: "prompt-resolved"; promptId: string; outcome: PromptOutcome; action?: PlanAction }
  | { type: "plan"; plan: ChatPlan | null }
  | { type: "notice"; message: ChatMessage }
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

/** What a fork with `rollbackFiles`, an undo or a redo did to the workspace files. */
export interface RollbackReport {
  checkpoint: number;
  snapshot: string | null;
  backupTag: string | null;
  restored: string[];
  removed: string[];
  skipped: { path: string; reason: string }[];
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
    body: {
      title?: string;
      model?: string;
      mode?: ChatMode;
      text?: string;
      images?: ImageUpload[];
    } = {},
  ) => call<SessionDetail>(key, "POST", "/v1/sessions", body),
  get: (key: string, id: string) => call<SessionDetail>(key, "GET", sessionPath(id)),
  update: (key: string, id: string, body: { title?: string; model?: string; mode?: ChatMode }) =>
    call<SessionSummary>(key, "PATCH", sessionPath(id), body),
  /** Deletes a saved session; the server refuses one with a running turn. */
  remove: (key: string, id: string) => call<null>(key, "DELETE", sessionPath(id)),
  /** Saves `GET /v1/sessions/ID/export` through a save dialog; the path, or null when cancelled. */
  exportTo: (key: string, id: string, format: ChatExportFormat) =>
    bridge.exportChat(key, id, format),
  /** A new session with the messages up to `atMessageId`, optionally with the files rolled back. */
  fork: (
    key: string,
    id: string,
    body: { atMessageId?: string; rollbackFiles?: boolean; force?: boolean },
  ) =>
    call<SessionDetail & { rollback?: RollbackReport }>(key, "POST", sessionPath(id, "fork"), body),
  /** Drops the last turn (or every turn after `toCheckpoint`) and restores the files it edited. */
  undo: (key: string, id: string, body: { toCheckpoint?: number; force?: boolean } = {}) =>
    call<SessionDetail & { rollback: RollbackReport }>(key, "POST", sessionPath(id, "undo"), body),
  /** Puts back the oldest undone turn and the files it edited. */
  redo: (key: string, id: string, body: { force?: boolean } = {}) =>
    call<SessionDetail & { rollback: RollbackReport }>(key, "POST", sessionPath(id, "redo"), body),
  send: (key: string, id: string, text: string, images: ImageUpload[] = []) =>
    call<{ turnId: string; queued: boolean }>(key, "POST", sessionPath(id, "messages"), {
      text,
      ...(images.length > 0 ? { images } : {}),
    }),
  /** Starts a manual compaction; its progress arrives as `compaction-*` events. */
  compact: (key: string, id: string) =>
    call<{ compactionId: string }>(key, "POST", sessionPath(id, "compact"), {}),
  diff: (key: string, id: string) => call<SessionDiffStats>(key, "GET", sessionPath(id, "diff")),
  interrupt: (key: string, id: string) =>
    call<{ interrupted: boolean }>(key, "POST", sessionPath(id, "interrupt"), {}),
  /** Answers an approval; a split card is approved with the digest it shows. */
  approve: (key: string, id: string, promptId: string, approve: boolean, digest?: string) =>
    call<{ resolved: true }>(
      key,
      "POST",
      `${sessionPath(id, "prompts")}/${encodeURIComponent(promptId)}`,
      approve && digest ? { approve, digest } : { approve },
    ),
  /** Answers a question prompt; an empty answer skips a question that allows it. */
  answer: (key: string, id: string, promptId: string, answer: string) =>
    call<{ resolved: true }>(
      key,
      "POST",
      `${sessionPath(id, "prompts")}/${encodeURIComponent(promptId)}`,
      { answer },
    ),
  /** Answers a plan review: carry it out (optionally with a fresh context), revise or cancel it. */
  reviewPlan: (
    key: string,
    id: string,
    promptId: string,
    body: { action: PlanAction; feedback?: string },
  ) =>
    call<{ resolved: true }>(
      key,
      "POST",
      `${sessionPath(id, "prompts")}/${encodeURIComponent(promptId)}`,
      body,
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
