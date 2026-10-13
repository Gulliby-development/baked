import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel, ModelMessage } from "ai";
import type { createBakeAgent } from "../core/agents/index.js";
import type { SharedCacheRef } from "../core/agents/subagent-tools.js";
import { createChatAgent, createSharedCacheRef } from "../core/chat/agent.js";
import {
  editedFiles,
  formatDiffStatLines,
  formatDiffTotals,
  sessionDiffStats,
  toolCallEditPaths,
} from "../core/chat/diff-stats.js";
import { readImageFiles, userContent } from "../core/chat/images.js";
import { expandChatInput, hasInputReferences } from "../core/chat/input-expansion.js";
import { toolResultOf } from "../core/chat/tool-result.js";
import { expandCustomCommandInput } from "../core/commands/custom.js";
import { ContextManager } from "../core/context/manager.js";
import { getCwd } from "../core/cwd.js";
import {
  endSessionHooks,
  startSessionHooks,
  stopHooks,
  takeHookContext,
  userPromptHooks,
  withHookContext,
} from "../core/hooks/lifecycle.js";
import { resolveModel } from "../core/llm/provider.js";
import { buildProviderOptions, withChatEffort } from "../core/llm/provider-options.js";
import { disposeMCPManager } from "../core/mcp/index.js";
import { SessionManager } from "../core/sessions/manager.js";
import { watchOptions } from "../core/watch/config.js";
import { setActiveSessionId } from "../stores/session.js";
import type {
  AppConfig,
  BakeMode,
  ChatEffort,
  ChatMessage,
  ImageAttachment,
  InputContextItem,
  InteractiveCallbacks,
  ToolCall,
} from "../types/index.js";
import { DIM, EXIT_ABORT, EXIT_ERROR, EXIT_OK, EXIT_TIMEOUT, PURPLE, RST } from "./constants.js";
import {
  formatDuration,
  formatTokens,
  separator,
  stderrDim,
  stderrError,
  stderrLabel,
  stderrWarn,
  writeEvent,
  writeMarkdown,
} from "./output.js";
import { followProgress } from "./progress.js";
import {
  beginHeadlessTurn,
  endHeadlessTurn,
  type HeadlessSession,
  newHeadlessSession,
  openHeadlessSession,
  saveHeadlessSession,
} from "./saved-session.js";
import type { HeadlessChatOptions, HeadlessEvent, HeadlessRunOptions } from "./types.js";
import { watchPromptSource } from "./watch.js";

interface AgentEnv {
  cwd: string;
  modelId: string;
  mode: BakeMode;
  effort: ChatEffort;
  model: LanguageModel;
  agent: ReturnType<typeof createBakeAgent>;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  repoMap: ReturnType<ContextManager["getRepoMap"]> | undefined;
  providerOptions: ProviderOptions;
  headers: Record<string, string> | undefined;
  sharedCacheRef: SharedCacheRef;
}

/**
 * Re-raise SIGINT for signal-triggered exits so the parent shell sees a true
 * signal death (WIFSIGNALED) instead of a normal exit with code 130.
 * For non-signal exits, fall through to process.exit().
 */
function reraiseOrExit(code: number): never {
  if (code === EXIT_ABORT) {
    process.removeAllListeners("SIGINT");
    process.kill(process.pid, "SIGINT");
  }
  process.exit(code);
}

