import type { ChatExportFormat } from "../../shared/bridge.js";
import { parseChatEvent } from "../screens/chat/transcript.js";
import { ApiError, call } from "./api.js";
import { bridge } from "./bridge.js";
import type { LaunchedView } from "./coordinator.js";

/**
 * Chat sessions over `/v1/sessions/*`, `GET /v1/models` and `GET /v1/mentions` (docs/desktop/api.md, group A).
 * Shapes mirror `src/core/chat/sessions.ts`; only the fields the chat screen reads are declared.
 */

export type ChatMode = "default" | "architect" | "plan" | "auto";
export const CHAT_MODES: readonly ChatMode[] = ["default", "architect", "plan", "auto"];
/** What the mode picker offers on a server with `permission-modes`, where `auto` became full access. */
export const AGENT_MODES: readonly ChatMode[] = ["default", "architect", "plan"];
/** How much a chat runs without asking (`permission-modes` capability). */
export type PermissionMode = "manual" | "auto" | "full";
export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "auto", "full"];
/** A chat's reasoning effort; `default` follows the global setting. */
export type ChatEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
/**
 * A chat's context window when its model offers several: tokens, `max`, or `default` (the largest
 * for the coordinator, the model's own size elsewhere).
 */
export type ChatContextSize = "default" | "max" | number;
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
  /** Reasoning effort of the next turn; servers without the `chat-effort` capability leave it out. */
  effort?: ChatEffort;
  /** Reasoning efforts the session's model takes, lowest first; older servers leave it out. */
  efforts?: Exclude<ChatEffort, "default">[];
  /** Permission mode; servers without the `permission-modes` capability leave it out. */
  permissions?: PermissionMode;
  /** The chat's context size; older servers leave it out. */
  contextSize?: ChatContextSize;
  /** Context windows in tokens the model offers, smallest first; empty or absent for one. */
  contextSizes?: number[];
  /** The window the next turn runs with when the model offers several, else null. */
  contextTokens?: number | null;
  /** True while a manual compaction runs; older servers leave it out. */
  compacting?: boolean;
  /** The session that launched this one, such as the project coordinator. */
  parentId?: string;
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
  /** False for a message the chat does not show, such as a coordinator's wake-up. */
  showInChat?: boolean;
  /** What the message's `@` mentions and `!` command attached. */
  inputContext?: InputContextItem[];
  /** Images attached to a user message. */
  images?: StoredImage[];
  /** On a coordinator's notice: the launched item it is about. */
  launch?: LaunchNote;
}

/** A session's own Git worktree (absolute path) and branch. */
export interface SessionWorktree {
  path: string;
  branch: string;
}

/** What a coordinator notice says about one item it launched (`src/types/index.ts`). */
export interface LaunchNote {
  kind: "session" | "run" | "initiative";
  id: string;
  feature?: string;
  title?: string;
  status: string;
  why: string;
  task?: { ref: string; url?: string; state: "open" | "closed" | "local" };
  /** A session's own worktree and branch, when it has one. */
  worktree?: SessionWorktree;
  /** For a session whose turn ended: its last answer, shortened. */
  result?: string;
  /** For a session waiting for the person: what it asks, such as its question and options. */
  asks?: string;
  /** For `auto-answered`: what the coordinator approved by one of the person's rules. */
  answered?: string;
  /**
   * `status`: the item's status changed; `task-closed`: its task's pull request merged;
   * `auto-answered`: the coordinator answered one of its approvals by a rule (`why` names it).
   */
  event: "status" | "task-closed" | "auto-answered";
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
  | { kind: "destructive"; description: string; confirm?: true }
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
      mode: "runs" | "initiative" | "chats";
      flows: {
        id: string;
        title: string;
        paths: string[];
        dependsOn: string[];
        /** The issue (`owner/name#N`), `new issue` or `local task`; missing from older servers. */
        task?: string;
      }[];
      digest: string;
    }
  | {
      /** The coordinator asks to run a workflow; approving it with the digest starts the run. */
      kind: "workflow";
      workflow: string;
      description: string;
      stages: string[];
      writes: boolean;
      prompt: string;
      why: string;
      reason: string;
      issue?: string;
      /** Gates approving the card saves before the run starts, one `id: command` line each. */
      gates?: string[];
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
  /** While a turn runs: the sequence before it started, to replay what it streamed so far. */
  turnSeq?: number;
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
  | { type: "session"; session: SessionSummary }
  | { type: "watch"; watch: WatchStatus }
  /** The coordinator's launched work changed; `launched` is `GET /v1/coordinator/launched`. */
  | { type: "launched"; launched: LaunchedView[] };

/** Watch mode as one session sees it: `GET /v1/sessions/ID/watch` and the `watch` event. */
export interface WatchStatus {
  /** This session receives the turns from saved `baked!` and `baked?` comments. */
  watching: boolean;
  /** The session that watches, when another one does. */
  watchingSession: string | null;
  method: "native" | "poll" | null;
  turns: number;
  /** Where the last watch turn came from, e.g. "src/x.ts:42 (baked!)". */
  last: string | null;
  error: string | null;
}

/** A numbered session event, or `reset` when the client must refetch the session. */
export type ChatEvent = (ChatEventBody & { seq: number; at: number }) | { type: "reset" };

export interface ModelProvider {
  id: string;
  name: string;
  configured: boolean;
  /** `efforts`: the levels a chat can pick for the model, lowest first; absent when it takes none. */
  /** `contextSizes`: the windows a chat can pick, smallest first; absent when the model has one. */
  models: {
    id: string;
    name: string;
    contextWindow?: number;
    efforts?: ChatEffort[];
    contextSizes?: number[];
  }[];
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
      effort?: ChatEffort;
      permissions?: PermissionMode;
      contextSize?: ChatContextSize;
      text?: string;
      images?: ImageUpload[];
    } = {},
  ) => call<SessionDetail>(key, "POST", "/v1/sessions", body),
  get: (key: string, id: string) => call<SessionDetail>(key, "GET", sessionPath(id)),
  update: (
    key: string,
    id: string,
    body: {
      title?: string;
      model?: string;
      mode?: ChatMode;
      effort?: ChatEffort;
      permissions?: PermissionMode;
      contextSize?: ChatContextSize;
    },
  ) => call<SessionSummary>(key, "PATCH", sessionPath(id), body),
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
  watch: (key: string, id: string) => call<WatchStatus>(key, "GET", sessionPath(id, "watch")),
  /** Turns watch mode on for this chat (moving it from another chat) or off. */
  setWatch: (key: string, id: string, on: boolean) =>
    call<WatchStatus>(key, "POST", sessionPath(id, "watch"), { on }),
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
