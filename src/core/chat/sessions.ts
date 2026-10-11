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
 */
import type { ModelMessage } from "ai";
import { logBackgroundError } from "../../stores/errors.js";
import type {
  AppConfig,
  BakeMode,
  ChatMessage,
  ImageAttachment,
  InputContextItem,
  InteractiveCallbacks,
  MessageSegment,
  ToolCall,
  ToolResult,
} from "../../types/index.js";
import {
  checkpointTagName,
  copyCheckpointTags,
  ensureBaseSnapshot,
  forkPoint,
  RollbackError,
  type RollbackReport,
  rollbackToCheckpoint,
} from "../checkpoints/fork.js";
import { snapshotWorkspace } from "../checkpoints/snapshot.js";
import { buildTurns, type CheckpointTag, extractFilesFromToolCalls } from "../checkpoints/turns.js";
import { SessionManager } from "../sessions/manager.js";
import { rebuildCoreMessages as rebuildCore } from "../sessions/rebuild.js";
import type { SessionMeta, TabMeta } from "../sessions/types.js";
import type { ExpandedChatInput } from "./input-expansion.js";
import { hasInputReferences } from "./input-parse.js";
import type { MentionSuggestion } from "./mention-suggest.js";

export const CHAT_MODES = ["default", "architect", "auto"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
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
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  prompts: ChatPrompt[];
  queued: string[];
  usage: Usage;
  context: { usedTokens: number; windowTokens: number; percent: number } | null;
  filesEdited: string[];
  lastSeq: number;
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
  | { type: "prompt"; prompt: ChatPrompt }
  | {
      type: "prompt-resolved";
      promptId: string;
      outcome: "approved" | "denied" | "answered" | "skipped";
    }
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
  | { type: "session"; session: SessionSummary };
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

/** Builds the agent of each turn; the API server uses a host backed by `createChatAgent`. */
export interface ChatAgentHost {
  agent(request: TurnAgentRequest): Promise<{ agent: TurnAgent; contextWindow: number }>;
  /** Expands the `@` mentions and `!` command of a message; without it, text goes as typed. */
  expandInput?(request: InputExpansionRequest): Promise<ExpandedChatInput>;
  /** `@` completions for a chat input, from the workspace files and the repository graph. */
  suggestMentions?(query: string, limit?: number): Promise<MentionSuggestion[]>;
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
      | "ROLLBACK_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
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

function toolResultOf(output: unknown): ToolResult {
  if (output && typeof output === "object" && "success" in output) {
    const r = output as Partial<ToolResult> & { success: boolean };
    return {
      success: r.success,
      output: typeof r.output === "string" ? r.output : "",
      ...(r.error ? { error: r.error } : {}),
      ...(r.filesEdited ? { filesEdited: r.filesEdited } : {}),
    };
  }
  if (output && typeof output === "object" && "filesEdited" in output) {
    const d = output as { filesEdited?: string[] };
    return {
      success: true,
      output: JSON.stringify(output),
      ...(d.filesEdited ? { filesEdited: d.filesEdited } : {}),
    };
  }
  return { success: true, output: typeof output === "string" ? output : JSON.stringify(output) };
}

/** Ends a turn before the model runs, without counting as a failure. */
class SkipTurn extends Error {}

const EDIT_TOOLS = new Set(["edit_file", "write_file", "create_file", "multi_edit"]);

interface Pending {
  prompt: ChatPrompt;
  resolve: (value: boolean | string) => void;
}

interface TurnState {
  id: string;
  abort: AbortController;
}

/** One loaded session: its messages, live turn, prompts and event buffer. */
export class ChatSession {
  private meta: SessionMeta;
  private tabMessages: Map<string, ChatMessage[]>;
  private tabCore: Map<string, ModelMessage[]>;
  private readonly tabId: string;
  private model: string | null;
  private mode: ChatMode;
  private usage: Usage;
  private context: SessionDetail["context"] = null;
  private turn: TurnState | null = null;
  private turnDone: Promise<void> = Promise.resolve();
  private readonly prompts = new Map<string, Pending>();
  private queue: string[] = [];
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
    this.meta = {
      ...this.meta,
      tabs: this.meta.tabs.map((t) =>
        t.id === this.tabId ? { ...t, checkpointTags: tags.sort((a, b) => a.index - b.index) } : t,
      ),
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
    return this.turn !== null;
  }

  get state(): SessionState {
    if (this.prompts.size > 0) return "waiting";
    return this.turn ? "working" : "idle";
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
    };
  }

  detail(): SessionDetail {
    const files = new Set<string>();
    for (const message of this.messages)
      for (const call of message.toolCalls ?? []) {
        if (EDIT_TOOLS.has(call.name) && typeof call.args.path === "string")
          files.add(call.args.path);
        for (const file of call.result?.filesEdited ?? []) files.add(file);
      }
    return {
      ...this.summary(),
      messages: this.messages,
      prompts: this.pendingPrompts,
      queued: [...this.queue],
      usage: { ...this.usage },
      context: this.context,
      filesEdited: [...files].sort(),
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

  private emit(body: ChatEventBody): void {
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

  update(changes: { title?: string; model?: string; mode?: ChatMode }): SessionSummary {
    if (changes.title !== undefined) this.meta = { ...this.meta, customTitle: changes.title };
    if (changes.model !== undefined) this.model = changes.model;
    if (changes.mode !== undefined) this.mode = changes.mode;
    this.emitSession();
    void this.owner.persist(this);
    return this.summary();
  }

  /** Starts a turn, or steers the text into the running one. */
  send(text: string): { turnId: string; queued: boolean } {
    if (this.turn) {
      this.queue.push(text);
      return { turnId: this.turn.id, queued: true };
    }
    if (!this.model)
      throw new ChatError(
        "INVALID_REQUEST",
        "No model configured. Choose a model for the session or set defaultModel.",
      );
    const turn: TurnState = { id: crypto.randomUUID(), abort: new AbortController() };
    this.turn = turn;
    this.turnDone = this.runTurn(turn, text).catch(() => {});
    return { turnId: turn.id, queued: false };
  }

  interrupt(): boolean {
    if (!this.turn) return false;
    this.turn.abort.abort();
    this.denyPrompts();
    return true;
  }

  /** Resolves when the running turn, if any, has ended and been saved. */
  settled(): Promise<void> {
    return this.turnDone;
  }

  answer(promptId: string, body: { approve: boolean } | { answer: string }): void {
    const pending = this.prompts.get(promptId);
    if (!pending) {
      throw new ChatError("STALE_PROMPT", `Prompt ${promptId} is not waiting for an answer`);
    }
    const { prompt } = pending;
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
    this.settlePrompt(promptId, body.approve, body.approve ? "approved" : "denied");
  }

  hasPrompt(promptId: string): boolean {
    return this.prompts.has(promptId);
  }

  private settlePrompt(
    promptId: string,
    value: boolean | string,
    outcome: "approved" | "denied" | "answered" | "skipped",
  ): void {
    const pending = this.prompts.get(promptId);
    if (!pending) return;
    this.prompts.delete(promptId);
    pending.resolve(value);
    this.emit({ type: "prompt-resolved", promptId, outcome });
    this.emitSession();
  }

  private denyPrompts(): void {
    for (const [id, pending] of [...this.prompts]) {
      this.settlePrompt(id, pending.prompt.kind === "question" ? "__skipped__" : false, "denied");
    }
  }

  private ask(body: PromptBody): Promise<boolean | string> {
    if (this.turn?.abort.signal.aborted)
      return Promise.resolve(body.kind === "question" ? "__skipped__" : false);
    const prompt = { ...body, id: crypto.randomUUID(), createdAt: Date.now() } as ChatPrompt;
    return new Promise((resolve) => {
      this.prompts.set(prompt.id, { prompt, resolve });
      this.emit({ type: "prompt", prompt });
      this.emitSession();
    });
  }

  private approvalCallbacks(): Omit<TurnAgentRequest, "sessionId" | "modelId" | "mode"> {
    const approve = async (body: PromptBody): Promise<boolean> => (await this.ask(body)) === true;
    const callbacks: InteractiveCallbacks = {
      onPlanCreate: () => {},
      onPlanStepUpdate: () => {},
      // Plan mode is not offered over the API; a plan made in another mode goes ahead.
      onPlanReview: async () => "execute",
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
        // A message with `@` mentions or a `!command` waits for the next turn, which expands it.
        const firstRef = this.queue.findIndex((q) => hasInputReferences(q));
        const count = firstRef === -1 ? this.queue.length : firstRef;
        if (count === 0) return null;
        const text = this.queue.splice(0, count).join("\n\n");
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          timestamp: Date.now(),
          isSteering: true,
        };
        this.messages = [...this.messages, message];
        this.steered.push(text);
        this.emit({ type: "steering", turnId: this.turn.id, message });
        return { text };
      },
    };
  }

  private steered: string[] = [];

  private async runTurn(turn: TurnState, text: string): Promise<void> {
    const started = Date.now();
    let modelText = text;
    let inputContext: InputContextItem[] | undefined;
    let send = true;
    const { host } = this.owner;
    if (host.expandInput && hasInputReferences(text)) {
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
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: started,
      ...(inputContext ? { inputContext } : {}),
    };
    const history = [...this.core, { role: "user" as const, content: modelText }];
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
      const base = await ensureBaseSnapshot(
        this.owner.workspace,
        this.tagOwner,
        before,
        this.checkpointTags,
      );
      if (base) this.addCheckpointTag(base);
      const model = this.model;
      if (!model) throw new Error("No model configured");
      // A `!` command that did not run leaves nothing to answer.
      if (!send) throw new SkipTurn();
      const { agent, contextWindow } = await this.owner.host.agent({
        sessionId: this.meta.id,
        modelId: model,
        mode: this.mode,
        ...this.approvalCallbacks(),
      });
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
              inputTokenDetails?: { cacheReadTokens?: number };
            };
            const input = stepUsage.inputTokens ?? 0;
            const cacheRead = stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
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
      }
    }

    this.denyPrompts();
    if (response.length === 0 && fullText.length > 0)
      response = [{ role: "assistant", content: fullText }];
    const steering = this.steered.map((content) => ({ role: "user" as const, content }));
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
      const index = buildTurns(this.messages).length;
      const tag = checkpointTagName(this.tagOwner, index, text);
      if (await snapshotWorkspace(this.owner.workspace, tag, `baked checkpoint ${String(index)}`))
        this.addCheckpointTag({ index, anchorMessageId: userMessage.id, gitTag: tag });
    }
    this.usage = {
      input: this.usage.input + usage.input,
      output: this.usage.output + usage.output,
      cacheRead: this.usage.cacheRead + usage.cacheRead,
    };
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
    this.emitSession();
    // Text that arrived after the last step of the turn starts the next one.
    if (this.queue.length > 0 && status === "completed") {
      // Messages with `@` or `!` start a turn of their own so their expansion stays separate.
      const firstRef = this.queue.findIndex((q) => hasInputReferences(q));
      const count = firstRef === 0 ? 1 : firstRef === -1 ? this.queue.length : firstRef;
      const next = this.queue.splice(0, count).join("\n\n");
      const rest = this.queue;
      this.queue = [];
      this.send(next);
      this.queue.push(...rest);
    } else this.queue = [];
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
}