async function setupAgent(
  opts: {
    cwd?: string;
    modelId?: string;
    mode?: BakeMode;
    effort?: ChatEffort;
    noRepomap?: boolean;
    system?: string;
    quiet?: boolean;
    json?: boolean;
    events?: boolean;
    callbacks?: InteractiveCallbacks;
    onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
    onApproveDestructive?: (description: string) => Promise<boolean>;
    /** `--approval-review`: the approval reviewer decides low-risk approvals first. */
    approvalReview?: boolean;
  },
  merged: AppConfig,
): Promise<AgentEnv> {
  // getCwd() is authoritative — runHeadless/boot already applied --cwd.
  const cwd = getCwd();
  const mode = opts.mode ?? "default";
  const showProgress = !opts.json && !opts.events && !opts.quiet;

  const modelId = opts.modelId ?? merged.defaultModel;
  if (modelId === "none") {
    stderrError("No model configured. Pass --model provider/model or set defaultModel in config.");
    process.exit(EXIT_ERROR);
  }

  // `--effort` replaces the configured reasoning effort for this run.
  const effort = opts.effort ?? "default";
  const configured = withChatEffort(modelId, merged, effort);
  const config: AppConfig = opts.approvalReview
    ? { ...configured, agentFeatures: { ...configured.agentFeatures, approvalReview: true } }
    : configured;
  let model: LanguageModel;
  try {
    model = resolveModel(modelId, config);
  } catch (err) {
    stderrError(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_ERROR);
  }
  const providerOpts = await buildProviderOptions(modelId, config);

  try {
    const { sendBeacon, maybeShowTelemetryNotice, detectRuntime } = await import(
      "../core/telemetry.js"
    );
    const { detectModelFamily, telemetryModelInfo } = await import(
      "../core/llm/provider-options.js"
    );
    const { CURRENT_VERSION } = await import("../core/version.js");
    const { saveGlobalConfig } = await import("../config/index.js");
    maybeShowTelemetryNotice(merged, () => saveGlobalConfig({ telemetryNoticeShown: true }));
    const info = telemetryModelInfo(modelId);
    sendBeacon(
      {
        surface: "headless",
        version: CURRENT_VERSION,
        family: detectModelFamily(modelId),
        provider: info.provider,
        model: info.model,
        mode: opts.mode,
        runtime: detectRuntime(),
        repomap:
          merged.repoMap === false || opts.noRepomap || process.env.BAKED_NO_REPOMAP === "1"
            ? "skipped"
            : "on",
      },
      merged.telemetry,
      merged.telemetryUrl,
    );
  } catch {}

  const repoMapDisabled =
    merged.repoMap === false || opts.noRepomap || process.env.BAKED_NO_REPOMAP === "1";
  const contextManager = await ContextManager.createAsync(
    cwd,
    (step) => {
      if (showProgress) stderrDim(step);
    },
    { repoMapEnabled: !repoMapDisabled },
  );
  // Set accurate context window from provider metadata (avoids 200k default for 1M+ models)
  contextManager.setContextWindow(providerOpts.contextWindow);
  if (!repoMapDisabled && !contextManager.isRepoMapReady()) {
    if (showProgress) stderrDim("Waiting for Baked Map…");
    const stopFollowing = showProgress ? followProgress(stderrDim) : () => {};
    const ready = await contextManager.waitForRepoMap(30_000).finally(stopFollowing);
    if (!ready && showProgress) {
      stderrDim("⚠ Baked Map not ready — proceeding without code-map tools.");
    }
  }

  const repoMap =
    !repoMapDisabled && contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined;

  const { loadInstructions, buildInstructionPrompt } = await import("../core/instructions.js");
  const instructions = loadInstructions(cwd, merged.instructionFiles);
  let instructionText = buildInstructionPrompt(instructions);
  if (opts.system) {
    instructionText = instructionText ? `${instructionText}\n\n${opts.system}` : opts.system;
  }
  contextManager.setProjectInstructions(instructionText);

  if (mode !== "default") contextManager.setBakeMode(mode);

  try {
    const { warmupIntelligence } = await import("../core/intelligence/index.js");
    warmupIntelligence(cwd, merged.codeIntelligence);
  } catch {}

  if (merged.mcpServers?.length) {
    const { getMCPManager } = await import("../core/mcp/index.js");
    await getMCPManager().connectAll(merged.mcpServers);
  }

  // Shared file cache so dispatch subagents and multi-turn chat see edits made
  // earlier in the session (parity with useChat's sharedCacheRef).
  const { ref: sharedCacheRef } = createSharedCacheRef(cwd);
  const agent = createChatAgent({
    config,
    cwd,
    modelId,
    model,
    mode,
    contextManager,
    providerOptions: providerOpts.providerOptions,
    headers: providerOpts.headers,
    sharedCacheRef,
    callbacks: opts.callbacks,
    onApproveOutsideCwd: opts.onApproveOutsideCwd,
    onApproveDestructive: opts.onApproveDestructive,
  });

  return {
    cwd,
    modelId,
    mode,
    effort,
    model,
    agent,
    contextManager,
    sessionManager: new SessionManager(cwd),
    repoMap,
    providerOptions: providerOpts.providerOptions,
    headers: providerOpts.headers,
    sharedCacheRef,
  };
}

interface TurnResult {
  output: string;
  steps: number;
  tokens: { input: number; output: number; cacheRead: number };
  toolCalls: string[];
  /** The turn's tool calls with their input and result, as the saved session records them. */
  calls: ToolCall[];
  filesEdited: string[];
  error?: string;
  exitCode: number;
}

/**
 * Runs the UserPromptSubmit hooks of a typed prompt and returns the text to send with the context
 * the session's hooks returned, or null when a hook blocked it (reported on stderr).
 */
async function headlessPromptHooks(
  sessionId: string,
  cwd: string,
  typed: string,
  text: string,
  signal: AbortSignal,
  emit?: (event: HeadlessEvent) => void,
): Promise<string | null> {
  const prompted = await userPromptHooks(sessionId, cwd, typed, signal);
  if (prompted.blocked) {
    const reason = `A UserPromptSubmit hook blocked the prompt: ${prompted.reason ?? "no reason given"}`;
    if (emit) emit({ type: "error", error: reason });
    else stderrError(reason);
    return null;
  }
  return withHookContext(text, takeHookContext(sessionId), prompted.additionalContext);
}

/** Fires Stop, or StopFailure for a turn that failed; an interrupted turn fires neither. */
function headlessStopHooks(sessionId: string, cwd: string, turn: TurnResult): void {
  if (turn.exitCode === EXIT_ABORT) return;
  void stopHooks(
    sessionId,
    cwd,
    turn.error ? { failed: true, error: turn.error } : { failed: false },
  ).catch(() => {});
}

