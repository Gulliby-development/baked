/**
 * Chat sessions driven outside the terminal UI, for the local API (`baked serve`).
 *
 * A session lives in `.baked/sessions/ID/` like the terminal UI's, so both front ends list and
 * continue the same conversations; a session with several tabs is continued on its active tab and
 * its other tabs are saved back unchanged. Each turn streams its parts as numbered events into an
 * in-memory buffer that clients replay and follow; the saved messages stay authoritative.
 *
 * Approvals the agent asks for (writes outside the workspace, destructive commands, web searches,
 * page fetches) and questions it asks become prompts that wait for an answer over the API, as the
 * terminal UI waits for a key. Interrupting a turn denies its pending prompts. A message sent while
 * a turn runs is steered into the turn at its next step, or starts the next turn if the turn ends
 * first.
 *
 * In plan mode the agent researches and proposes a plan, which waits as a `plan-review` prompt as the
 * terminal UI's plan review does: executing it switches the session to default mode and starts a
 * turn that carries out the plan, revising sends the feedback back to the agent, and cancelling
 * leaves plan mode.
 *
 * Undo drops the last turns and restores the files they edited, redo puts the oldest undone turn
 * back (see `src/core/checkpoints/undo.ts`); the undone turns are saved with the session until a
 * new turn starts.
 *
 * Compacting a session ("Compact now") replaces its older model messages with a summary, as the
 * terminal UI's `/compact` does; the transcript keeps every message and gains a note. Messages sent
 * while it runs wait and start the next turn when it ends.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type {
  AppConfig,
  BakeMode,
  ChatEffort,
  ChatMessage,
  ImageAttachment,
  InputContextItem,
  InteractiveCallbacks,
  LaunchNote,
  MessageSegment,
  Plan,
  PlanReviewAction,
  ToolCall,
} from "../../types/index.js";
import {
  copyCheckpointTags,
  ensureBaseSnapshot,
  forkPoint,
  RollbackError,
  type RollbackReport,
  rollbackToCheckpoint,
  snapshotTurnEnd,
} from "../checkpoints/fork.js";
import { type CheckpointList, listCheckpoints, promptLine } from "../checkpoints/list.js";
import { type CheckpointTag, extractFilesFromToolCalls } from "../checkpoints/turns.js";
import {
  dropRedoTags,
  type RedoTurn,
  redoTurn,
  TurnUndoError,
  undoTurns,
} from "../checkpoints/undo.js";
import { expandCustomCommandInput } from "../commands/custom.js";
import { type CompactResult, compactionBlocker, messageChars } from "../compaction/manual.js";
import { DEFAULT_COMPACTION_CONFIG } from "../compaction/types.js";
import { logBackgroundError } from "../diagnostics/errors.js";
import { recordModelCall } from "../diagnostics/model-events.js";
import { runHooks } from "../hooks/index.js";
import {
  endSessionHooks,
  notificationHooks,
  type SessionEndReason,
  sessionHooksStarted,
  startSessionHooks,
  stopHooks,
  takeHookContext,
  userPromptHooks,
  withHookContext,
} from "../hooks/lifecycle.js";
import { SessionManager } from "../sessions/manager.js";
import { rebuildCoreMessages as rebuildCore } from "../sessions/rebuild.js";
import type { SessionMeta, TabMeta } from "../sessions/types.js";
import { watchOptions } from "../watch/config.js";
import { WatchController, type WatchTurn, watchTurnDisplay } from "../watch/controller.js";
import { projectDefinitions, proposeForWorkspace } from "../workflows/v2/propose.js";
import { COORDINATOR_MODE } from "./coordinator.js";
import {
  coordinatorLimits,
  type LaunchedView,
  launchedView,
  launchTools,
  type ProjectLauncher,
  syncLaunched,
  type WorkflowCatalog,
  wakeLine,
  wakePrompt,
} from "./coordinator-launch.js";
import { editedFiles, type SessionDiffStats, sessionDiffStats } from "./diff-stats.js";
import { userContent } from "./images.js";
import type { ExpandedChatInput } from "./input-expansion.js";
import { hasInputReferences } from "./input-parse.js";
import type { MentionSuggestion } from "./mention-suggest.js";
import { PEER_TOOL, peerInstructions, peerTool } from "./peer-messages.js";
import {
  type ProjectStateSource,
  type SessionSource,
  STATE_TOOL,
  stateTool,
} from "./project-state.js";
import { toolResultOf } from "./tool-result.js";

export const CHAT_MODES = ["default", "architect", "plan", "auto"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
/** How a person answers a `plan-review` prompt. */
export const PLAN_ACTIONS = ["execute", "clear-execute", "revise", "cancel"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];
export type PromptAnswer =
  | { approve: boolean; digest?: string }
  | { answer: string }
  | { action: PlanAction; feedback?: string };
export type SessionState = "idle" | "working" | "waiting";

/** Tool output carried by a `tool-result` event; the saved message keeps all of it. */
const EVENT_OUTPUT_CHARS = 4000;
const DEFAULT_BUFFER = 5000;
const RESPONSE_TIMEOUT_MS = 10_000;
const API_TAB = "desktop";

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
      depth: Plan["depth"];
      steps: { id: string; label: string }[];
      /** The plan file, relative to the workspace. */
      planFile: string;
      /** The plan as Markdown. */
      content: string;
    }
  | {
      /** A coordinator's proposed split into flows; approving it launches them all. */
      kind: "split";
      title: string;
      /** Independent runs in their own worktrees, or one initiative that orders dependent flows. */
      mode: "runs" | "initiative";
      /** `task`: the flow's issue (`owner/name#N`), `new issue` or `local task`. */
      flows: { id: string; title: string; paths: string[]; dependsOn: string[]; task: string }[];
      /** Binds the approval to exactly this split. */
      digest: string;
    }
  | {
      /** A coordinator asks to run a workflow on a request; approving it starts the run. */
      kind: "workflow";
      /** The workflow definition id, or `default` for the project default. */
      workflow: string;
      description: string;
      /** The workflow's stages in order. */
      stages: string[];
      /** Whether the workflow changes files. */
      writes: boolean;
      /** The request the run starts with. */
      prompt: string;
      /** The coordinator's one line on why. */
      why: string;
      /** Why this workflow: named by the coordinator, or BAKED's proposal for the request. */
      reason: string;
      /** The issue the run starts from. */
      issue?: string;
      /** Binds the approval to exactly this workflow and request. */
      digest: string;
    }
);
type PromptBody = ChatPrompt extends infer P
  ? P extends ChatPrompt
    ? Omit<P, "id" | "createdAt">
    : never
  : never;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
  projectId?: string;
  state: SessionState;
  model: string | null;
  mode: ChatMode;
  /** Reasoning effort for this chat's turns; `default` follows the global setting. */
  effort: ChatEffort;
  /** True while a manual compaction runs; the state is then `working`. */
  compacting: boolean;
  /** `coordinator` for the project's coordinator chat (see `src/core/chat/coordinator.ts`). */
  kind?: "coordinator";
  /** The session that launched this one: the coordinator for the sessions it starts. */
  parentId?: string;
}

/** Watch mode of the project as one session sees it (`/v1/sessions/:id/watch`). */
export interface WatchStatus {
  /** This session receives the watch turns. */
  watching: boolean;
  /** The session that watches, when another one does. */
  watchingSession: string | null;
  method: "native" | "poll" | null;
  turns: number;
  /** Where the last watch turn came from, e.g. "src/x.ts:42 (baked!)". */
  last: string | null;
  error: string | null;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  prompts: ChatPrompt[];
  queued: string[];
  usage: Usage;
  context: { usedTokens: number; windowTokens: number; percent: number } | null;
  filesEdited: string[];
  /** The plan the agent proposed or is carrying out, with its step statuses. */
  plan: Plan | null;
  /** Turns an undo dropped that a redo can put back, oldest first. */
  redo: { index: number; prompt: string }[];
  lastSeq: number;
}

/** What an undo or redo did: the turn count left and the file rollback report. */
export interface RewindResult {
  action: "undo" | "redo";
  checkpoint: number;
  rollback: RollbackReport;
}

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
  | {
      type: "prompt-resolved";
      promptId: string;
      outcome: PromptOutcome;
      /** How a `plan-review` prompt was answered. */
      action?: PlanAction;
    }
  | { type: "plan"; plan: Plan | null }
  | { type: "notice"; message: ChatMessage }
  | { type: "step"; turnId: string; step: number; usage: Usage }
  | {
      type: "turn-done";
      turnId: string;
      status: "completed" | "interrupted" | "failed";
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
      /** The note added to the transcript; null when the compaction failed or was interrupted. */
      message: ChatMessage | null;
      /** Model messages the summary replaced. */
      compacted: number;
      error?: string;
      context: SessionDetail["context"];
    }
  | { type: "session"; session: SessionSummary }
  | { type: "watch"; watch: WatchStatus }
  /** A coordinator's launched work changed: a status, a run's stage or its tasks. */
  | { type: "launched"; launched: LaunchedView[] };
