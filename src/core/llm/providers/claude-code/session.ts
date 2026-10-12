import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type { JSONSchema7, LanguageModelV3Usage } from "@ai-sdk/provider";
import { trackProcess } from "../../../process-tracker.js";
import { claudeCodeCommand, getClaudeCodeFlags } from "./cli.js";
import { type ClaudeCodePromptParts, renderClaudeCodeTurn } from "./prompt.js";

/** Sessions kept alive at once; the least recently used idle one closes beyond this. */
const MAX_SESSIONS = 4;
/** An idle session closes after this long; Claude Code's own cache outlives it. */
const IDLE_MS = 10 * 60_000;

export interface ClaudeCodeCall {
  modelId: string;
  parts: ClaudeCodePromptParts;
  abortSignal?: AbortSignal;
}

export interface ClaudeCodeTurnResult {
  structured: unknown;
  text: string;
  usage: LanguageModelV3Usage;
  /** Native tool calls the model attempted and the adapter aborted before the answer. */
  nativeToolAborts?: string[];
}

/**
 * The model kept answering with Claude Code's native tool calls instead of the JSON envelope,
 * after the turn was interrupted and corrected. BAKED's tools exist only in the system prompt.
 */
export class ClaudeCodeNativeToolError extends Error {
  readonly nativeTools: string[];
  constructor(nativeTools: string[]) {
    super(
      `Claude Code lost the BAKED tools: the model called ${nativeTools.map((name) => `"${name}"`).join(", ")} as native tools (No such tool available) and ignored the correction`,
    );
    this.name = "ClaudeCodeNativeToolError";
    this.nativeTools = nativeTools;
  }
}

/** The structured-output tool is the only native tool a turn may call. */
const STRUCTURED_OUTPUT_TOOL = "structuredoutput";
/** Corrections sent in one turn before the session is given up on. */
const MAX_NATIVE_TOOL_CORRECTIONS = 1;
/** How long an interrupted turn may take to report before the session is given up on. */
const INTERRUPT_TIMEOUT_MS = 20_000;

export const NATIVE_TOOL_CORRECTION = (name: string) =>
  `Correction: "${name}" is not a native tool here ("No such tool available"). BAKED tools are not native tools: do not call any tool. Answer the previous step only with the JSON envelope, putting the tool call in toolCalls.`;

/** The name of a native tool the event shows the model calling or being refused, if any. */
export function nativeToolInEvent(event: unknown): string | null {
  const message = (event as { message?: { content?: unknown } } | null)?.message;
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      if (block.name.toLowerCase() !== STRUCTURED_OUTPUT_TOOL) return block.name;
    } else if (block.type === "tool_result" && block.is_error === true) {
      const text =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Array<{ text?: unknown }>)
                .map((part) => String(part.text ?? ""))
                .join(" ")
            : "";
      const m = text.match(/No such tool available:?\s*([\w.:-]*)/i);
      if (m) return m[1] || "unknown";
    }
  }
  return null;
}

export interface ClaudeCodeRunner {
  run(call: ClaudeCodeCall): Promise<ClaudeCodeTurnResult>;
}

/** One running `claude -p` process in stream-json mode. */
export interface ClaudeCodeProcess {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (error: Error) => void): void;
  kill(): void;
}

export type ClaudeCodeProcessFactory = (options: {
  modelId: string;
  instructions: string;
  schema: JSONSchema7;
}) => ClaudeCodeProcess;

interface SessionState {
  process: ClaudeCodeProcess;
  modelId: string;
  instructions: string;
  schemaKey: string;
  /** Transcript entries the session already holds, as `role\ntext` keys. */
  messages: string[];
  /** The session answered the last turn; the next call must start with that assistant step. */
  awaitingAssistant: boolean;
  busy: boolean;
  closed: boolean;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pending: {
    resolve: (result: ClaudeCodeTurnResult) => void;
    reject: (error: Error) => void;
    /** An interrupt was sent for a native tool call; the next result event ends that turn. */
    interrupting: boolean;
    interruptTimer: ReturnType<typeof setTimeout> | null;
    nativeTools: string[];
    /** Usage of the interrupted attempts, charged to the final answer. */
    carriedUsage: LanguageModelV3Usage[];
  } | null;
}

interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  errors?: unknown;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

const messageKey = (message: { role: string; text: string }) => `${message.role}\n${message.text}`;

export function usageFromResult(usage: ResultEvent["usage"]): LanguageModelV3Usage {
  const noCache = usage?.input_tokens;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: {
      total: noCache === undefined ? undefined : noCache + cacheRead + cacheWrite,
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: usage?.output_tokens, text: undefined, reasoning: undefined },
  };
}

function sumUsage(usages: LanguageModelV3Usage[]): LanguageModelV3Usage {
  const [first, ...rest] = usages;
  if (!first) return usageFromResult(undefined);
  const add = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return rest.reduce<LanguageModelV3Usage>(
    (acc, usage) => ({
      inputTokens: {
        total: add(acc.inputTokens.total, usage.inputTokens.total),
        noCache: add(acc.inputTokens.noCache, usage.inputTokens.noCache),
        cacheRead: add(acc.inputTokens.cacheRead, usage.inputTokens.cacheRead),
        cacheWrite: add(acc.inputTokens.cacheWrite, usage.inputTokens.cacheWrite),
      },
      outputTokens: {
        total: add(acc.outputTokens.total, usage.outputTokens.total),
        text: undefined,
        reasoning: undefined,
      },
    }),
    first,
  );
}

function resultError(event: ResultEvent): Error {
  const detail =
    typeof event.result === "string" && event.result.trim()
      ? event.result.trim()
      : Array.isArray(event.errors) && event.errors.length > 0
        ? event.errors.map(String).join("; ")
        : `Claude Code turn ended with ${event.subtype ?? "an error"}`;
  return new Error(detail);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/** Optional flags that strip what a model adapter never uses, when the CLI has them. */
const OPTIONAL_FLAGS = [
  "--safe-mode",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

let workDirCounter = 0;

/**
 * Spawns `claude -p` in stream-json mode with every built-in tool off, BAKED's adapter
 * instructions as the system prompt and the structured-output schema. It runs in an
 * empty directory so no project CLAUDE.md reaches the prompt; BAKED sends its own context.
 */
export const spawnClaudeCodeProcess: ClaudeCodeProcessFactory = ({
  modelId,
  instructions,
  schema,
}) => {
  const dir = join(tmpdir(), `baked-claude-code-${process.pid}`, String(++workDirCounter));
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, "system-prompt.md");
  writeFileSync(promptFile, instructions, "utf8");

  const flags = getClaudeCodeFlags();
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    modelId,
    "--tools",
    "",
    "--system-prompt-file",
    promptFile,
    "--json-schema",
    JSON.stringify(schema),
    ...OPTIONAL_FLAGS.filter((flag) => flags.has(flag)),
  ];

  const child = spawn(claudeCodeCommand(), args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  trackProcess(child);

  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<(error: Error) => void> = [];
  const stderr: string[] = [];
  let exited = false;
  const fireExit = (error: Error) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(error);
  };

  child.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 50) stderr.shift();
  });
  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      for (const listener of lineListeners) listener(line);
    });
  }
  child.once("error", (error) => fireExit(error));
  child.once("exit", (code, signal) => {
    rmSync(dir, { recursive: true, force: true });
    const tail = stderr.join("").trim().split("\n").slice(-5).join("\n");
    const how = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    fireExit(new Error(`Claude Code exited with ${how}${tail ? `: ${tail}` : ""}`));
  });
  child.stdin?.on("error", () => {});

  return {
    send(line) {
      child.stdin?.write(`${line}\n`);
    },
    onLine(listener) {
      lineListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill() {
      if (child.exitCode === null && !child.killed) child.kill();
    },
  };
};