/** The sessions of one workspace that the API serves; loaded sessions stay in memory. */
export class ChatService {
  readonly host: ChatAgentHost;
  readonly bufferSize: number;
  private readonly store: SessionManager;
  private readonly live = new Map<string, ChatSession>();
  private closed = false;

  constructor(private readonly options: ChatServiceOptions) {
    this.host = options.host;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER;
    this.store = new SessionManager(options.workspace);
  }

  get workspace(): string {
    return this.options.workspace;
  }

  get defaultModel(): string | null {
    const model = this.options.config.defaultModel;
    return model && model !== "none" ? model : null;
  }

  list(limit = 50): SessionSummary[] {
    const summaries = new Map<string, SessionSummary>();
    for (const entry of this.store.listSessions()) {
      summaries.set(entry.id, {
        id: entry.id,
        title: entry.title,
        messageCount: entry.messageCount,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        state: "idle",
        model: null,
        mode: "default",
      });
    }
    for (const session of this.live.values()) summaries.set(session.id, session.summary());
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
    messages?: ChatMessage[];
    core?: ModelMessage[];
  }): Promise<ChatSession> {
    if (this.closed) throw new ChatError("SESSION_BUSY", "The server is shutting down");
    const id = crypto.randomUUID();
    const now = Date.now();
    const messages = input.messages ?? [];
    const meta: SessionMeta = {
      id,
      title: messages.length > 0 ? SessionManager.deriveTitle(messages) : "New session",
      ...(input.title ? { customTitle: input.title } : {}),
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
          planMode: false,
          planRequest: null,
          coAuthorCommits: false,
          bakeMode: input.mode ?? "default",
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
    if (options.rollbackFiles && [...this.live.values()].some((s) => s.busy))
      throw new ChatError("SESSION_BUSY", "Wait for running turns to finish before rolling back");
    const summary = source.summary();
    const session = await this.create({
      title: `${summary.title} (fork)`,
      ...(summary.model ? { model: summary.model } : {}),
      mode: summary.mode,
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

  delete(idOrPrefix: string): void {
    const session = this.get(idOrPrefix);
    if (session.busy) throw new ChatError("SESSION_BUSY", "Interrupt the running turn first");
    this.live.delete(session.id);
    this.host.release(session.id);
    this.store.deleteSession(session.id);
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
    const sessions = [...this.live.values()];
    for (const session of sessions) session.interrupt();
    await Promise.allSettled(sessions.map((s) => s.settled()));
    await this.host.dispose();
  }
}
