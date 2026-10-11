import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { getCwd } from "../../../cwd.js";
import { type CodexAppServerConnection, startCodexAppServerSession } from "./client.js";
import {
  CODEX_ADAPTER_CONFIG,
  CodexCliRunner,
  type CodexRunner,
  type CodexRunnerCall,
  type CodexRunnerResult,
  renderCodexTurnInput,
} from "./runner.js";

/** Threads kept per process; the least recently used idle thread is dropped beyond this. */
const MAX_THREADS = 16;

interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface ThreadState {
  threadId: string;
  modelId: string;
  instructions: string;
  /** Transcript entries Codex already holds, as `role\ntext` keys. */
  messages: string[];
  /** Codex answered the last turn; the next call must start with that assistant step. */
  awaitingAssistant: boolean;
  busy: boolean;
  lastUsed: number;
  totals: TokenTotals;
}

const ZERO_TOTALS: TokenTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

function messageKey(message: { role: string; text: string }): string {
  return `${message.role}\n${message.text}`;
}

function readTotals(value: unknown): TokenTotals | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof TokenTotals, unknown>>;
  const num = (field: unknown) => (typeof field === "number" ? field : 0);
  return {
    inputTokens: num(raw.inputTokens),
    cachedInputTokens: num(raw.cachedInputTokens),
    outputTokens: num(raw.outputTokens),
    reasoningOutputTokens: num(raw.reasoningOutputTokens),
    totalTokens: num(raw.totalTokens),
  };
}