export type CompactionStatus = "compacted" | "skipped" | "failed" | "interrupted";
export type PromptOutcome = "approved" | "denied" | "answered" | "skipped";
export type ChatEvent = ChatEventBody & { seq: number; at: number };

/** The part of an agent stream result a turn reads; `createBakeAgent` agents satisfy it. */
export interface TurnAgent {
  stream(args: {
    messages: ModelMessage[];
    options: { userMessage: string | null };
    abortSignal: AbortSignal;
  }): PromiseLike<{
    stream: AsyncIterable<unknown>;
    responseMessages: PromiseLike<ModelMessage[]>;
  }>;
}

export interface TurnAgentRequest {
  sessionId: string;
  modelId: string;
  mode: ChatMode;
  /** The chat's reasoning effort; `default` keeps the configuration's. */
  effort: ChatEffort;
  /** The turn carries out an accepted plan: the agent keeps to the plan's tools. */
  planExecution: boolean;
  /** The session is the project's coordinator: its prompt and brief tool apply. */
  coordinator?: boolean;
  /** Tools the service adds for this session's kind (the coordinator's project state tool). */
  tools?: Record<string, unknown>;
  /** Instructions the service adds for this session's kind, such as a coordinator thread's. */
  instructions?: string;
  callbacks: InteractiveCallbacks;
  onApproveOutsideCwd: (toolName: string, path: string) => Promise<boolean>;
  onApproveDestructive: (description: string) => Promise<boolean>;
  drainSteering: () => { text: string; images?: ImageAttachment[] } | null;
}

export interface InputExpansionRequest {
  sessionId: string;
  mode: ChatMode;
  text: string;
  onApproveDestructive: (description: string) => Promise<boolean>;
  abortSignal: AbortSignal;
}

export interface CompactionRequest {
  sessionId: string;
  /** The session's model; the host may compact with the task router's `compact` model instead. */
  modelId: string;
  messages: ModelMessage[];
  abortSignal: AbortSignal;
}

export interface CompactionResponse {
  result: CompactResult;
  /** Characters of the system prompt and context, for estimating the context fill afterwards. */
  systemChars?: number;
  contextWindow?: number;
}

/** Builds the agent of each turn; the API server uses a host backed by `createChatAgent`. */
export interface ChatAgentHost {
  agent(request: TurnAgentRequest): Promise<{ agent: TurnAgent; contextWindow: number }>;
  /** Expands the `@` mentions and `!` command of a message; without it, text goes as typed. */
  expandInput?(request: InputExpansionRequest): Promise<ExpandedChatInput>;
  /** `@` completions for a chat input, from the workspace files and the repository graph. */
  suggestMentions?(query: string, limit?: number): Promise<MentionSuggestion[]>;
  /** Summarizes a session's older messages; without it, sessions cannot be compacted. */
  compact?(request: CompactionRequest): Promise<CompactionResponse>;
  /** Frees what the host keeps for a session that is no longer loaded. */
  release(sessionId: string): void;
  dispose(): Promise<void>;
}

export class ChatError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "SESSION_BUSY"
      | "STALE_PROMPT"
      | "INVALID_REQUEST"
      | "ROLLBACK_UNAVAILABLE"
      | "NOTHING_TO_COMPACT"
      | "NOTHING_TO_UNDO"
      | "NOTHING_TO_REDO"
      | "NOT_SUPPORTED",
    message: string,
  ) {
    super(message);
  }
}

/** A message waiting for the running turn or compaction. */
interface QueuedInput {
  text: string;
  images?: ImageAttachment[];
  /** Shown as the user message instead of `text`; the model still gets `text`. */
  display?: string;
  /** Sent as is, without `@` or `!` expansion, and as a turn of its own (watch mode). */
  verbatim?: boolean;
  /** Not shown as a user message: a coordinator's wake-up on launched work. */
  hidden?: boolean;
}

/** Queued messages sent as one: texts joined, images relabelled `image-1`… in order. */
function mergeQueued(items: QueuedInput[]): QueuedInput {
  if (items.length === 1 && items[0]) return items[0];
  const text = items
    .map((q) => q.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  const images = items
    .flatMap((q) => q.images ?? [])
    .map((img, i) => ({ ...img, label: `image-${i + 1}` }));
  return images.length > 0 ? { text, images } : { text };
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0 };
}

function toChatMode(mode: BakeMode | undefined): ChatMode {
  return mode && (CHAT_MODES as readonly string[]).includes(mode) ? (mode as ChatMode) : "default";
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    for (const key of ["errorCode", "error_code", "message"])
      if (typeof e[key] === "string") return e[key] as string;
    return JSON.stringify(error);
  }
  return String(error);
}

/** Ends a turn before the model runs, without counting as a failure. */
class SkipTurn extends Error {}

type PlanChoice = { action: PlanAction; feedback?: string };
type PromptValue = boolean | string | PlanChoice;

interface Pending {
  prompt: ChatPrompt;
  resolve: (value: PromptValue) => void;
}

/** What happens once a turn whose plan was reviewed ends. */
interface PlanFollowUp {
  action: "execute" | "clear-execute" | "cancel";
  plan: Plan;
  content: string;
}

/** The value of a prompt nobody answered: interrupted or denied. */
/** What a Notification hook is told about a prompt that waits for the user. */
function promptNotice(prompt: ChatPrompt): {
  type: "permission_prompt" | "question";
  message: string;
} {
  switch (prompt.kind) {
    case "outside-cwd":
      return {
        type: "permission_prompt",
        message: `BAKED needs your permission to use ${prompt.tool} on ${prompt.path}`,
      };
    case "destructive":
      return {
        type: "permission_prompt",
        message: `BAKED needs your permission: ${prompt.description}`,
      };
    case "web-search":
      return {
        type: "permission_prompt",
        message: `BAKED needs your permission to search the web for ${prompt.query}`,
      };
    case "fetch-page":
      return {
        type: "permission_prompt",
        message: `BAKED needs your permission to fetch ${prompt.url}`,
      };
    case "question":
      return { type: "question", message: prompt.question };
    case "plan-review":
      return {
        type: "question",
        message: `BAKED waits for you to review the plan: ${prompt.title}`,
      };
    case "split":
      return {
        type: "question",
        message: `BAKED waits for you to review the split: ${prompt.title}`,
      };
    case "workflow":
      return {
        type: "question",
        message: `BAKED asks to run the ${prompt.workflow} workflow: ${prompt.why}`,
      };
  }
}

function unanswered(kind: ChatPrompt["kind"]): PromptValue {
  return kind === "question" || kind === "plan-review" ? "__skipped__" : false;
}

/** The first message of a turn that carries out an accepted plan, as the terminal UI sends it. */
export function planExecutionPrompt(plan: Plan, content: string): string {
  const apply =
    plan.depth === "light"
      ? "2. Read the target files, then apply the changes described in the step details."
      : "2. Apply edits: each step has old→new diffs — use edit_file with the exact old/new text.";
  const note =
    plan.depth === "light"
      ? "This is a light plan — read files as needed before editing."
      : "All file content is included in the code_snippets below. Edits are pre-validated against this content.";
  return [
    "Execute this plan. The checklist is already live in the UI.",
    "Workflow per step:",
    '1. update_plan_step(stepId, "active")',
    apply,
    "3. Run shell commands from the step if present.",
    '4. update_plan_step(stepId, "done")',
    "",
    `${note}\n\n${content}`,
  ].join("\n");
}

interface TurnState {
  id: string;
  abort: AbortController;
}

/** Characters per token when estimating the context fill after a compaction, as the TUI does. */
const CHARS_PER_TOKEN = 3;