/**
 * Runs BAKED steps on long-lived Claude Code processes. A call whose transcript extends a
 * session's transcript sends only the new messages, so Claude Code keeps one conversation
 * per BAKED conversation and reads its prefix from the prompt cache instead of paying for
 * the whole transcript on every step. Anything else (compaction, a retry, another agent,
 * a changed tool list) starts a new session.
 */
export class ClaudeCodeSessionRunner implements ClaudeCodeRunner {
  private sessions: SessionState[] = [];

  constructor(private readonly spawnProcess: ClaudeCodeProcessFactory = spawnClaudeCodeProcess) {}

  async run(call: ClaudeCodeCall): Promise<ClaudeCodeTurnResult> {
    call.abortSignal?.throwIfAborted();
    const keys = call.parts.messages.map(messageKey);
    const schemaKey = JSON.stringify(call.parts.schema);
    const match = this.findSession(call, keys, schemaKey);
    const session = match?.session ?? this.startSession(call, schemaKey);
    const fromIndex = match?.fromIndex ?? 0;

    session.busy = true;
    session.lastUsed = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    try {
      const result = await this.runTurn(session, call, fromIndex);
      session.messages = keys;
      session.awaitingAssistant = true;
      return result;
    } catch (error) {
      this.closeSession(session);
      throw error;
    } finally {
      session.busy = false;
      if (!session.closed) {
        session.idleTimer = setTimeout(() => this.closeSession(session), IDLE_MS);
        session.idleTimer.unref?.();
        this.evictIdle();
      }
    }
  }