/** Readable text of a stream `error` part, which may carry any value. */
function streamErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/** A provider warning as the AI SDK passes it on a step. */
interface ProviderWarning {
  type: string;
  message?: string;
  feature?: string;
  setting?: string;
  details?: string;
}

/** `[type] what: details`, naming the setting or feature a warning is about. */
export function warningText(w: ProviderWarning): string {
  const subject = w.feature ?? w.setting;
  const text = [subject, w.details ?? w.message].filter(Boolean).join(": ");
  return `[${w.type}]${text ? ` ${text}` : ""}`;
}

/** A tool result in at most 200 characters: BAKED's `output`, or the text parts of an MCP result. */
export function resultSummary(raw: unknown): string {
  let text: string;
  if (raw && typeof raw === "object" && "output" in raw) {
    text = String((raw as Record<string, unknown>).output);
  } else if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { content?: unknown }).content)
  ) {
    text = ((raw as { content: unknown[] }).content as { type?: unknown; text?: unknown }[])
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  } else if (raw && typeof raw === "object") {
    text = JSON.stringify(raw);
  } else {
    text = String(raw);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Streams one turn and reports it; exported for tests. */
export async function streamTurn(
  agent: Pick<ReturnType<typeof createBakeAgent>, "stream">,
  messages: ModelMessage[],
  prompt: string,
  signal: AbortSignal,
  reporting: {
    json?: boolean;
    events?: boolean;
    quiet?: boolean;
    maxSteps?: number;
    showProgress: boolean;
    render?: boolean;
    emit?: (event: HeadlessEvent) => void;
    /** Warnings already reported in this run; shared across the turns of a chat. */
    seenWarnings?: Set<string>;
  },
): Promise<TurnResult> {
  const emit =
    reporting.emit ?? ((e: HeadlessEvent) => writeEvent(e as unknown as Record<string, unknown>));
  const seenWarnings = reporting.seenWarnings ?? new Set<string>();
  let output = "";
  let steps = 0;
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    lastStepInput: 0,
    lastStepOutput: 0,
    lastStepCacheRead: 0,
  };
  const toolCalls: string[] = [];
  const calls = new Map<string, ToolCall>();
  const filesEdited = new Set<string>();
  let error: string | undefined;
  let exitCode = EXIT_OK;

  try {
    const result = await agent.stream({
      messages,
      options: { userMessage: prompt },
      abortSignal: signal,
    });

    for await (const part of result.stream) {
      if (reporting.maxSteps && steps >= reporting.maxSteps) {
        error = `Max steps reached (${String(reporting.maxSteps)})`;
        exitCode = EXIT_ERROR;
        if (reporting.showProgress) stderrWarn(`\n${error}`);
        if (reporting.events) emit({ type: "error", error });
        break;
      }

      if (part.type === "start-step") {
        const warnings = (part as { warnings?: ProviderWarning[] }).warnings;
        if (warnings && warnings.length > 0) {
          for (const w of warnings) {
            const msg = warningText(w);
            // Providers repeat a warning on every step; it is reported once.
            if (seenWarnings.has(msg)) continue;
            seenWarnings.add(msg);
            if (reporting.events) {
              emit({ type: "warning", message: msg });
            } else if (reporting.showProgress) {
              process.stderr.write(`${DIM}  ⚠ ${msg}${RST}\n`);
            }
          }
        }
      } else if (part.type === "text-delta") {
        output += part.text;
        if (reporting.events) {
          emit({ type: "text", content: part.text });
        } else if (!reporting.json && !reporting.render) {
          process.stdout.write(part.text);
        }
      } else if (part.type === "tool-call") {
        toolCalls.push(part.toolName);
        const partInput = part as { input?: Record<string, unknown>; toolCallId?: string };
        if (reporting.events) {
          emit({
            type: "tool-call",
            tool: part.toolName,
            toolCallId: partInput.toolCallId,
            input: partInput.input,
          });
        } else if (reporting.showProgress) {
          process.stderr.write(`${DIM}  ▸ ${part.toolName}${RST}\n`);
        }
        for (const path of toolCallEditPaths(part.toolName, partInput.input)) filesEdited.add(path);
        const id = partInput.toolCallId ?? crypto.randomUUID();
        calls.set(id, { id, name: part.toolName, args: partInput.input ?? {} });
      } else if (part.type === "tool-result" || part.type === "tool-error") {
        const ended = part as {
          toolCallId?: string;
          toolName: string;
          input?: Record<string, unknown>;
          output?: unknown;
          error?: unknown;
        };
        const id = ended.toolCallId ?? crypto.randomUUID();
        calls.set(id, {
          id,
          name: ended.toolName,
          args: calls.get(id)?.args ?? ended.input ?? {},
          result:
            part.type === "tool-error"
              ? { success: false, output: "", error: streamErrorText(ended.error) }
              : toolResultOf(ended.output),
        });
        if (part.type === "tool-result" && reporting.events) {
          const summary = resultSummary(part.output);
          emit({
            type: "tool-result",
            tool: part.toolName,
            toolCallId: (part as { toolCallId?: string }).toolCallId,
            summary,
          });
        }
      } else if (part.type === "error") {
        // A provider failure arrives as a stream part rather than a thrown error.
        throw new Error(streamErrorText(part.error));
      } else if (part.type === "finish-step") {
        steps++;
        const usage = part.usage as {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: { cacheReadTokens?: number };
        };
        tokens.lastStepInput = usage.inputTokens ?? 0;
        tokens.lastStepOutput = usage.outputTokens ?? 0;
        tokens.lastStepCacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
        tokens.input += tokens.lastStepInput;
        tokens.output += tokens.lastStepOutput;
        tokens.cacheRead += tokens.lastStepCacheRead;
        // Model requests behind the step, when the provider reports them (Codex app-server).
        const requests = (part.providerMetadata as { codex?: { responses?: unknown } } | undefined)
          ?.codex?.responses;
        if (reporting.events) {
          emit({
            type: "step",
            step: steps,
            tokens: { ...tokens },
            ...(typeof requests === "number" ? { modelRequests: requests } : {}),
          });
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      error = "Aborted";
      exitCode = EXIT_ABORT;
    } else {
      error = err instanceof Error ? err.message : String(err);
      exitCode = EXIT_ERROR;
    }
    if (reporting.showProgress) stderrError(error);
    if (reporting.events) emit({ type: "error", error });
  }

  return {
    output,
    steps,
    tokens,
    toolCalls,
    calls: [...calls.values()],
    filesEdited: [...filesEdited],
    error,
    exitCode,
  };
}

/** The assistant message a turn adds to the saved conversation, with its tool calls; exported for tests. */
export function assistantMessage(turn: TurnResult): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: turn.output,
    timestamp: Date.now(),
    ...(turn.calls.length > 0 ? { toolCalls: turn.calls } : {}),
  };
}