/** One loaded session: its messages, live turn, prompts and event buffer. */
export class ChatSession {
  private meta: SessionMeta;
  private tabMessages: Map<string, ChatMessage[]>;
  private tabCore: Map<string, ModelMessage[]>;
  private readonly tabId: string;
  private model: string | null;
  private mode: ChatMode;
  private effort: ChatEffort;
  private usage: Usage;
  private context: SessionDetail["context"] = null;
  private turn: TurnState | null = null;
  /** True while an undo or redo rewrites the conversation and the files. */
  private rewinding = false;
  private compaction: TurnState | null = null;
  private turnDone: Promise<void> = Promise.resolve();
  private readonly prompts = new Map<string, Pending>();
  /** Messages sent while a turn or compaction runs. */
  private queue: QueuedInput[] = [];
  private plan: Plan | null = null;
  private planFollowUp: PlanFollowUp | null = null;
  /** The next turn carries out this accepted plan. */
  private executingPlan: Plan | null = null;
  private events: ChatEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: ChatEvent) => void>();

  constructor(
    private readonly owner: ChatService,
    meta: SessionMeta,
    tabMessages: Map<string, ChatMessage[]>,
    tabCore: Map<string, ModelMessage[]>,
  ) {
    this.meta = meta;
    this.tabMessages = tabMessages;
    this.tabCore = tabCore;
    const tab = meta.tabs.find((t) => t.id === meta.activeTabId) ?? meta.tabs[0];
    if (!tab) throw new ChatError("NOT_FOUND", `Session ${meta.id} has no conversation`);
    this.tabId = tab.id;
    this.model =
      tab.activeModel && tab.activeModel !== "none" ? tab.activeModel : owner.defaultModel;
    this.mode = toChatMode(tab.bakeMode ?? meta.bakeMode);
    this.effort = tab.effort ?? "default";
    this.usage = {
      input: tab.tokenUsage.prompt,
      output: tab.tokenUsage.completion,
      cacheRead: tab.tokenUsage.cacheRead ?? 0,
    };
  }

  get id(): string {
    return this.meta.id;
  }

  private get tab(): TabMeta {
    const tab = this.meta.tabs.find((t) => t.id === this.tabId);
    if (!tab) throw new ChatError("NOT_FOUND", `Session ${this.meta.id} has no conversation`);
    return tab;
  }

  get messages(): ChatMessage[] {
    return this.tabMessages.get(this.tabId) ?? [];
  }

  /** The workspace snapshots of this conversation's checkpoints. */
  get checkpointTags(): CheckpointTag[] {
    return this.tab.checkpointTags ?? [];
  }

  /** The key of this conversation's snapshot tags; API sessions all share one tab id. */
  get tagOwner(): string {
    return this.tabId === API_TAB ? this.meta.id : this.tabId;
  }

  addCheckpointTag(tag: CheckpointTag): void {
    const tags = [...this.checkpointTags.filter((t) => t.index !== tag.index), tag];
    this.setTab({ checkpointTags: tags.sort((a, b) => a.index - b.index) });
  }

  /** The turns an undo dropped, oldest first. */
  get redoTurns(): RedoTurn[] {
    return this.tab.redoTurns ?? [];
  }

  private setTab(changes: Partial<TabMeta>): void {
    this.meta = {
      ...this.meta,
      tabs: this.meta.tabs.map((t) => (t.id === this.tabId ? { ...t, ...changes } : t)),
    };
  }

  private set messages(value: ChatMessage[]) {
    this.tabMessages.set(this.tabId, value);
  }

  private get core(): ModelMessage[] {
    return this.tabCore.get(this.tabId) ?? [];
  }

  private set core(value: ModelMessage[]) {
    this.tabCore.set(this.tabId, value);
  }

  get busy(): boolean {
    return this.turn !== null || this.compaction !== null || this.rewinding;
  }

  get state(): SessionState {
    if (this.prompts.size > 0) return "waiting";
    return this.busy ? "working" : "idle";
  }

  get pendingPrompts(): ChatPrompt[] {
    return [...this.prompts.values()].map((p) => p.prompt);
  }

  get title(): string {
    return this.meta.customTitle ?? this.meta.title;
  }

  summary(): SessionSummary {
    return {
      id: this.meta.id,
      title: this.title,
      messageCount: this.messages.length,
      startedAt: this.meta.startedAt,
      updatedAt: this.meta.updatedAt,
      ...(this.meta.projectId ? { projectId: this.meta.projectId } : {}),
      state: this.state,
      model: this.model,
      mode: this.mode,
      effort: this.effort,
      compacting: this.compaction !== null,
      ...(this.isCoordinator ? { kind: "coordinator" as const } : {}),
      ...(this.meta.parentId ? { parentId: this.meta.parentId } : {}),
    };
  }

  get isCoordinator(): boolean {
    return this.meta.kind === "coordinator";
  }

  detail(): SessionDetail {
    return {
      ...this.summary(),
      messages: this.messages,
      prompts: this.pendingPrompts,
      queued: this.queue.filter((q) => !q.hidden).map((q) => q.display ?? q.text),
      usage: { ...this.usage },
      context: this.context,
      filesEdited: editedFiles(this.messages),
      plan: this.plan,
      redo: this.redoTurns.map((t) => ({
        index: t.index,
        prompt: promptLine(t.messages[0]?.content ?? ""),
      })),
      lastSeq: this.seq,
    };
  }

  /**
   * Replays the buffered events after `after` and follows new ones. Returns null when `after` is
   * no longer buffered or is ahead of this server's sequence, so the client must refetch.
   */
  subscribe(after: number, listener: (event: ChatEvent) => void): (() => void) | null {
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (after > this.seq || after < oldest - 1) return null;
    for (const event of this.events) if (event.seq > after) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The tool the running turn is in, for a coordinator's view of what this session does. */
  private currentTool: string | null = null;

  /** What the running turn does now: its current tool, or null between tools and turns. */
  get activity(): string | null {
    return this.turn ? this.currentTool : null;
  }

  private emit(body: ChatEventBody): void {
    if (body.type === "tool-call") this.currentTool = body.tool;
    else if (body.type === "tool-result" || body.type === "turn-done") this.currentTool = null;
    const event = { ...body, seq: ++this.seq, at: Date.now() } as ChatEvent;
    this.events.push(event);
    if (this.events.length > this.owner.bufferSize)
      this.events.splice(0, this.events.length - this.owner.bufferSize);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not stop the turn; its stream closes on its own.
      }
    }
  }

  private emitSession(): void {
    this.emit({ type: "session", session: this.summary() });
  }

  update(changes: {
    title?: string;
    model?: string;
    mode?: ChatMode;
    effort?: ChatEffort;
  }): SessionSummary {
    if (changes.title !== undefined) this.meta = { ...this.meta, customTitle: changes.title };
    if (changes.model !== undefined) this.model = changes.model;
    if (changes.mode !== undefined && this.isCoordinator && changes.mode !== COORDINATOR_MODE)
      throw new ChatError("INVALID_REQUEST", "The coordinator always runs in architect mode");
    if (changes.mode !== undefined) this.mode = changes.mode;
    if (changes.effort !== undefined) this.effort = changes.effort;
    this.emitSession();
    void this.owner.persist(this);
    return this.summary();
  }

  /** Starts a turn, or steers the text and images into the running one. */
  send(typed: string, images?: ImageAttachment[]): { turnId: string; queued: boolean } {
    // Custom slash commands expand before queueing, as in the terminal UI, so steered and
    // queued messages carry the same prompt as a direct one.
    const text = this.owner.expandCommand(typed);
    return this.submit(images && images.length > 0 ? { text, images } : { text });
  }

  /** Starts a watch mode turn, or queues it as a turn of its own behind the running one. */
  sendWatch(turn: WatchTurn): { turnId: string; queued: boolean } {
    return this.submit({ text: turn.prompt, display: watchTurnDisplay(turn), verbatim: true });
  }

  /**
   * Wakes a coordinator on news about what it launched: a turn of its own, not shown as a user
   * message (the notices already are), queued behind a running turn. Returns false when the
   * session has no model to run it with.
   */
  wake(lines: string[]): boolean {
    if (!this.isCoordinator || lines.length === 0 || !this.model) return false;
    this.submit({ text: wakePrompt(lines), verbatim: true, hidden: true });
    return true;
  }

  emitLaunched(launched: LaunchedView[]): void {
    this.emit({ type: "launched", launched });
  }

  /** Sends a prompt the app wrote, shown as `display`, as a turn of its own behind the running one. */
  sendRequest(text: string, display: string): { turnId: string; queued: boolean } {
    return this.submit({ text, display, verbatim: true });
  }

  emitWatch(watch: WatchStatus): void {
    this.emit({ type: "watch", watch });
  }

  private submit(input: QueuedInput): { turnId: string; queued: boolean } {
    if (this.rewinding) throw new ChatError("SESSION_BUSY", "Wait for the undo or redo to finish");
    const running = this.turn ?? this.compaction;
    if (running) {
      this.queue.push(input);
      return { turnId: running.id, queued: true };
    }
    if (!this.model)
      throw new ChatError(
        "INVALID_REQUEST",
        "No model configured. Choose a model for the session or set defaultModel.",
      );
    const turn: TurnState = { id: crypto.randomUUID(), abort: new AbortController() };
    this.turn = turn;
    this.turnDone = this.runTurn(turn, input).catch(() => {});
    return { turnId: turn.id, queued: false };
  }

  private sendQueued(input: QueuedInput): void {
    this.submit(input);
  }

  interrupt(): boolean {
    if (this.compaction) {
      this.compaction.abort.abort();
      return true;
    }
    if (!this.turn) return false;
    this.turn.abort.abort();
    this.denyPrompts();
    return true;
  }

  /** One entry per turn, for undoing to it, and the undone turns a redo puts back. */
  checkpoints(): CheckpointList {
    return listCheckpoints(this.messages, this.checkpointTags, this.redoTurns);
  }

  /**
   * Drops the turns after checkpoint `toCheckpoint` (the last turn by default) and restores the
   * files they edited. Refused while a turn or compaction runs.
   */
  undo(options: { toCheckpoint?: number; force?: boolean } = {}): Promise<RewindResult> {
    return this.rewind("undo", (common) =>
      undoTurns({
        ...common,
        messages: this.messages,
        redo: this.redoTurns,
        ...(options.toCheckpoint !== undefined ? { toCheckpoint: options.toCheckpoint } : {}),
        ...(options.force ? { force: true } : {}),
      }),
    );
  }

  /** Puts back the oldest undone turn and restores the files it edited. */
  redo(options: { force?: boolean } = {}): Promise<RewindResult> {
    return this.rewind("redo", (common) =>
      redoTurn({
        ...common,
        messages: this.messages,
        redo: this.redoTurns,
        ...(options.force ? { force: true } : {}),
      }).then((r) => ({ ...r, checkpoint: r.turn })),
    );
  }

  private async rewind(
    action: "undo" | "redo",
    run: (common: { cwd: string; tags: CheckpointTag[]; backupTag: string }) => Promise<{
      checkpoint: number;
      messages: ChatMessage[];
      redo: RedoTurn[];
      rollback: RollbackReport;
    }>,
  ): Promise<RewindResult> {
    if (this.busy) throw new ChatError("SESSION_BUSY", "Wait for the running turn to finish");
    this.owner.assertIdleWorkspace();
    this.rewinding = true;
    try {
      const result = await run({
        cwd: this.owner.workspace,
        tags: this.checkpointTags,
        backupTag: `baked/${action}-backup-${crypto.randomUUID().slice(0, 8)}`,
      });
      this.messages = result.messages;
      this.core = rebuildCore(result.messages);
      this.context = null;
      this.setTab({ redoTurns: result.redo });
      await this.owner.persist(this);
      this.emit({
        type: "rewind",
        action,
        checkpoint: result.checkpoint,
        messageCount: result.messages.length,
      });
      return { action, checkpoint: result.checkpoint, rollback: result.rollback };
    } catch (err) {
      if (err instanceof TurnUndoError)
        throw new ChatError(
          err.code === "INVALID_CHECKPOINT" ? "INVALID_REQUEST" : err.code,
          err.message,
        );
      if (err instanceof RollbackError) throw new ChatError("ROLLBACK_UNAVAILABLE", err.message);
      throw err;
    } finally {
      this.rewinding = false;
      this.emitSession();
    }
  }

  /** Line counts of the files this session edited, against the repository's last commit. */
  diffStats(): Promise<SessionDiffStats> {
    return sessionDiffStats(this.owner.workspace, editedFiles(this.messages));
  }

  /**
   * Starts compacting the conversation. Refused while a turn runs, when the host cannot compact,
   * and when the conversation is too short for a summary to save anything.
   */
  compact(): { compactionId: string } {
    if (this.busy) throw new ChatError("SESSION_BUSY", "Wait for the running turn to finish");
    const { host } = this.owner;
    if (!host.compact) throw new ChatError("NOT_SUPPORTED", "This server cannot compact sessions");
    const model = this.model;
    if (!model)
      throw new ChatError(
        "INVALID_REQUEST",
        "No model configured. Choose a model for the session or set defaultModel.",
      );
    const blocker = compactionBlocker(this.core, this.owner.keepRecent);
    if (blocker) throw new ChatError("NOTHING_TO_COMPACT", blocker);
    const compaction: TurnState = { id: crypto.randomUUID(), abort: new AbortController() };
    this.compaction = compaction;
    this.emit({ type: "compaction-start", compactionId: compaction.id });
    this.emitSession();
    this.turnDone = this.runCompaction(compaction, model, host.compact.bind(host)).catch(() => {});
    return { compactionId: compaction.id };
  }

  private async runCompaction(
    compaction: TurnState,
    modelId: string,
    compact: NonNullable<ChatAgentHost["compact"]>,
  ): Promise<void> {
    let status: CompactionStatus;
    let note: string | null = null;
    let compacted = 0;
    let error: string | undefined;
    const cwd = this.owner.workspace;
    await runHooks({ event: "PreCompact", sessionId: this.meta.id, cwd }).catch(() => {});
    try {
      const response = await compact({
        sessionId: this.meta.id,
        modelId,
        messages: [...this.core],
        abortSignal: compaction.abort.signal,
      });
      const { result } = response;
      if (compaction.abort.signal.aborted) status = "interrupted";
      else if (result.status === "skipped") {
        status = "skipped";
        note = result.reason;
      } else {
        status = "compacted";
        this.autoCompactHeld = false;
        compacted = result.compacted;
        this.core = result.messages;
        const window = response.contextWindow ?? this.context?.windowTokens ?? 0;
        if (window > 0) {
          const used = Math.ceil(
            ((response.systemChars ?? 0) + messageChars(result.messages)) / CHARS_PER_TOKEN,
          );
          this.context = {
            usedTokens: used,
            windowTokens: window,
            percent: Math.round((used / window) * 100),
          };
        }
        if (result.usage)
          this.usage = {
            input: this.usage.input + result.usage.inputTokens,
            output: this.usage.output + result.usage.outputTokens,
            cacheRead: this.usage.cacheRead + (result.usage.cacheReadTokens ?? 0),
          };
        note = `Compacted ${compacted} messages into a summary (${result.strategy} strategy).${
          this.context ? ` Context is now about ${this.context.percent}%.` : ""
        }`;
      }
    } catch (err) {
      status = compaction.abort.signal.aborted ? "interrupted" : "failed";
      if (status === "failed") error = errorText(err);
    }
    const message: ChatMessage | null = note
      ? { id: crypto.randomUUID(), role: "system", content: note, timestamp: Date.now() }
      : null;
    if (message) this.messages = [...this.messages, message];
    if (status === "compacted") {
      await runHooks({ event: "PostCompact", sessionId: this.meta.id, cwd }).catch(() => {});
      // As in Claude Code, a compacted session starts again with the source `compact`.
      await startSessionHooks(this.meta.id, cwd, "compact").catch(() => {});
    }
    this.compaction = null;
    await this.owner.persist(this);
    this.emit({
      type: "compaction-done",
      compactionId: compaction.id,
      status,
      message,
      compacted,
      ...(error ? { error } : {}),
      context: this.context,
    });
    this.emitSession();
    // Messages sent while compacting start the next turn.
    if (this.queue.length > 0 && status !== "interrupted") {
      const [first, ...rest] = this.queue;
      this.queue = [];
      if (first) this.sendQueued(first);
      this.queue.push(...rest);
    } else this.queue = [];
  }

  /** Resolves when the running turn, if any, has ended and been saved. */
  settled(): Promise<void> {
    return this.turnDone;
  }

  answer(promptId: string, body: PromptAnswer): void {
    const pending = this.prompts.get(promptId);
    if (!pending) {
      throw new ChatError("STALE_PROMPT", `Prompt ${promptId} is not waiting for an answer`);
    }
    const { prompt } = pending;
    if (prompt.kind === "plan-review") {
      if (!("action" in body))
        throw new ChatError("INVALID_REQUEST", "Answer a plan review with {action}");
      const feedback = body.feedback?.trim();
      if (body.action === "revise" && !feedback)
        throw new ChatError("INVALID_REQUEST", "Say what to change in feedback");
      const outcome: PromptOutcome =
        body.action === "revise" ? "answered" : body.action === "cancel" ? "denied" : "approved";
      this.settlePrompt(
        promptId,
        { action: body.action, ...(body.action === "revise" && feedback ? { feedback } : {}) },
        outcome,
        body.action,
      );
      return;
    }
    if ("action" in body)
      throw new ChatError("INVALID_REQUEST", "Only a plan review takes {action}");
    if (prompt.kind === "question") {
      if (!("answer" in body))
        throw new ChatError("INVALID_REQUEST", "Answer a question with {answer}");
      if (body.answer === "" && !prompt.allowSkip)
        throw new ChatError("INVALID_REQUEST", "This question cannot be skipped");
      this.settlePrompt(
        promptId,
        body.answer === "" ? "__skipped__" : body.answer,
        body.answer === "" ? "skipped" : "answered",
      );
      return;
    }
    if (!("approve" in body))
      throw new ChatError("INVALID_REQUEST", "Answer an approval with {approve}");
    if (
      (prompt.kind === "split" || prompt.kind === "workflow") &&
      body.approve &&
      body.digest !== prompt.digest
    )
      throw new ChatError(
        "STALE_PROMPT",
        `Approve a ${prompt.kind} with the digest of the ${prompt.kind} it shows; this one has changed`,
      );
    this.settlePrompt(promptId, body.approve, body.approve ? "approved" : "denied");
  }

  hasPrompt(promptId: string): boolean {
    return this.prompts.has(promptId);
  }

  /** Asks a person to approve an action of this session's running turn, as a destructive prompt. */
  async confirm(description: string): Promise<boolean> {
    return (await this.ask({ kind: "destructive", description })) === true;
  }

  /** Asks a person to approve a coordinator's split as one card; true when they approve it. */
  async proposeSplit(card: Omit<Extract<ChatPrompt, { kind: "split" }>, "id" | "createdAt">) {
    return (await this.ask(card)) === true;
  }

  /** Asks a person whether to run a workflow, as one card; true when they approve it. */
  async proposeWorkflow(card: Omit<Extract<ChatPrompt, { kind: "workflow" }>, "id" | "createdAt">) {
    return (await this.ask(card)) === true;
  }

  /** Adds a note to the transcript that the model does not see, such as a launched run's news. */
  async addNotice(content: string, launch?: LaunchNote): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "system",
      content,
      timestamp: Date.now(),
      showInChat: true,
      ...(launch ? { launch } : {}),
    };
    this.messages = [...this.messages, message];
    this.emit({ type: "notice", message });
    await this.owner.persist(this);
    return message;
  }

  private settlePrompt(
    promptId: string,
    value: PromptValue,
    outcome: PromptOutcome,
    action?: PlanAction,
  ): void {
    const pending = this.prompts.get(promptId);
    if (!pending) return;
    this.prompts.delete(promptId);
    pending.resolve(value);
    this.emit({ type: "prompt-resolved", promptId, outcome, ...(action ? { action } : {}) });
    this.emitSession();
  }

  private denyPrompts(): void {
    for (const [id, pending] of [...this.prompts]) {
      this.settlePrompt(id, unanswered(pending.prompt.kind), "denied");
    }
  }

  private ask(body: PromptBody): Promise<PromptValue> {
    if (this.turn?.abort.signal.aborted) return Promise.resolve(unanswered(body.kind));
    const prompt = { ...body, id: crypto.randomUUID(), createdAt: Date.now() } as ChatPrompt;
    return new Promise((resolve) => {
      this.prompts.set(prompt.id, { prompt, resolve });
      this.emit({ type: "prompt", prompt });
      this.emitSession();
      void notificationHooks({
        sessionId: this.meta.id,
        cwd: this.owner.workspace,
        ...promptNotice(prompt),
      }).catch(() => {});
    });
  }

  private setPlan(plan: Plan | null): void {
    this.plan = plan;
    this.emit({ type: "plan", plan });
  }

  /** Waits for a person to review a plan made in plan mode; plans made in other modes go ahead. */
  private async reviewPlan(
    plan: Plan,
    planFile: string,
    content: string,
  ): Promise<PlanReviewAction> {
    if (this.mode !== "plan") return "execute";
    const value = await this.ask({
      kind: "plan-review",
      title: plan.title,
      depth: plan.depth,
      steps: plan.steps.map(({ id, label }) => ({ id, label })),
      planFile,
      content,
    });
    // Interrupted: the turn ends and the session stays in plan mode.
    if (typeof value !== "object") return "cancel";
    if (value.action === "revise") return value.feedback ?? "Revise the plan.";
    if (value.action === "cancel") {
      this.planFollowUp = { action: "cancel", plan, content };
      return "cancel";
    }
    // The plan file may have been edited during the review; carry out what it says now.
    const latest = await readFile(join(this.owner.workspace, planFile), "utf-8").catch(
      () => content,
    );
    this.planFollowUp = { action: value.action, plan, content: latest };
    // The plan runs in a turn of its own, outside plan mode, so this one stops here.
    this.turn?.abort.abort();
    return value.action === "clear-execute" ? "clear_execute" : "execute";
  }

  private approvalCallbacks(): Omit<
    TurnAgentRequest,
    "sessionId" | "modelId" | "mode" | "effort" | "planExecution"
  > {
    const approve = async (body: PromptBody): Promise<boolean> => (await this.ask(body)) === true;
    const callbacks: InteractiveCallbacks = {
      onPlanCreate: (plan) => this.setPlan({ ...plan, steps: plan.steps.map((s) => ({ ...s })) }),
      onPlanStepUpdate: (stepId, status) => {
        if (!this.plan) return;
        this.setPlan({
          ...this.plan,
          steps: this.plan.steps.map((s) =>
            s.id === stepId
              ? { ...s, status, ...(status === "active" ? { startedAt: Date.now() } : {}) }
              : s,
          ),
        });
      },
      onPlanReview: (plan, planFile, content) => this.reviewPlan(plan, planFile, content),
      onAskUser: async (question, options, allowSkip) =>
        String(await this.ask({ kind: "question", question, options, allowSkip })),
      onWebSearchApproval: (query) => approve({ kind: "web-search", query }),
      onFetchPageApproval: (url) => approve({ kind: "fetch-page", url }),
    };
    return {
      callbacks,
      onApproveOutsideCwd: (tool, path) => approve({ kind: "outside-cwd", tool, path }),
      onApproveDestructive: (description) => approve({ kind: "destructive", description }),
      drainSteering: () => {
        if (!this.turn || this.queue.length === 0) return null;
        // A message with `@` mentions or a `!command` waits for the next turn, which expands it;
        // a watch turn waits too, as a turn of its own.
        const firstRef = this.queue.findIndex((q) => q.verbatim || hasInputReferences(q.text));
        const count = firstRef === -1 ? this.queue.length : firstRef;
        if (count === 0) return null;
        const { text, images } = mergeQueued(this.queue.splice(0, count));
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          timestamp: Date.now(),
          isSteering: true,
          ...(images ? { images } : {}),
        };
        this.messages = [...this.messages, message];
        this.steered.push(images ? { text, images } : { text });
        this.emit({ type: "steering", turnId: this.turn.id, message });
        return images ? { text, images } : { text };
      },
    };
  }

  private steered: QueuedInput[] = [];

  private async runTurn(turn: TurnState, input: QueuedInput): Promise<void> {
    const { text, images } = input;
    const started = Date.now();
    const executing = this.executingPlan;
    const planExecution = executing !== null;
    this.executingPlan = null;
    // A new turn makes the undone turns unreachable: forget them and their snapshots.
    const staleRedo = this.redoTurns.length > 0;
    if (staleRedo) this.setTab({ redoTurns: [] });
    let modelText = text;
    let inputContext: InputContextItem[] | undefined;
    let send = true;
    const { host } = this.owner;
    // A plan's text is not a typed message: its `@` and `!` are plan content.
    if (host.expandInput && !executing && !input.verbatim && hasInputReferences(text)) {
      try {
        const expanded = await host.expandInput({
          sessionId: this.meta.id,
          mode: this.mode,
          text,
          onApproveDestructive: this.approvalCallbacks().onApproveDestructive,
          abortSignal: turn.abort.signal,
        });
        modelText = expanded.text;
        send = expanded.send && !turn.abort.signal.aborted;
        if (expanded.items.length > 0) inputContext = expanded.items;
      } catch (err) {
        logBackgroundError("chat:input-expansion", errorText(err));
      }
    }
    // A plan's text and a watch turn are not typed prompts; the session's first turn in this
    // process starts its hooks.
    let blockedBy: string | undefined;
    if (send && !turn.abort.signal.aborted) {
      const cwd = this.owner.workspace;
      if (!sessionHooksStarted(this.meta.id))
        await startSessionHooks(this.meta.id, cwd, this.messages.length ? "resume" : "startup");
      const prompted =
        executing || input.verbatim
          ? undefined
          : await userPromptHooks(this.meta.id, cwd, text, turn.abort.signal);
      if (prompted?.blocked) {
        send = false;
        blockedBy = prompted.reason ?? "no reason given";
      } else
        modelText = withHookContext(
          modelText,
          takeHookContext(this.meta.id),
          prompted?.additionalContext,
        );
    }
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      // The model gets the whole plan; the transcript names it, as the plan is shown above.
      content: executing ? `Execute the plan: ${executing.title}` : (input.display ?? text),
      timestamp: started,
      ...(input.hidden ? { showInChat: false } : {}),
      ...(images ? { images } : {}),
      ...(inputContext ? { inputContext } : {}),
    };
    const history: ModelMessage[] = [
      ...this.core,
      { role: "user", content: userContent(modelText, images) },
    ];
    const before = this.messages;
    this.messages = [...before, userMessage];
    this.steered = [];
    this.emit({ type: "turn-start", turnId: turn.id, message: userMessage });
    this.emitSession();

    let fullText = "";
    const segments: MessageSegment[] = [];
    const calls: ToolCall[] = [];
    const inputs = new Map<string, Record<string, unknown>>();
    const usage = emptyUsage();
    let steps = 0;
    /** When the current model step started; 0 until the model is called. */
    let stepStartedAt = 0;
    let status: "completed" | "interrupted" | "failed" = "completed";
    let error: string | undefined;
    let response: ModelMessage[] = [];
    const appendText = (delta: string): void => {
      fullText += delta;
      const last = segments.at(-1);
      if (last?.type === "text") last.content += delta;
      else segments.push({ type: "text", content: delta });
    };
    const appendReasoning = (delta: string, id: string): void => {
      const last = segments.at(-1);
      if (last?.type === "reasoning" && last.id === id) last.content += delta;
      else segments.push({ type: "reasoning", content: delta, id });
    };
    const addCallSegment = (id: string): void => {
      const last = segments.at(-1);
      if (last?.type === "tools") last.toolCallIds.push(id);
      else segments.push({ type: "tools", toolCallIds: [id] });
    };

    try {
      if (staleRedo)
        this.setTab({
          checkpointTags: await dropRedoTags(this.owner.workspace, before, this.checkpointTags),
        });
      const base = await ensureBaseSnapshot(
        this.owner.workspace,
        this.tagOwner,
        before,
        this.checkpointTags,
      );
      if (base) this.addCheckpointTag(base);
      const model = this.model;
      if (!model) throw new Error("No model configured");
      if (blockedBy) throw new Error(`A UserPromptSubmit hook blocked the prompt: ${blockedBy}`);
      // A `!` command that did not run leaves nothing to answer.
      if (!send) throw new SkipTurn();
      const { agent, contextWindow } = await this.owner.host.agent({
        sessionId: this.meta.id,
        modelId: model,
        mode: this.mode,
        effort: this.effort,
        planExecution,
        ...(this.isCoordinator
          ? { coordinator: true, tools: this.owner.coordinatorTools(this) }
          : this.owner.threadExtras(this)),
        ...this.approvalCallbacks(),
      });
      stepStartedAt = Date.now();
      const result = await agent.stream({
        messages: history,
        options: { userMessage: text },
        abortSignal: turn.abort.signal,
      });
      for await (const raw of result.stream) {
        const part = raw as { type: string } & Record<string, unknown>;
        switch (part.type) {
          case "text-delta": {
            const delta = String(part.text ?? "");
            appendText(delta);
            this.emit({ type: "text", turnId: turn.id, delta });
            break;
          }
          case "reasoning-delta": {
            const delta = String(part.text ?? "");
            appendReasoning(delta, String(part.id ?? "reasoning"));
            this.emit({ type: "reasoning", turnId: turn.id, delta });
            break;
          }
          case "tool-call": {
            const id = String(part.toolCallId);
            const input = (part.input ?? {}) as Record<string, unknown>;
            inputs.set(id, input);
            addCallSegment(id);
            this.emit({
              type: "tool-call",
              turnId: turn.id,
              toolCallId: id,
              tool: String(part.toolName),
              input,
            });
            break;
          }
          case "tool-result":
          case "tool-error": {
            const id = String(part.toolCallId);
            const tool = String(part.toolName);
            const result =
              part.type === "tool-error"
                ? { success: false, output: "", error: errorText(part.error) }
                : toolResultOf(part.output);
            const args = inputs.get(id) ?? ((part.input ?? {}) as Record<string, unknown>);
            if (!inputs.has(id)) addCallSegment(id);
            calls.push({ id, name: tool, args, result });
            this.emit({
              type: "tool-result",
              turnId: turn.id,
              toolCallId: id,
              tool,
              success: result.success,
              output:
                result.output.length > EVENT_OUTPUT_CHARS
                  ? `${result.output.slice(0, EVENT_OUTPUT_CHARS)}…`
                  : result.output,
              ...(result.error ? { error: result.error } : {}),
              ...(result.filesEdited ? { filesEdited: result.filesEdited } : {}),
            });
            break;
          }
          case "finish-step": {
            steps++;
            const stepUsage = (part.usage ?? {}) as {
              inputTokens?: number;
              outputTokens?: number;
              inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
            };
            const input = stepUsage.inputTokens ?? 0;
            const cacheRead = stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
            recordModelCall({
              modelId: model,
              source: "main",
              startedAt: stepStartedAt,
              durationMs: Math.max(0, Date.now() - stepStartedAt),
              state: "ok",
              sessionId: this.meta.id,
              input,
              output: stepUsage.outputTokens ?? 0,
              cacheRead,
              cacheWrite: stepUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
            });
            stepStartedAt = Date.now();
            usage.input += input;
            usage.output += stepUsage.outputTokens ?? 0;
            usage.cacheRead += cacheRead;
            if (contextWindow > 0) {
              const used = input + (stepUsage.outputTokens ?? 0);
              this.context = {
                usedTokens: used,
                windowTokens: contextWindow,
                percent: Math.round((used / contextWindow) * 100),
              };
            }
            this.emit({ type: "step", turnId: turn.id, step: steps, usage: { ...usage } });
            break;
          }
          case "error":
            throw part.error instanceof Error ? part.error : new Error(errorText(part.error));
          default:
            break;
        }
      }
      try {
        response = await Promise.race([
          Promise.resolve(result.responseMessages),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("response timeout")), RESPONSE_TIMEOUT_MS),
          ),
        ]);
      } catch {
        response = [];
      }
      if (turn.abort.signal.aborted) status = "interrupted";
    } catch (err) {
      if (err instanceof SkipTurn) status = turn.abort.signal.aborted ? "interrupted" : "completed";
      else if (turn.abort.signal.aborted) status = "interrupted";
      else {
        status = "failed";
        error = errorText(err);
        if (stepStartedAt > 0)
          recordModelCall({
            modelId: this.model ?? "none",
            source: "main",
            startedAt: stepStartedAt,
            durationMs: Math.max(0, Date.now() - stepStartedAt),
            state: "error",
            sessionId: this.meta.id,
            errorMessage: error.slice(0, 500),
          });
      }
    }

    this.denyPrompts();
    if (status !== "interrupted" && !blockedBy)
      void stopHooks(
        this.meta.id,
        this.owner.workspace,
        status === "failed" ? { failed: true, error: error ?? "" } : { failed: false },
      ).catch(() => {});
    const followUp = this.planFollowUp;
    this.planFollowUp = null;
    // An accepted plan stops its turn on purpose; the turn is complete, not interrupted.
    if (followUp && followUp.action !== "cancel" && status === "interrupted") status = "completed";
    if (response.length === 0 && fullText.length > 0)
      response = [{ role: "assistant", content: fullText }];
    // The agent sends steering images to the model in a note of its own; history keeps them.
    const steering = this.steered.map(
      (q): ModelMessage => ({ role: "user", content: userContent(q.text, q.images) }),
    );
    if (send) this.core = [...history, ...steering, ...response];
    const assistant: ChatMessage | null =
      fullText.length > 0 || calls.length > 0
        ? {
            id: crypto.randomUUID(),
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
            ...(calls.length > 0 ? { toolCalls: calls } : {}),
            ...(segments.length > 0 ? { segments } : {}),
            durationMs: Date.now() - started,
          }
        : null;
    if (assistant) this.messages = [...this.messages, assistant];
    if (assistant && extractFilesFromToolCalls(assistant).edited.length > 0) {
      const tag = await snapshotTurnEnd(this.owner.workspace, this.tagOwner, this.messages, text);
      if (tag) this.addCheckpointTag(tag);
    }
    this.usage = {
      input: this.usage.input + usage.input,
      output: this.usage.output + usage.output,
      cacheRead: this.usage.cacheRead + usage.cacheRead,
    };
    const notice = followUp ? this.applyPlanFollowUp(followUp) : null;
    if (!notice?.execute && this.plan) this.setPlan(null);
    this.turn = null;
    await this.owner.persist(this);
    this.emit({
      type: "turn-done",
      turnId: turn.id,
      status,
      ...(error ? { error } : {}),
      message: assistant,
      usage,
      durationMs: Date.now() - started,
    });
    if (notice) this.emit({ type: "notice", message: notice.message });
    this.emitSession();
    if (notice?.execute) {
      // The accepted plan runs first; messages sent meanwhile are steered into it.
      const queued = this.queue;
      this.queue = [];
      this.executingPlan = notice.execute.plan;
      this.submit({ text: notice.execute.prompt });
      this.queue.push(...queued);
      return;
    }
    // Text that arrived after the last step of the turn starts the next one.
    if (this.queue.length > 0 && status === "completed") {
      // Messages with `@` or `!` start a turn of their own so their expansion stays separate, and
      // so does each watch turn.
      const firstRef = this.queue.findIndex((q) => q.verbatim || hasInputReferences(q.text));
      const count = firstRef === 0 ? 1 : firstRef === -1 ? this.queue.length : firstRef;
      const next = mergeQueued(this.queue.splice(0, count));
      const rest = this.queue;
      this.queue = [];
      this.sendQueued(next);
      this.queue.push(...rest);
    } else {
      this.queue = [];
      if (status === "completed") this.autoCompact();
    }
  }

  /** Set after an automatic compaction that did not compact; cleared below the reset threshold. */
  private autoCompactHeld = false;

  /**
   * Compacts a coordinator once its context passes the compaction trigger, as the terminal UI does
   * for its chat. A compaction that saves nothing is not retried until the fill drops below the
   * reset threshold, so a long brief cannot make every turn pay for one.
   */
  private autoCompact(): void {
    if (!this.isCoordinator || !this.context) return;
    const { trigger, reset } = this.owner.compactionThresholds;
    const fill = this.context.percent / 100;
    if (fill < reset) this.autoCompactHeld = false;
    if (fill < trigger || this.autoCompactHeld || this.busy) return;
    if (!this.owner.host.compact || !this.model) return;
    if (compactionBlocker(this.core, this.owner.keepRecent)) return;
    // Cleared again when the compaction compacts; kept when it skips or fails.
    this.autoCompactHeld = true;
    this.compact();
  }

  /**
   * Leaves plan mode after a reviewed plan, as the terminal UI does, and returns the transcript note
   * and, for an accepted plan, the message that starts the turn carrying it out.
   */
  private applyPlanFollowUp(followUp: PlanFollowUp): {
    message: ChatMessage;
    execute: { plan: Plan; prompt: string } | null;
  } {
    this.mode = "default";
    let content: string;
    let execute: { plan: Plan; prompt: string } | null = null;
    if (followUp.action === "cancel") content = `Plan cancelled: ${followUp.plan.title}`;
    else {
      if (followUp.action === "clear-execute") {
        this.core = [];
        this.context = null;
      }
      content =
        followUp.action === "clear-execute"
          ? "Context cleared — executing the plan with fresh context."
          : "Plan accepted — executing.";
      execute = {
        plan: followUp.plan,
        prompt: planExecutionPrompt(followUp.plan, followUp.content),
      };
    }
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "system",
      content,
      timestamp: Date.now(),
      showInChat: true,
    };
    this.messages = [...this.messages, message];
    return { message, execute };
  }

  /** The state to save: the meta with this tab's model, mode and usage, and every tab's messages. */
  snapshot(): {
    meta: SessionMeta;
    tabMessages: Map<string, ChatMessage[]>;
    tabCore: Map<string, ModelMessage[]>;
  } {
    const now = Date.now();
    const tab: TabMeta = {
      ...this.tab,
      activeModel: this.model ?? "none",
      bakeMode: this.mode,
      effort: this.effort,
      planMode: this.mode === "plan",
      tokenUsage: {
        ...this.tab.tokenUsage,
        prompt: this.usage.input,
        completion: this.usage.output,
        total: this.usage.input + this.usage.output,
        cacheRead: this.usage.cacheRead,
      },
    };
    const derived = SessionManager.deriveTitle(this.messages);
    this.meta = {
      ...this.meta,
      title: this.messages.length > 0 ? derived : this.meta.title,
      updatedAt: now,
      bakeMode: this.mode,
      tabs: this.meta.tabs.map((t) => (t.id === this.tabId ? tab : t)),
    };
    return { meta: this.meta, tabMessages: this.tabMessages, tabCore: this.tabCore };
  }
}