  /** Stops every Claude Code process. */
  close(): void {
    for (const session of [...this.sessions]) this.closeSession(session);
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  private findSession(
    call: ClaudeCodeCall,
    keys: string[],
    schemaKey: string,
  ): { session: SessionState; fromIndex: number } | null {
    let best: { session: SessionState; fromIndex: number } | null = null;
    for (const session of this.sessions) {
      if (session.busy || session.closed || session.modelId !== call.modelId) continue;
      if (session.instructions !== call.parts.instructions || session.schemaKey !== schemaKey)
        continue;
      if (session.messages.length > keys.length) continue;
      if (!session.messages.every((key, index) => key === keys[index])) continue;

      let fromIndex = session.messages.length;
      if (session.awaitingAssistant) {
        // The session already holds its own reply; skip BAKED's copy of it.
        if (call.parts.messages[fromIndex]?.role !== "assistant") continue;
        fromIndex += 1;
      }
      // Nothing new means a retry of the same step: answer it in a fresh session.
      if (fromIndex >= keys.length) continue;
      if (!best || fromIndex > best.fromIndex) best = { session, fromIndex };
    }
    return best;
  }

  private startSession(call: ClaudeCodeCall, schemaKey: string): SessionState {
    const proc = this.spawnProcess({
      modelId: call.modelId,
      instructions: call.parts.instructions,
      schema: call.parts.schema,
    });
    const session: SessionState = {
      process: proc,
      modelId: call.modelId,
      instructions: call.parts.instructions,
      schemaKey,
      messages: [],
      awaitingAssistant: false,
      busy: true,
      closed: false,
      lastUsed: Date.now(),
      idleTimer: null,
      pending: null,
    };
    proc.onLine((line) => this.handleLine(session, line));
    proc.onExit((error) => {
      session.closed = true;
      this.sessions = this.sessions.filter((candidate) => candidate !== session);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      const pending = session.pending;
      session.pending = null;
      pending?.reject(error);
    });
    this.sessions.push(session);
    return session;
  }

  private handleLine(session: SessionState, line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !session.pending) return;
    let event: { type?: string };
    try {
      event = JSON.parse(trimmed) as { type?: string };
    } catch {
      return;
    }
    const live = session.pending;
    if (event.type !== "result") {
      if (!live.interrupting && (event.type === "assistant" || event.type === "user")) {
        const nativeTool = nativeToolInEvent(event);
        if (nativeTool) this.abortNativeToolTurn(session, live, nativeTool);
      }
      return;
    }
    const result = event as ResultEvent;
    const pending = live;
    if (pending.interrupting) {
      pending.interrupting = false;
      if (pending.interruptTimer) clearTimeout(pending.interruptTimer);
      pending.interruptTimer = null;
      pending.carriedUsage.push(usageFromResult(result.usage));
      if (pending.nativeTools.length > MAX_NATIVE_TOOL_CORRECTIONS) {
        session.pending = null;
        pending.reject(new ClaudeCodeNativeToolError(pending.nativeTools));
        return;
      }
      const last = pending.nativeTools[pending.nativeTools.length - 1] as string;
      session.process.send(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: NATIVE_TOOL_CORRECTION(last) },
        }),
      );
      return;
    }
    session.pending = null;
    if (result.is_error || (result.subtype && result.subtype !== "success")) {
      pending.reject(resultError(result));
      return;
    }
    pending.resolve({
      structured: result.structured_output,
      text: typeof result.result === "string" ? result.result : "",
      usage: sumUsage([...pending.carriedUsage, usageFromResult(result.usage)]),
      ...(pending.nativeTools.length > 0 ? { nativeToolAborts: pending.nativeTools } : {}),
    });
  }

  /** Interrupts a turn that called a native tool; the next result event triggers the correction. */
  private abortNativeToolTurn(
    session: SessionState,
    pending: NonNullable<SessionState["pending"]>,
    nativeTool: string,
  ): void {
    pending.interrupting = true;
    pending.nativeTools.push(nativeTool);
    pending.interruptTimer = setTimeout(() => {
      if (session.pending !== pending) return;
      session.pending = null;
      pending.reject(new ClaudeCodeNativeToolError(pending.nativeTools));
      this.closeSession(session);
    }, INTERRUPT_TIMEOUT_MS);
    pending.interruptTimer.unref?.();
    session.process.send(
      JSON.stringify({
        type: "control_request",
        request_id: `baked-interrupt-${Date.now().toString(36)}`,
        request: { subtype: "interrupt" },
      }),
    );
  }

  private runTurn(
    session: SessionState,
    call: ClaudeCodeCall,
    fromIndex: number,
  ): Promise<ClaudeCodeTurnResult> {
    return new Promise<ClaudeCodeTurnResult>((resolve, reject) => {
      if (session.closed) {
        reject(new Error("Claude Code session closed"));
        return;
      }
      const onAbort = () => {
        session.pending = null;
        reject(abortError(call.abortSignal as AbortSignal));
        // An interrupted turn leaves the conversation in an unknown state.
        this.closeSession(session);
      };
      const finish = () => {
        call.abortSignal?.removeEventListener("abort", onAbort);
      };
      session.pending = {
        resolve: (result) => {
          finish();
          resolve(result);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        interrupting: false,
        interruptTimer: null,
        nativeTools: [],
        carriedUsage: [],
      };
      call.abortSignal?.addEventListener("abort", onAbort, { once: true });
      session.process.send(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: renderClaudeCodeTurn(call.parts, fromIndex) },
        }),
      );
    });
  }

  private closeSession(session: SessionState): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    session.closed = true;
    this.sessions = this.sessions.filter((candidate) => candidate !== session);
    session.process.kill();
  }

  private evictIdle(): void {
    while (this.sessions.length > MAX_SESSIONS) {
      const idle = this.sessions
        .filter((session) => !session.busy)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return;
      this.closeSession(idle);
    }
  }
}

let defaultRunner: ClaudeCodeSessionRunner | null = null;

export function getDefaultClaudeCodeRunner(): ClaudeCodeSessionRunner {
  defaultRunner ??= new ClaudeCodeSessionRunner();
  return defaultRunner;
}

/** Stops the shared runner's processes, e.g. when the provider is deactivated. */
export function closeDefaultClaudeCodeRunner(): void {
  defaultRunner?.close();
}