/** Saves the conversation under the session's id and reports where it went. */
async function saveRun(
  env: AgentEnv,
  session: HeadlessSession,
  messages: ChatMessage[],
  tokens: { input: number; output: number; cacheRead: number },
  report: { showProgress: boolean; emit?: (event: HeadlessEvent) => void },
): Promise<string> {
  await saveHeadlessSession(env.sessionManager, session, {
    messages,
    tokens,
    cwd: env.cwd,
    modelId: env.modelId,
    mode: env.mode,
    effort: env.effort,
  });
  if (report.showProgress) stderrDim(`Session saved: ${session.id.slice(0, 8)}`);
  report.emit?.({ type: "session-saved", sessionId: session.id });
  return session.id;
}

export async function runPrompt(opts: HeadlessRunOptions, merged: AppConfig): Promise<void> {
  const isQuiet = opts.quiet === true;
  const isEvents = opts.events === true;
  const showProgress = !opts.json && !isEvents && !isQuiet;

  const env = await setupAgent(opts, merged);
  const startTime = Date.now();

  // Session resume: the run continues the saved session and saves back to the same id.
  let session = newHeadlessSession();
  // Routing id sent upstream. Resumed runs reuse the original id; fresh runs mint one.
  let routingSessionId: string = crypto.randomUUID();

  if (opts.sessionId) {
    const resumed = openHeadlessSession(env.sessionManager, opts.sessionId);
    if (!resumed) {
      stderrError(`Session "${opts.sessionId}" not found`);
      env.contextManager.dispose();
      await disposeMCPManager();
      process.exit(EXIT_ERROR);
    }
    session = resumed;
    routingSessionId = resumed.id;
    if (showProgress) {
      stderrDim(
        `Resumed session ${resumed.id.slice(0, 8)} (${String(resumed.messages.length)} messages)`,
      );
    }
  }
  const priorMessages = session.core;
  const priorChatMessages = session.messages;

  // Custom slash commands from .baked/commands; headless has no built-in slash commands.
  let prompt = expandHeadlessPrompt(opts.prompt, env.cwd, showProgress);

  // Include files
  if (opts.include && opts.include.length > 0) {
    const fileParts: string[] = [];
    for (const file of opts.include) {
      const fullPath = resolve(env.cwd, file);
      if (!existsSync(fullPath)) {
        stderrWarn(`--include file not found: ${file}`);
        continue;
      }
      try {
        fileParts.push(`[${file}]\n${readFileSync(fullPath, "utf-8")}`);
      } catch {}
    }
    if (fileParts.length > 0) {
      prompt = `${fileParts.join("\n\n")}\n\n${prompt}`;
    }
  }

  const typedPrompt = prompt;
  const references = await expandHeadlessReferences(prompt, env, {
    showProgress,
    emit: isEvents ? (event) => writeEvent(event as unknown as Record<string, unknown>) : undefined,
  });
  if (!references.send) {
    stderrError("The command did not run; nothing to send.");
    env.contextManager.dispose();
    await disposeMCPManager();
    process.exit(EXIT_ERROR);
  }
  prompt = references.text;

  let images: ImageAttachment[] | undefined;
  if (opts.images) {
    try {
      images = await readImageFiles(opts.images.map((file) => resolve(env.cwd, file)));
    } catch (err) {
      stderrError(err instanceof Error ? err.message : String(err));
      env.contextManager.dispose();
      await disposeMCPManager();
      process.exit(EXIT_ERROR);
    }
  }

  env.contextManager.updateConversationContext(typedPrompt, 0);

  // Header
  if (isEvents) {
    writeEvent({
      type: "start",
      model: env.modelId,
      mode: env.mode,
      session: opts.sessionId ?? null,
      repoMap: env.repoMap
        ? {
            files: env.repoMap.getStatsCached().files,
            symbols: env.repoMap.getStatsCached().symbols,
          }
        : null,
      workers: getWorkerInfo(),
    });
  } else if (showProgress) {
    stderrLabel("Model", env.modelId);
    if (env.mode !== "default") stderrLabel("Mode", env.mode);
    if (env.repoMap) {
      const stats = env.repoMap.getStatsCached();
      stderrLabel("Repo", `${String(stats.files)} files, ${String(stats.symbols)} symbols`);
    }
    const wk = getWorkerInfo();
    if (wk) stderrDim(`Workers: intelligence=${wk.intelligence}, io=${wk.io}`);
    separator();
  }

  // Abort / timeout
  const abortController = new AbortController();
  let timedOut = false;

  process.on("SIGINT", () => abortController.abort());
  if (opts.timeout) {
    setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, opts.timeout);
  }

  setActiveSessionId(routingSessionId);

  await startSessionHooks(session.id, env.cwd, opts.sessionId ? "resume" : "startup");
  const hooked = await headlessPromptHooks(
    session.id,
    env.cwd,
    typedPrompt,
    prompt,
    abortController.signal,
    isEvents ? (event) => writeEvent(event as unknown as Record<string, unknown>) : undefined,
  );
  if (hooked === null) {
    await endSessionHooks(session.id, "other");
    env.contextManager.dispose();
    await disposeMCPManager();
    process.exit(EXIT_ERROR);
  }
  prompt = hooked;

  const messages: ModelMessage[] = [
    ...priorMessages,
    { role: "user" as const, content: userContent(prompt, images) },
  ];
  // A saved run snapshots the workspace like the other front ends, so `baked session undo`
  // can restore the files the turn edits.
  if (opts.saveSession) await beginHeadlessTurn(session, env.cwd, priorChatMessages);

  const turn = await streamTurn(env.agent, messages, prompt, abortController.signal, {
    json: opts.json,
    events: isEvents,
    quiet: isQuiet,
    maxSteps: opts.maxSteps,
    showProgress,
    render: opts.render,
  });

  // Override exit code for timeout
  let exitCode = turn.exitCode;
  if (timedOut && exitCode === EXIT_ABORT) {
    turn.error = `Timeout after ${String(Math.round((opts.timeout ?? 0) / 1000))}s`;
    exitCode = EXIT_TIMEOUT;
  }
  headlessStopHooks(session.id, env.cwd, turn);

  const duration = Date.now() - startTime;
  const diffStats = await sessionDiffStats(env.cwd, [
    ...editedFiles(priorChatMessages),
    ...turn.filesEdited,
  ]);

  // Session save
  if (opts.saveSession) {
    const chatMessages: ChatMessage[] = [
      ...priorChatMessages,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: typedPrompt,
        timestamp: startTime,
        ...(images ? { images } : {}),
        ...(references.items.length > 0 ? { inputContext: references.items } : {}),
      },
      assistantMessage(turn),
    ];
    await endHeadlessTurn(session, env.cwd, chatMessages, typedPrompt);
    const savedId = await saveRun(env, session, chatMessages, turn.tokens, {
      showProgress,
      ...(isEvents
        ? { emit: (event) => writeEvent(event as unknown as Record<string, unknown>) }
        : {}),
    });
    if (showProgress) {
      const shortId = savedId.slice(0, 8);
      process.stderr.write(
        `${PURPLE()}Resume:${RST} baked --headless --session ${shortId} "your next prompt"\n`,
      );
    }
  }

  // Output
  if (isEvents) {
    writeEvent({
      type: "done",
      output: turn.output,
      steps: turn.steps,
      tokens: turn.tokens,
      toolCalls: turn.toolCalls,
      filesEdited: turn.filesEdited,
      diffStats,
      duration,
      ...(turn.error ? { error: turn.error } : {}),
    });
  } else if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          model: env.modelId,
          mode: env.mode,
          prompt,
          output: turn.output,
          steps: turn.steps,
          tokens: turn.tokens,
          toolCalls: turn.toolCalls,
          filesEdited: turn.filesEdited,
          diffStats,
          duration,
          ...(turn.error ? { error: turn.error } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (opts.render && turn.output.length > 0) {
      // Render accumulated markdown output with shiki syntax highlighting
      await writeMarkdown(turn.output);
    } else if (turn.output.length > 0 && !turn.output.endsWith("\n")) {
      process.stdout.write("\n");
    }
    if (!isQuiet) {
      if (diffStats.files.length > 0 && opts.diff) {
        separator();
        process.stderr.write(`${PURPLE()}Files changed:${RST}\n`);
        for (const line of formatDiffStatLines(diffStats)) process.stderr.write(`  ${line}\n`);
      }
      separator();
      const lines = diffStats.totals.files > 0 ? ` — ${formatDiffTotals(diffStats)}` : "";
      process.stderr.write(
        `${DIM}${String(turn.steps)} steps — ${formatTokens(turn.tokens)} — ${formatDuration(duration)}${lines}${RST}\n`,
      );
    }
  }

  await endSessionHooks(session.id, "other");
  env.contextManager.dispose();
  await disposeMCPManager();
  reraiseOrExit(exitCode);
}