export interface ChatServiceOptions {
  workspace: string;
  config: AppConfig;
  host: ChatAgentHost;
  bufferSize?: number;
  /** The home directory holding global custom commands; tests point it elsewhere. */
  homeDir?: string;
}

/** The sessions of one workspace that the API serves; loaded sessions stay in memory. */
export class ChatService {
  readonly host: ChatAgentHost;
  readonly bufferSize: number;
  private readonly store: SessionManager;
  private readonly live = new Map<string, ChatSession>();
  private closed = false;
  /** Watch mode: one session of the project receives the turns from `baked!` comments. */
  private fileWatch: {
    session: ChatSession;
    controller: WatchController;
    method: WatchStatus["method"];
    turns: number;
    last: string | null;
    error: string | null;
  } | null = null;

  constructor(private readonly options: ChatServiceOptions) {
    this.host = options.host;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER;
    this.store = new SessionManager(options.workspace);
  }

  get workspace(): string {
    return this.options.workspace;
  }

  /**
   * Expands a message that invokes a custom slash command from `.baked/commands`, reading the
   * file fresh; other text is returned as typed.
   */
  expandCommand(text: string): string {
    const home = this.options.homeDir;
    return (
      expandCustomCommandInput(text, this.workspace, undefined, home ? { home } : {})?.prompt ??
      text
    );
  }