function usageBetween(before: TokenTotals, after: TokenTotals): LanguageModelV2Usage {
  const inputTokens = after.inputTokens - before.inputTokens;
  const outputTokens = after.outputTokens - before.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reasoningTokens: after.reasoningOutputTokens - before.reasoningOutputTokens,
    cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Runs Codex steps on long-lived app-server threads. A call whose transcript
 * extends a thread's transcript sends only the new messages, so Codex keeps one
 * conversation (and one prompt cache key) per BAKED conversation instead of
 * paying the whole prefix uncached on every step. Anything else starts a thread.
 */
export class CodexSessionRunner implements CodexRunner {
  private connection: Promise<CodexAppServerConnection> | null = null;
  private threads: ThreadState[] = [];
  private unavailable = false;

  constructor(
    private readonly connect: () => Promise<CodexAppServerConnection> = () =>
      startCodexAppServerSession(),
    private readonly fallback: CodexRunner = new CodexCliRunner(),
  ) {}

  async run(call: CodexRunnerCall): Promise<CodexRunnerResult> {
    if (this.unavailable) return this.fallback.run(call);
    call.abortSignal?.throwIfAborted();

    let connection: CodexAppServerConnection;
    try {
      connection = await this.getConnection();
    } catch {
      this.unavailable = true;
      return this.fallback.run(call);
    }

    const keys = call.parts.messages.map(messageKey);
    const match = this.findThread(call, keys);
    let thread: ThreadState;
    let fromIndex: number;
    if (match) {
      thread = match.thread;
      fromIndex = match.fromIndex;
    } else {
      try {
        thread = await this.startThread(connection, call);
      } catch {
        // An app-server that cannot open a thread (an older Codex, a bad option)
        // must not block the run: this step goes through `codex exec` instead.
        return this.fallback.run(call);
      }
      fromIndex = 0;
    }

    thread.busy = true;
    thread.lastUsed = Date.now();
    try {
      const result = await this.runTurn(connection, thread, call, fromIndex);
      thread.messages = keys;
      thread.awaitingAssistant = true;
      return result;
    } catch (error) {
      this.dropThread(connection, thread);
      throw error;
    } finally {
      thread.busy = false;
    }
  }

  /** Closes the app-server process and forgets every thread. */
  close(): void {
    const pending = this.connection;
    this.connection = null;
    this.threads = [];
    void pending?.then((connection) => connection.close()).catch(() => {});
  }

  private async getConnection(): Promise<CodexAppServerConnection> {
    if (this.connection) {
      const existing = await this.connection;
      if (!existing.closed) return existing;
      this.connection = null;
      this.threads = [];
    }
    const pending = this.connect();
    this.connection = pending;
    try {
      const connection = await pending;
      connection.onClose(() => {
        if (this.connection === pending) {
          this.connection = null;
          this.threads = [];
        }
      });
      return connection;
    } catch (error) {
      this.connection = null;
      throw error;
    }
  }

  private findThread(
    call: CodexRunnerCall,
    keys: string[],
  ): { thread: ThreadState; fromIndex: number } | null {
    let best: { thread: ThreadState; fromIndex: number } | null = null;
    for (const thread of this.threads) {
      if (thread.busy || thread.modelId !== call.modelId) continue;
      if (thread.instructions !== call.parts.instructions) continue;
      if (thread.messages.length > keys.length) continue;
      if (!thread.messages.every((key, index) => key === keys[index])) continue;

      let fromIndex = thread.messages.length;
      if (thread.awaitingAssistant) {
        // Codex already holds its own reply; skip BAKED's copy of it.
        if (call.parts.messages[fromIndex]?.role !== "assistant") continue;
        fromIndex += 1;
      }
      // Nothing new means a retry of the same step: answer it on a fresh thread.
      if (fromIndex >= keys.length) continue;
      if (!best || fromIndex > best.fromIndex) best = { thread, fromIndex };
    }
    return best;
  }

  private async startThread(
    connection: CodexAppServerConnection,
    call: CodexRunnerCall,
  ): Promise<ThreadState> {
    const result = (await connection.request("thread/start", {
      model: call.modelId,
      cwd: getCwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: call.parts.instructions,
      config: CODEX_ADAPTER_CONFIG,
    })) as { thread?: { id?: unknown } } | undefined;
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string") throw new Error("Codex app-server returned no thread id");

    const thread: ThreadState = {
      threadId,
      modelId: call.modelId,
      instructions: call.parts.instructions,
      messages: [],
      awaitingAssistant: false,
      // Busy from the start so a parallel call cannot claim the empty thread.
      busy: true,
      lastUsed: Date.now(),
      totals: { ...ZERO_TOTALS },
    };
    this.threads.push(thread);
    this.evictIdleThreads(connection);
    return thread;
  }

  private runTurn(
    connection: CodexAppServerConnection,
    thread: ThreadState,
    call: CodexRunnerCall,
    fromIndex: number,
  ): Promise<CodexRunnerResult> {
    const { threadId } = thread;
    const before = thread.totals;

    return new Promise<CodexRunnerResult>((resolve, reject) => {
      let finalText = "";
      let lastError: string | null = null;
      let turnId: string | null = null;
      let settled = false;

      const finish = (error: Error | null, result?: CodexRunnerResult) => {
        if (settled) return;
        settled = true;
        stopNotifications();
        stopClose();
        call.abortSignal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else if (result) resolve(result);
      };

      const onAbort = () => {
        if (turnId) {
          void connection.request("turn/interrupt", { threadId, turnId }).catch(() => {});
        }
        finish(abortError(call.abortSignal as AbortSignal));
      };

      // Subscribe before turn/start: notifications can arrive before its response.
      const stopNotifications = connection.onNotification((method, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        if (params.threadId !== threadId) return;
        if (method === "item/completed") {
          const item = params.item as { type?: string; text?: unknown } | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            finalText = item.text;
          }
        } else if (method === "thread/tokenUsage/updated") {
          const usage = params.tokenUsage as { total?: unknown } | undefined;
          const totals = readTotals(usage?.total);
          if (totals) thread.totals = totals;
        } else if (method === "error") {
          const error = params.error as { message?: unknown } | undefined;
          if (params.willRetry !== true && typeof error?.message === "string") {
            lastError = error.message;
          }
        } else if (method === "turn/completed") {
          const turn = params.turn as
            | {
                status?: string;
                error?: { message?: unknown } | null;
                items?: Array<{ type?: string; text?: unknown }>;
              }
            | undefined;
          for (const item of turn?.items ?? []) {
            if (item?.type === "agentMessage" && typeof item.text === "string") {
              finalText = item.text;
            }
          }
          if (turn?.status !== "completed") {
            const message =
              typeof turn?.error?.message === "string"
                ? turn.error.message
                : (lastError ?? `Codex turn ${turn?.status ?? "failed"}`);
            finish(new Error(message));
            return;
          }
          if (!finalText) {
            finish(new Error(lastError ?? "Codex returned no final agent message"));
            return;
          }
          finish(null, { text: finalText, usage: usageBetween(before, thread.totals) });
        }
      });
      const stopClose = connection.onClose((error) => finish(error));
      call.abortSignal?.addEventListener("abort", onAbort, { once: true });

      connection
        .request("turn/start", {
          threadId,
          input: [
            { type: "text", text: renderCodexTurnInput(call.parts, fromIndex), text_elements: [] },
          ],
          outputSchema: call.schema,
        })
        .then((result) => {
          const id = (result as { turn?: { id?: unknown } } | undefined)?.turn?.id;
          if (typeof id === "string") turnId = id;
          if (settled && call.abortSignal?.aborted && turnId) {
            void connection.request("turn/interrupt", { threadId, turnId }).catch(() => {});
          }
        })
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }

  private dropThread(connection: CodexAppServerConnection, thread: ThreadState): void {
    this.threads = this.threads.filter((candidate) => candidate !== thread);
    void connection.request("thread/unsubscribe", { threadId: thread.threadId }).catch(() => {});
  }

  private evictIdleThreads(connection: CodexAppServerConnection): void {
    while (this.threads.length > MAX_THREADS) {
      const idle = this.threads
        .filter((thread) => !thread.busy)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return;
      this.dropThread(connection, idle);
    }
  }
}

let defaultRunner: CodexRunner | null = null;

/**
 * The runner `createModel` uses: app-server threads, or one `codex exec` per step
 * when BAKED_CODEX_TRANSPORT=exec.
 */
export function getDefaultCodexRunner(): CodexRunner {
  if (!defaultRunner) {
    defaultRunner =
      process.env.BAKED_CODEX_TRANSPORT === "exec"
        ? new CodexCliRunner()
        : new CodexSessionRunner();
  }
  return defaultRunner;
}