function expandHeadlessPrompt(prompt: string, cwd: string, showProgress: boolean): string {
  const expanded = expandCustomCommandInput(prompt, cwd);
  if (!expanded) return prompt;
  if (showProgress) {
    stderrDim(`Custom command ${expanded.command.name} (${expanded.command.scope})`);
  }
  return expanded.prompt;
}

/**
 * Runs the prompt's `!` command and attaches what its `@` mentions name, reporting each item on
 * stderr (or as an `input-context` event).
 */
async function expandHeadlessReferences(
  prompt: string,
  env: AgentEnv,
  opts: {
    showProgress: boolean;
    emit: ((event: HeadlessEvent) => void) | undefined;
    onApproveDestructive?: (description: string) => Promise<boolean>;
    tabId?: string;
    tabLabel?: string;
  },
): Promise<{ text: string; send: boolean; items: InputContextItem[] }> {
  if (!hasInputReferences(prompt)) return { text: prompt, send: true, items: [] };
  const expanded = await expandChatInput(prompt, {
    cwd: env.cwd,
    mode: env.mode,
    ...(env.repoMap ? { repoMap: env.repoMap } : {}),
    ...(opts.onApproveDestructive ? { onApproveDestructive: opts.onApproveDestructive } : {}),
    ...(opts.tabId ? { tabId: opts.tabId } : {}),
    ...(opts.tabLabel ? { tabLabel: opts.tabLabel } : {}),
  });
  for (const f of expanded.files) env.contextManager.trackMentionedFile(f);
  if (opts.emit && expanded.items.length > 0) {
    opts.emit({ type: "input-context", items: expanded.items });
  } else if (opts.showProgress) {
    for (const item of expanded.items) {
      const sigil = item.kind === "command" ? "!" : "@";
      const line = `${sigil}${item.ref} · ${item.summary}`;
      if (item.ok) stderrDim(line);
      else stderrWarn(line);
    }
  }
  return { text: expanded.text, send: expanded.send, items: expanded.items };
}