  /** Refuses a file rollback while any loaded session runs a turn that may be editing files. */
  assertIdleWorkspace(action = "rolling back"): void {
    if ([...this.live.values()].some((s) => s.busy))
      throw new ChatError("SESSION_BUSY", `Wait for running turns to finish before ${action}`);
  }

  private projectState: ProjectStateSource | null = null;
  private launcher: ProjectLauncher | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  /**
   * Where the coordinator reads runs, initiatives and attention from and starts runs and
   * initiatives with; the API server sets both. Starts following what the coordinator launched.
   */
  setProjectState(
    source: ProjectStateSource | null,
    launcher: ProjectLauncher | null = null,
    watchMs = 2000,
  ): void {
    this.projectState = source;
    this.launcher = launcher;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    if (watchMs > 0) {
      this.watch = setInterval(() => void this.syncLaunched(), watchMs);
      this.watch.unref?.();
    }
  }

  /** The launched view last sent to the coordinator's subscribers, to send only changes. */
  private launchedSent = "";

  /**
   * Refreshes the statuses of what the coordinator launched and notes changes in its chat. News
   * that something finished, failed or waits wakes the coordinator, unless `coordinator.wake` is
   * false, and any change of the launched view (a stage, a task count) reaches its subscribers.
   */
  async syncLaunched(): Promise<string[]> {
    if (this.syncing || this.closed) return [];
    const coordinator = [...this.live.values()].find((s) => s.isCoordinator);
    if (!coordinator) return [];
    this.syncing = true;
    try {
      const notices = await syncLaunched(
        this,
        coordinator,
        this.projectState,
        this.launcher?.tasks ?? null,
        (notes) => {
          if (this.options.config.coordinator?.wake !== false)
            coordinator.wake(notes.map(wakeLine));
        },
      );
      const launched = this.launched(coordinator.id);
      const sent = JSON.stringify(launched);
      if (sent !== this.launchedSent) {
        this.launchedSent = sent;
        coordinator.emitLaunched(launched);
      }
      return notices;
    } catch (err) {
      logBackgroundError("chat:coordinator-sync", errorText(err));
      return [];
    } finally {
      this.syncing = false;
    }
  }

  /** What the coordinator `coordinatorId` launched, with live status and tokens. */
  launched(coordinatorId: string): LaunchedView[] {
    return launchedView(this, coordinatorId, this.projectState);
  }

  /** The coordinator's tools over this service: project state and launching. */
  coordinatorTools(coordinator: ChatSession): Record<string, unknown> {
    const sessions: SessionSource = {
      list: (limit) => this.list(limit),
      messages: (id) => {
        const session = this.get(id);
        return { title: session.title, messages: session.messages };
      },
    };
    return {
      [STATE_TOOL]: stateTool(this.projectState, sessions),
      ...launchTools(
        this,
        coordinator,
        this.projectState,
        this.launcher,
        coordinatorLimits(this.options.config),
        this.workflowCatalog(),
      ),
    };
  }

  /** The workflows of this project as the coordinator lists and proposes them. */
  private workflowCatalog(): WorkflowCatalog {
    const { workspace } = this;
    const { config } = this.options;
    return {
      list: () => projectDefinitions(workspace, config),
      propose: (request) => proposeForWorkspace(workspace, config, request),
    };
  }

  /** A coordinator thread's message tool and what it is told about its peers; none otherwise. */
  threadExtras(session: ChatSession): { tools?: Record<string, unknown>; instructions?: string } {
    const instructions = peerInstructions(this, session);
    if (!instructions) return {};
    return { tools: { [PEER_TOOL]: peerTool(this, session) }, instructions };
  }