/**
 * Read a prompt from stdin. Single newline submits.
 * Trailing backslash (\) continues to the next line (multiline support).
 */
let stdinBuf = "";
let stdinEnded = false;

function readPromptFromStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    // Check buffered data from previous reads first
    while (stdinBuf.includes("\n")) {
      const idx = stdinBuf.indexOf("\n");
      const line = stdinBuf.slice(0, idx);
      stdinBuf = stdinBuf.slice(idx + 1);

      if (line.endsWith("\\")) {
        stdinBuf = `${line.slice(0, -1)}\n${stdinBuf}`;
        continue;
      }

      const prompt = line.trim();
      if (prompt.length > 0) {
        resolve(prompt);
        return;
      }
    }

    // If stdin already closed, drain remaining buffer
    if (stdinEnded) {
      const prompt = stdinBuf.trim();
      stdinBuf = "";
      resolve(prompt.length > 0 ? prompt : null);
      return;
    }

    if (process.stdin.isPaused()) process.stdin.resume();

    const onData = (chunk: Buffer) => {
      stdinBuf += chunk.toString("utf-8");

      while (stdinBuf.includes("\n")) {
        const idx = stdinBuf.indexOf("\n");
        const line = stdinBuf.slice(0, idx);
        stdinBuf = stdinBuf.slice(idx + 1);

        if (line.endsWith("\\")) {
          stdinBuf = `${line.slice(0, -1)}\n${stdinBuf}`;
          continue;
        }

        const prompt = line.trim();
        cleanup();
        process.stdin.pause();
        resolve(prompt.length > 0 ? prompt : null);
        return;
      }
    };

    const onEnd = () => {
      stdinEnded = true;
      cleanup();
      const prompt = stdinBuf.trim();
      stdinBuf = "";
      resolve(prompt.length > 0 ? prompt : null);
    };

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