  /** Context fills (0-1) at which a coordinator compacts itself, and below which it may again. */
  get compactionThresholds(): { trigger: number; reset: number } {
    const config = this.options.config.compaction;
    return {
      trigger: config?.triggerThreshold ?? DEFAULT_COMPACTION_CONFIG.triggerThreshold ?? 0.7,
      reset: config?.resetThreshold ?? DEFAULT_COMPACTION_CONFIG.resetThreshold ?? 0.4,
    };
  }

  /** Model messages a compaction keeps verbatim. */
  get keepRecent(): number {
    return this.options.config.compaction?.keepRecent ?? DEFAULT_COMPACTION_CONFIG.keepRecent ?? 4;
  }

  get defaultModel(): string | null {
    const model = this.options.config.defaultModel;
    return model && model !== "none" ? model : null;
  }

  list(limit = 50): SessionSummary[] {
    const summaries = new Map<string, SessionSummary>();
    for (const entry of this.store.listSessions()) {
      if (entry.kind === "coordinator") continue;
      summaries.set(entry.id, {
        id: entry.id,
        title: entry.title,
        messageCount: entry.messageCount,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        ...(entry.parentId ? { parentId: entry.parentId } : {}),
        state: "idle",
        model: null,
        mode: "default",
        effort: "default",
        compacting: false,
      });
    }
    for (const session of this.live.values())
      if (!session.isCoordinator) summaries.set(session.id, session.summary());
    return [...summaries.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit));
  }

  /** A loaded session, loading it by id or unique id prefix. */
  get(idOrPrefix: string): ChatSession {
    const live = this.live.get(idOrPrefix);
    if (live) return live;
    const id = this.store.findByPrefix(idOrPrefix);
    if (!id) throw new ChatError("NOT_FOUND", `Session ${idOrPrefix} not found`);
    const loaded = this.live.get(id);
    if (loaded) return loaded;
    const data = this.store.loadSession(id);
    if (!data) throw new ChatError("NOT_FOUND", `Session ${idOrPrefix} could not be read`);
    const tabCore = new Map(data.tabCoreMessages ?? []);
    for (const [tabId, messages] of data.tabMessages)
      if (!tabCore.has(tabId)) tabCore.set(tabId, rebuildCore(messages));
    const session = new ChatSession(this, data.meta, data.tabMessages, tabCore);
    this.live.set(id, session);
    return session;
  }

  async create(input: {
    title?: string;
    model?: string;
    mode?: ChatMode;
    effort?: ChatEffort;
    messages?: ChatMessage[];
    core?: ModelMessage[];
    kind?: "coordinator";
    parentId?: string;
  }): Promise<ChatSession> {
    if (this.closed) throw new ChatError("SESSION_BUSY", "The server is shutting down");
    const id = crypto.randomUUID();
    const now = Date.now();
    const messages = input.messages ?? [];
    const meta: SessionMeta = {
      id,
      title: messages.length > 0 ? SessionManager.deriveTitle(messages) : "New session",
      ...(input.title ? { customTitle: input.title } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      cwd: this.options.workspace,
      startedAt: now,
      updatedAt: now,
      activeTabId: API_TAB,
      bakeMode: input.mode ?? "default",
      tabs: [
        {
          id: API_TAB,
          label: "Desktop",
          activeModel: input.model ?? this.defaultModel ?? "none",
          sessionId: id,
          planMode: input.mode === "plan",
          planRequest: null,
          coAuthorCommits: false,
          bakeMode: input.mode ?? "default",
          ...(input.effort ? { effort: input.effort } : {}),
          tokenUsage: { prompt: 0, completion: 0, total: 0, cacheRead: 0 },
          messageRange: { startLine: 0, endLine: messages.length },
        },
      ],
    };
    const session = new ChatSession(
      this,
      meta,
      new Map([[API_TAB, messages]]),
      new Map([[API_TAB, input.core ?? rebuildCore(messages)]]),
    );
    this.live.set(id, session);
    await this.persist(session);
    return session;
  }

  /**
   * The project's coordinator session: the most recently updated one, or a new one when `create`
   * is set and there is none. Null when there is none and `create` is not set.
   */
  async coordinator(create: boolean, model?: string): Promise<ChatSession | null> {
    const live = [...this.live.values()].find((s) => s.isCoordinator);
    if (live) return live;
    const saved = this.store.listSessions().find((entry) => entry.kind === "coordinator");
    if (saved) return this.get(saved.id);
    if (!create) return null;
    return this.create({
      title: "Coordinator",
      mode: COORDINATOR_MODE,
      kind: "coordinator",
      ...(model ? { model } : {}),
    });
  }

  /**
   * A new session with the messages up to and including `atMessageId`, or all of them. With
   * `rollbackFiles` the workspace files the agent edited after that message's checkpoint are
   * restored to the checkpoint (see `src/core/checkpoints/fork.ts`).
   */
  async fork(
    idOrPrefix: string,
    atMessageId?: string,
    options: { rollbackFiles?: boolean; force?: boolean } = {},
  ): Promise<{ session: ChatSession; rollback: RollbackReport | null }> {
    const source = this.get(idOrPrefix);
    const all = source.messages;
    const point = forkPoint(all, atMessageId);
    if (!point) throw new ChatError("NOT_FOUND", `Message ${atMessageId} not found`);
    if (options.rollbackFiles) this.assertIdleWorkspace();
    const summary = source.summary();
    const session = await this.create({
      title: `${summary.title} (fork)`,
      ...(summary.model ? { model: summary.model } : {}),
      mode: summary.mode,
      effort: summary.effort,
      messages: point.messages.map((m) => ({ ...m })),
    });
    if (!options.rollbackFiles) return { session, rollback: null };
    try {
      const rollback = await rollbackToCheckpoint({
        cwd: this.options.workspace,
        messages: all,
        checkpoint: point.checkpoint,
        tags: source.checkpointTags,
        backupTag: `baked/fork-backup-${session.id.slice(0, 8)}`,
        force: options.force === true,
      });
      const copied = await copyCheckpointTags(
        this.options.workspace,
        source.checkpointTags,
        point.checkpoint,
        session.tagOwner,
      );
      for (const tag of copied) session.addCheckpointTag(tag);
      await this.persist(session);
      return { session, rollback };
    } catch (err) {
      this.live.delete(session.id);
      this.store.deleteSession(session.id);
      if (err instanceof RollbackError) throw new ChatError("ROLLBACK_UNAVAILABLE", err.message);
      throw err;
    }
  }

  /** Watch mode as session `idOrPrefix` sees it. */
  watchStatus(idOrPrefix: string): WatchStatus {
    const session = this.get(idOrPrefix);
    return this.watchStatusFor(session.id);
  }

  private watchStatusFor(sessionId: string): WatchStatus {
    const w = this.fileWatch;
    if (!w)
      return {
        watching: false,
        watchingSession: null,
        method: null,
        turns: 0,
        last: null,
        error: null,
      };
    const own = w.session.id === sessionId;
    return {
      watching: own,
      watchingSession: own ? null : w.session.id,
      method: w.method,
      turns: w.turns,
      last: w.last,
      error: w.error,
    };
  }

  /**
   * Turns watch mode on for session `idOrPrefix`, moving it from another session, or off. Each
   * saved `baked!` or `baked?` comment then starts a turn in that session.
   */
  setWatch(idOrPrefix: string, on: boolean): WatchStatus {
    const session = this.get(idOrPrefix);
    if (!on) {
      if (this.fileWatch?.session === session) this.stopWatch();
      return this.watchStatusFor(session.id);
    }
    if (this.fileWatch?.session === session) return this.watchStatusFor(session.id);
    // The session that watched hears that this one watches now.
    const previous = this.fileWatch;
    this.fileWatch = null;
    previous?.controller.stop("moved");
    const emit = (): void => {
      const w = this.fileWatch;
      if (w) w.session.emitWatch(this.watchStatusFor(w.session.id));
    };
    const controller = new WatchController(
      this.workspace,
      watchOptions(this.options.config.watch),
      {
        send: (turn) => {
          const w = this.fileWatch;
          if (!w) return;
          try {
            w.session.sendWatch(turn);
            w.turns++;
            w.last = turn.label;
            w.error = null;
          } catch (err) {
            w.error = errorText(err);
          }
          emit();
        },
        onEvent: (event) => {
          const w = this.fileWatch;
          if (!w) return;
          if (event.type === "started") w.method = event.method;
          else if (event.type === "error") w.error = event.message;
          else return;
          emit();
        },
      },
    );
    this.fileWatch = { session, controller, method: null, turns: 0, last: null, error: null };
    controller.start();
    emit();
    if (previous) previous.session.emitWatch(this.watchStatusFor(previous.session.id));
    return this.watchStatusFor(session.id);
  }

  private stopWatch(): void {
    const w = this.fileWatch;
    if (!w) return;
    this.fileWatch = null;
    w.controller.stop("off");
    w.session.emitWatch(this.watchStatusFor(w.session.id));
  }

  delete(idOrPrefix: string): void {
    const session = this.get(idOrPrefix);
    if (session.busy) throw new ChatError("SESSION_BUSY", "Interrupt the running turn first");
    if (this.fileWatch?.session === session) this.stopWatch();
    this.live.delete(session.id);
    this.host.release(session.id);
    this.store.deleteSession(session.id);
    void this.endHooks([session.id], "other");
  }

  /** Fires SessionEnd for the sessions whose SessionStart fired in this server. */
  private endHooks(ids: Iterable<string>, reason: SessionEndReason): Promise<void> {
    return Promise.all([...ids].map((id) => endSessionHooks(id, reason).catch(() => {}))).then(
      () => {},
    );
  }

  /**
   * Deletes every saved session of the workspace, as the terminal UI's `/storage` does; refused
   * while a loaded session runs a turn. Returns how many sessions were removed.
   */
  clearAll(): number {
    this.assertIdleWorkspace("clearing sessions");
    this.stopWatch();
    for (const id of this.live.keys()) this.host.release(id);
    void this.endHooks([...this.live.keys()], "clear");
    this.live.clear();
    return this.store.clearAllSessions();
  }

  async persist(session: ChatSession): Promise<void> {
    const { meta, tabMessages, tabCore } = session.snapshot();
    await this.store.saveSession(meta, tabMessages, tabCore);
  }

  /** Pending prompts of every loaded session, for the attention list. */
  attention(): { session: ChatSession; prompt: ChatPrompt }[] {
    return [...this.live.values()].flatMap((session) =>
      session.pendingPrompts.map((prompt) => ({ session, prompt })),
    );
  }

  /** Interrupts running turns, waits for them to save, and releases the host. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.stopWatch();
    const sessions = [...this.live.values()];
    for (const session of sessions) session.interrupt();
    await Promise.allSettled(sessions.map((s) => s.settled()));
    await this.endHooks(
      sessions.map((s) => s.id),
      "prompt_input_exit",
    );
    await this.host.dispose();
  }
}