export async function runChat(opts: HeadlessChatOptions, merged: AppConfig): Promise<void> {
  const hasEventSink = typeof opts.onEvent === "function";
  const isEvents = opts.events === true || hasEventSink;
  const isQuiet = opts.quiet === true;
  const showProgress = !opts.json && !isEvents && !isQuiet;
  const emit = (event: HeadlessEvent): void => {
    if (opts.onEvent) opts.onEvent(event);
    else if (opts.events === true) writeEvent(event as unknown as Record<string, unknown>);
  };

  const env = await setupAgent(opts, merged);

  // Session resume
  let history: ModelMessage[] = [];
  let chatHistory: ChatMessage[] = [];
  // Conversation id sent upstream (x-session-id / x-session-affinity) to pin
  // provider routing. Resume reuses the original id; otherwise the caller's
  let routingSessionId: string = opts.sessionId ?? crypto.randomUUID();
  // The saved session the chat continues and saves back to; a new one when there is none.
  let session = newHeadlessSession();

  if (opts.sessionId) {
    const resumed = openHeadlessSession(env.sessionManager, opts.sessionId);
    if (resumed) {
      session = resumed;
      routingSessionId = resumed.id;
      history = [...resumed.core];
      chatHistory = [...resumed.messages];
      if (showProgress) {
        stderrDim(
          `Resumed session ${resumed.id.slice(0, 8)} (${String(resumed.messages.length)} messages)`,
        );
      }
    }
  }

  // Header
  if (isEvents) {
    emit({
      type: "start",
      model: env.modelId,
      mode: env.mode,
      chat: true,
      repoMap: env.repoMap
        ? {
            files: env.repoMap.getStatsCached().files,
            symbols: env.repoMap.getStatsCached().symbols,
          }
        : null,
      workers: getWorkerInfo(),
    });
  } else if (showProgress) {
    stderrLabel("Model", env.modelId);
    if (env.mode !== "default") stderrLabel("Mode", env.mode);
    if (env.repoMap) {
      const stats = env.repoMap.getStatsCached();
      stderrLabel("Repo", `${String(stats.files)} files, ${String(stats.symbols)} symbols`);
    }
    const wk = getWorkerInfo();
    if (wk) stderrDim(`Workers: intelligence=${wk.intelligence}, io=${wk.io}`);
    if (!opts.watch)
      stderrDim(
        "Chat mode — type a prompt and hit Enter (backslash \\ for multiline, Ctrl+C to exit)",
      );
    separator();
  }

  const totalTokens = { input: 0, output: 0, cacheRead: 0 };
  // Files the resumed session and this chat edited, for the per-turn diff stats.
  const chatEdited = new Set(editedFiles(chatHistory));
  let turns = 0;
  let aborted = false;
  let turnAbort = new AbortController();

  async function cleanupAndExit(code: number): Promise<void> {
    let savedId: string | undefined;
    if (chatHistory.length > 0) {
      savedId = await saveRun(env, session, chatHistory, totalTokens, {
        showProgress,
        ...(isEvents ? { emit } : {}),
      });
    }

    if (isEvents) {
      emit({ type: "chat-done", turns, tokens: totalTokens, sessionId: savedId });
    } else if (showProgress) {
      separator();
      stderrDim(`${String(turns)} turns — ${formatTokens(totalTokens)} total`);
      if (savedId) {
        const shortId = savedId.slice(0, 8);
        process.stderr.write(
          `${PURPLE()}Resume:${RST} baked --headless --chat --session ${shortId}\n`,
        );
      }
    }

    await endSessionHooks(session.id, "prompt_input_exit");
    env.contextManager.dispose();
    await disposeMCPManager();

    reraiseOrExit(code);
  }
  process.on("SIGINT", () => {
    if (aborted) {
      env.contextManager.dispose();
      disposeMCPManager();
      reraiseOrExit(EXIT_ABORT);
    }
    aborted = true;
    turnAbort.abort();
  });
  if (opts.signal) {
    if (opts.signal.aborted) {
      aborted = true;
      turnAbort.abort();
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          turnAbort.abort();
        },
        { once: true },
      );
    }
  }

  setActiveSessionId(routingSessionId);
  await startSessionHooks(session.id, env.cwd, opts.sessionId ? "resume" : "startup");

  if (isEvents) emit({ type: "ready" });
  if (showProgress) process.stderr.write(`${PURPLE()}▸${RST} `);

  let readPrompt = opts.readPrompt ?? readPromptFromStdin;
  if (opts.watch && !opts.readPrompt) {
    const source = watchPromptSource(env.cwd, merged.watch, {
      poll: opts.watchPoll,
      onEvent: (event) => {
        if (isEvents) emit({ type: "watch", event });
        else if (showProgress) {
          if (event.type === "started")
            stderrDim(
              `Watching ${event.root} for ${watchOptions(merged.watch).marker}! and ${watchOptions(merged.watch).marker}? comments${event.method === "poll" ? " (polling)" : ""} — Ctrl+C to stop`,
            );
          else if (event.type === "error") stderrDim(`watch: ${event.message}`);
        }
      },
      onTurn: (turn) => {
        if (isEvents) emit({ type: "watch-turn", label: turn.label, kind: turn.kind });
        else if (showProgress) stderrLabel("From", turn.label);
      },
    });
    readPrompt = source.next;
    process.on("SIGINT", source.close);
    opts.signal?.addEventListener("abort", source.close, { once: true });
  }

  // Warnings reported once for the whole chat, not on every turn.
  const seenWarnings = new Set<string>();
  while (!aborted) {
    const rawPrompt = await readPrompt();
    if (rawPrompt === null) break;
    // Watch turns quote source code, whose `@` and `!` are not chat references.
    const typed = opts.watch ? rawPrompt : expandHeadlessPrompt(rawPrompt, env.cwd, showProgress);
    const references = opts.watch
      ? { text: typed, send: true, items: [] }
      : await expandHeadlessReferences(typed, env, {
          showProgress,
          emit: isEvents ? emit : undefined,
          onApproveDestructive: opts.onApproveDestructive,
          tabId: opts.tabId,
          tabLabel: opts.tabLabel,
        });
    if (!references.send) {
      if (showProgress) process.stderr.write(`${PURPLE()}▸${RST} `);
      continue;
    }
    // Watch turns are not typed prompts: they get the session's context but no prompt hooks.
    const prompt = opts.watch
      ? withHookContext(references.text, takeHookContext(session.id))
      : await headlessPromptHooks(
          session.id,
          env.cwd,
          typed,
          references.text,
          turnAbort.signal,
          isEvents ? emit : undefined,
        );
    if (prompt === null) {
      if (showProgress) process.stderr.write(`${PURPLE()}▸${RST} `);
      continue;
    }

    turns++;
    const turnStart = Date.now();

    await beginHeadlessTurn(session, env.cwd, chatHistory);
    history.push({ role: "user" as const, content: prompt });
    chatHistory.push({
      id: crypto.randomUUID(),
      role: "user",
      content: typed,
      timestamp: turnStart,
      ...(references.items.length > 0 ? { inputContext: references.items } : {}),
    });

    env.contextManager.updateConversationContext(typed, totalTokens.input);

    turnAbort = new AbortController();
    if (opts.timeout) {
      setTimeout(() => turnAbort.abort(), opts.timeout);
    }
    if (opts.signal && !opts.signal.aborted) {
      const fwd = () => turnAbort.abort();
      opts.signal.addEventListener("abort", fwd, { once: true });
    }

    const turn = await streamTurn(env.agent, history, prompt, turnAbort.signal, {
      json: opts.json,
      events: isEvents,
      quiet: isQuiet,
      maxSteps: opts.maxSteps,
      showProgress,
      emit,
      seenWarnings,
    });

    headlessStopHooks(session.id, env.cwd, turn);
    // Even partial output is valuable — save it
    if (turn.output) history.push({ role: "assistant" as const, content: turn.output });
    if (turn.output || turn.calls.length > 0) chatHistory.push(assistantMessage(turn));
    await endHeadlessTurn(session, env.cwd, chatHistory, typed);

    for (const path of turn.filesEdited) chatEdited.add(path);
    const diffStats = await sessionDiffStats(env.cwd, [...chatEdited]);

    totalTokens.input += turn.tokens.input;
    totalTokens.output += turn.tokens.output;
    totalTokens.cacheRead += turn.tokens.cacheRead;

    if (isEvents) {
      emit({
        type: "turn-done",
        turn: turns,
        output: turn.output,
        steps: turn.steps,
        tokens: turn.tokens,
        toolCalls: turn.toolCalls,
        filesEdited: turn.filesEdited,
        diffStats,
        duration: Date.now() - turnStart,
        ...(turn.error ? { error: turn.error } : {}),
      });
      if (!aborted) emit({ type: "ready" });
    } else if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          turn: turns,
          output: turn.output,
          steps: turn.steps,
          tokens: turn.tokens,
          toolCalls: turn.toolCalls,
          filesEdited: turn.filesEdited,
          diffStats,
          duration: Date.now() - turnStart,
          ...(turn.error ? { error: turn.error } : {}),
        })}\n`,
      );
    } else {
      if (turn.output.length > 0 && !turn.output.endsWith("\n")) process.stdout.write("\n");
      if (showProgress) {
        separator();
        process.stderr.write(
          `${DIM}turn ${String(turns)} — ${String(turn.steps)} steps — ${formatTokens(turn.tokens)}${diffStats.totals.files > 0 ? ` — ${formatDiffTotals(diffStats)}` : ""}${RST}\n`,
        );
        if (!aborted) process.stderr.write(`${PURPLE()}▸${RST} `);
      }
    }

    if (turn.error) break;
  }

  await cleanupAndExit(aborted ? EXIT_ABORT : EXIT_OK);
}
function getWorkerInfo(): { intelligence: string; io: string } | null {
  try {
    const { useWorkerStore } =
      require("../stores/workers.js") as typeof import("../stores/workers.js");
    const wk = useWorkerStore.getState();
    return {
      intelligence: wk.intelligence.status,
      io: wk.io.status,
    };
  } catch {
    return null;
  }
}
