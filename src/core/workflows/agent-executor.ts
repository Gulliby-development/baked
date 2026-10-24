import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import {
  generateText,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type Tool,
  ToolChoiceViolationError,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { AbnormalFinishError, cleanStepMessages } from "../agents/stream-options.js";
import { ContextManager } from "../context/manager.js";
import { SharedRootContext } from "../context/shared-root.js";
import { recordModelCall } from "../diagnostics/model-events.js";
import { hasToolHooks } from "../hooks/index.js";
import { formatSyntaxErrors, syntaxCheckable, syntaxErrors } from "../intelligence/syntax-check.js";
import { FirstByteHistory } from "../llm/first-byte-history.js";
import { knownModelContextWindow } from "../llm/models.js";
import { resolveModel } from "../llm/provider.js";
import { lostAnswer } from "../llm/provider-answer.js";
import { type CallTiming, withProviderHealth } from "../llm/provider-health.js";
import {
  buildProviderOptions,
  type CacheTTL,
  getEphemeralCache,
  withAutomaticCache,
  withRouteEffort,
} from "../llm/provider-options.js";
import { dataDir } from "../platform/index.js";
import { runSandbox } from "../security/sandbox.js";
import { canonical } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { withEditDiagnosticsMode } from "../tools/edit-diagnostics.js";
import { buildTools } from "../tools/index.js";
import { contentHash, deriveTool, withoutAstEditHint } from "../tools/tool-utils.js";
import {
  buildCheckEnv,
  CheckRunner,
  executeCheckCommand,
  modelCheckOutput,
} from "../verification/check-runner.js";
import {
  PROBE_TRIES,
  probeTool,
  reproExecutables,
  runProbe,
  writesDocumentation,
} from "../verification/repro.js";
import { changedPaths, sourceManifest } from "../verification/snapshot.js";
import { type ReplayResult, replayProblems } from "./acceptance-rows-replay.js";
import { affectedTestsFor, taskCaseText, writtenTestsCheck } from "./affected-tests.js";
import { assertAttemptFits, growBudgetOnProgress } from "./budget.js";
import {
  cwdPath,
  fixerCommand,
  fixerTiers,
  isWholeUnitFixer,
  isWholeUnitFormatter,
  wholeUnitFixerCommand,
  writtenCodePaths,
} from "./check-policy.js";
import { splitWorkflowContext } from "./context.js";
import { assertForecastFits } from "./cost-forecast.js";
import { fileHash, rootField } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { addsDoubledEscapes, escapeHintFor } from "./escape-hint.js";
import { executionClock } from "./execution-clock.js";
import { keepOutside, restoreOutside } from "./fixer-scope.js";
import { withHostConstants } from "./host-constants.js";
import {
  accountIdentityMessage,
  findAccountIdentity,
  foreignAccountIdentities,
} from "./host-identity.js";
import { InitiativePlanSchema } from "./initiatives/plan.js";
import type { WorkspaceLeases } from "./leases.js";
import { grantedMcpServers, isMcpToolName, toolListAllows } from "./mcp-grants.js";
import {
  attemptModel,
  type RecordedCall,
  readRecording,
  recordedAttempts,
  recordingKey,
  recordingPath,
} from "./model-recording.js";
import { ProcessScope } from "./process-scope.js";
import { EDIT_TOOLS } from "./progress-watch.js";
import { isTargetedRead, outlineLargeReads } from "./read-outline.js";
import { settleInterruptedEdits } from "./recovery.js";
import { recoveryAdvice } from "./remedies.js";
import { restorableVersion } from "./restore-file.js";
import { isOutputLimit, isTransient } from "./retry.js";
import { RevisionSchema } from "./revision-patch.js";
import {
  AnalysisSchema,
  ApprovalReviewSchema,
  CritiqueSchema,
  DistinctionSchema,
  generatedPaths,
  ImplementationSchema,
  MutantProposalSchema,
  PlanSchema,
  RefutationSchema,
  ReportSchema,
  ResearchSchema,
  ReviewSchema,
  type RunPolicy,
  SpecSchema,
} from "./schemas.js";
import { indexTools, markStaleIndexResult, writtenInRoot } from "./stale-index.js";
import {
  recordModelSilence,
  type StallSettings,
  silenceLimitMs,
  stalledFault,
  stallSettings,
  touchProgress,
} from "./stall.js";
import {
  ALL_TOKENS_FACTOR,
  AttemptStepController,
  type AttemptUsageRecord,
  DEFAULT_MAX_ATTEMPT_TOKENS,
  KEEP_RECENT_TOOL_MESSAGES,
  MIN_ATTEMPT_STEPS,
  type StepLike,
  stepTokens,
  type ToolBackendCount,
  toolCallName,
} from "./step-budget.js";
import { stopFault } from "./stop-reasons.js";
import type { EffectRow, WorkflowStore } from "./store.js";
import { failureOwnerNote } from "./task-graph.js";
import { pureWorkflowTools, WorkflowToolPolicy } from "./tool-policy.js";
import type { AgentExecutor, ExecutionRequest, ExecutionResponse, Task } from "./types.js";
import { AcceptanceDraftSchema, AcceptanceWalkSchema } from "./v2/acceptance.js";

export const outputSchemas: Record<string, z.ZodType> = {
  research: ResearchSchema,
  spec: SpecSchema,
  plan: PlanSchema,
  analysis: AnalysisSchema,
  implementation: ImplementationSchema,
  review: ReviewSchema,
  convergence: ReviewSchema,
  refutation: RefutationSchema,
  report: ReportSchema,
  acceptance: AcceptanceWalkSchema,
  "acceptance-draft": AcceptanceDraftSchema,
  initiativePlan: InitiativePlanSchema,
  "approval-review": ApprovalReviewSchema,
  critique: CritiqueSchema,
  mutants: MutantProposalSchema,
  distinction: DistinctionSchema,
  revision: RevisionSchema,
};
const MAX_SEMANTIC_CORRECTIONS = 2;
/** Submissions refused because a written file does not parse; the next one is accepted (#977). */
const MAX_SYNTAX_REFUSALS = 2;
/** Submissions refused because a finding the task corrects still reproduces (#1158). */
const MAX_REPRO_REFUSALS = 2;
/** Submissions refused because the test files leave out a case the criteria quote (#1250). */
const MAX_CASE_REFUSALS = 2;
/** Submissions refused because a source task's code fails the audited rows (#1617). */
const MAX_REPLAY_REFUSALS = 2;
/** Refusals of one path by the file-hash check after which an attempt stops (#954). */
const MAX_HASH_REFUSALS = 3;

/** Workspace paths an attempt's applied file edits wrote, in first-write order. */
export function appliedPaths(effects: readonly EffectRow[], attemptId: string): string[] {
  const paths: string[] = [];
  for (const effect of effects) {
    if (effect.attempt_id !== attemptId || effect.kind !== "file_patch") continue;
    if (effect.status !== "applied") continue;
    const path = (JSON.parse(effect.intent_json) as { path?: unknown }).path;
    if (typeof path === "string" && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
/** Appends the syntax errors an edit left in its file to the edit tool's output (#977). */
async function withSyntaxNote(
  result: unknown,
  regressions: () => Promise<string[]>,
): Promise<unknown> {
  const edited = result as { success?: unknown; output?: unknown } | null;
  if (!edited || typeof edited !== "object" || edited.success !== true) return result;
  if (typeof edited.output !== "string") return result;
  let errors: string[];
  try {
    errors = await regressions();
  } catch {
    return result;
  }
  if (!errors.length) return result;
  return {
    ...edited,
    output: `${edited.output}\n\nSyntax check: the file does not parse after this edit:\n${errors.join("\n")}\nFix it before submit_result, which refuses a written file that does not parse.`,
  };
}
/** Read-only steps in a row before an implementer is told to edit. */
const EDIT_NUDGE_AFTER_READS = 4;

/** Input and output tokens over steps; a side stays undefined when no step reported it. */
/** Sent after a step that ended without a tool call, before the one forced submission. */
const SUBMIT_NOW_NOTICE =
  "You ended your turn without calling submit_result. Call submit_result now with the complete result for the work already done. If the task is not finished or something failed, submit outcome blocked (or the matching unfinished state) and list what is unresolved. Do not call any other tool.";

/**
 * Model steps ran but every one reported zero input and output tokens. Codex reports a response's
 * usage only once its tool call is answered, so an attempt that ends at its only tool call (a
 * submit) never hears its spend; that is unknown, not free (#364, #592).
 */
export function reportedNoTokens(steps: readonly StepLike[]): boolean {
  return (
    steps.length > 0 &&
    steps.every((step) => step.usage.inputTokens === 0 && step.usage.outputTokens === 0)
  );
}

/**
 * The tokens of an attempt whose provider reported none, from the bytes it sent and received at
 * about 4 bytes a token: the prompt once per step, and the text and tool call arguments of the
 * steps (the submitted result among them). Codex spec and plan revisions recorded 0 tokens and
 * $0 for real work (bench round 20, colfit 448c01af: a 15 KB revised spec, #1057).
 */
export function estimateUnreportedUsage(
  prompt: string,
  steps: readonly StepLike[],
  text: string,
): { inputTokens: number; outputTokens: number } {
  const tokens = (bytes: number) => Math.ceil(bytes / 4);
  const calls = steps.flatMap((step) => step.toolCalls) as { input?: unknown; args?: unknown }[];
  const argumentBytes = calls.reduce((sum, call) => {
    const value = call?.input ?? call?.args;
    if (value === undefined) return sum;
    return sum + Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
  }, 0);
  return {
    inputTokens: tokens(Buffer.byteLength(prompt) * Math.max(1, steps.length)),
    outputTokens: tokens(Buffer.byteLength(text) + argumentBytes),
  };
}

/**
 * The tokens of a model call the provider ended for running past its output cap, which reports
 * none: the messages it was sent at about 4 bytes a token, and a full response at the cap. Bench
 * round 41 (fpbits): a 10 minute xhigh response ended "Incomplete response returned, reason:
 * max_output_tokens" and was recorded as 0 tokens and $0 (#1479).
 */
export function outputLimitUsage(
  sentBytes: number,
  maxOutputTokens: number,
): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Math.ceil(sentBytes / 4), outputTokens: maxOutputTokens };
}

function sumUsage(steps: readonly StepLike[]): Partial<LanguageModelUsage> {
  const add = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : a + b;
  return steps.reduce<Partial<LanguageModelUsage>>(
    (sum, step) => ({
      inputTokens: add(sum.inputTokens, step.usage.inputTokens),
      outputTokens: add(sum.outputTokens, step.usage.outputTokens),
    }),
    {},
  );
}

/** What the stall watchdog of one attempt knows: its progress, its tool in flight, its limits. */
interface AttemptWatch {
  settings: StallSettings;
  lastAt: number;
  lastTool: string | null;
  tools: number;
  /** Buffering adapters use their first-byte deadline until they report model activity. */
  bufferedProviders: number;
  deadlines: number;
  /** When the model call of the current step started, until it asks for a tool or ends. */
  calledAt: number | null;
  /** Each model call's timing, kept in the attempt's usage record for trace replay (#1715). */
  calls: CallTiming[];
  abort(error: Error): void;
}

/**
 * Whether `expected` names the current content of a file `delete_file` is asked to remove: the
 * `hash:` footer `read` prints (Bun's content hash, which is not a SHA-256), the file's SHA-256,
 * or a prefix of that SHA-256 of at least 16 characters (#970).
 */
export function deleteHashMatches(path: string, expected: string): boolean {
  const sha = fileHash(path);
  if (sha === null) return false;
  if (expected === sha || (expected.length >= 16 && sha.startsWith(expected))) return true;
  return contentHash(readFileSync(path, "utf-8")) === expected;
}

/**
 * The attempt's prompt as its opening user message. A workflow context is sent as two text parts
 * with a cache breakpoint after the run-level part, so the next attempt of the run reads that
 * part from the prompt cache instead of writing it again (#995).
 */
function openingMessage(prompt: string, ttl: CacheTTL): ModelMessage {
  const split = splitWorkflowContext(prompt);
  if (!split) return { role: "user", content: prompt };
  return {
    role: "user",
    content: [
      { type: "text", text: split.shared, providerOptions: getEphemeralCache(ttl) },
      { type: "text", text: split.own },
    ],
  };
}

export class NativeAgentExecutor implements AgentExecutor {
  private readonly rootContext: SharedRootContext;
  private readonly ownsRootContext: boolean;
  /** Recordings a replay run reads, by path, loaded once per executor. */
  private readonly replays = new Map<string, RecordedCall[]>();
  /** First-response times of the workspace's calls, read once per executor (#1766). */
  private firstBytes: FirstByteHistory | null = null;
  /** Without `rootContext`, the executor creates and disposes a root of its own. */
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
    private config: AppConfig,
    rootContext?: SharedRootContext,
  ) {
    this.rootContext = rootContext ?? SharedRootContext.forWorkspace(store.workspace, config);
    this.ownsRootContext = !rootContext;
  }
  /**
   * Runs one attempt under a stall watchdog: an attempt that journals no model step and no tool
   * call for `workflows.stall.stepStallMs` is aborted with a `step_stalled` fault, after the
   * edits it left unsettled are decided from their file hashes. The scheduler then blocks the run
   * and the service resumes it by itself (see `WorkflowService.drive`).
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    const settings = stallSettings(this.config);
    const stall = new AbortController();
    const watch: AttemptWatch = {
      settings,
      lastAt: executionClock.now(),
      lastTool: null,
      tools: 0,
      bufferedProviders: 0,
      deadlines: 0,
      calledAt: null,
      calls: [],
      abort: (error) => stall.abort(error),
    };
    const interval = setInterval(
      () => {
        const limit = silenceLimitMs(settings, request.runId);
        if (
          watch.tools > 0 ||
          watch.bufferedProviders > 0 ||
          executionClock.now() - watch.lastAt < limit
        )
          return;
        stall.abort(
          stalledFault(
            `Attempt ${request.attemptId} of ${request.profile.id} made no progress for ${Math.round((executionClock.now() - watch.lastAt) / 60_000)} min (last tool: ${watch.lastTool ?? "none"}; limit ${Math.round(limit / 60_000)} min${limit < settings.stepStallMs ? ", from the run's own model calls" : ""})`,
          ),
        );
      },
      Math.max(1000, Math.min(30_000, Math.floor(settings.stepStallMs / 4))),
    );
    interval.unref();
    try {
      return await this.runAttempt(
        { ...request, signal: AbortSignal.any([request.signal, stall.signal]) },
        watch,
      );
    } catch (error) {
      if (stall.signal.aborted && !request.signal.aborted) {
        // The edits the stalled call left half-recorded are decided from the files.
        try {
          this.store.transaction(() =>
            settleInterruptedEdits(this.store, request.runId, request.attemptId),
          );
        } catch {
          // A failed settlement leaves the effect for the recovery request.
        }
        throw stall.signal.reason;
      }
      throw error;
    } finally {
      clearInterval(interval);
    }
  }
  private async runAttempt(
    request: ExecutionRequest,
    watch: AttemptWatch,
  ): Promise<ExecutionResponse> {
    // Nothing is spent until the first model step; each finished step raises this record.
    this.store.recordAttemptUsage(request.runId, request.attemptId, 0);
    if (hasToolHooks(this.store.workspace))
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        "Workflow v1 cannot classify command hook effects. Disable project tool hooks for this run.",
      );
    const policy = JSON.parse(this.store.run(request.runId).policy_json) as RunPolicy;
    const root = request.root ?? this.store.workspace;
    const rootPath = rootField(this.store.workspace, root).root ?? "";
    const parent = await this.rootContext.get();
    const context = new ContextManager(root, parent.getSharedResources());
    // Model calls end with the attempt. A provider that keeps a conversation open between steps
    // (Codex app-server threads) releases it when this fires, also after the last step: the
    // thread that ends at `submit_result` would otherwise go on calling the model (#863).
    const modelCalls = new AbortController();
    const stopModelCalls = () => modelCalls.abort(request.signal.reason);
    request.signal.addEventListener("abort", stopModelCalls, { once: true });
    if (request.signal.aborted) stopModelCalls();
    try {
      const provider = await buildProviderOptions(
        request.profile.model,
        withRouteEffort(request.profile.model, this.config, request.effort),
      );
      const webSearch = codeWebSearchFor(policy, request.profile);
      if (webSearch) provider.providerOptions = withCodexWebSearch(provider.providerOptions);
      if (request.freshSession || request.transport)
        provider.providerOptions = withCodexRecovery(provider.providerOptions, request);
      // Only a known window stops the attempt here; for a model nothing names, the 128k default is
      // a guess, and the provider's own rejection of an oversized input is handled by the scheduler.
      const window = knownModelContextWindow(request.profile.model);
      if (
        window !== null &&
        Math.ceil(Buffer.byteLength(request.prompt) / 3) + request.profile.maxOutputTokens >
          window * 0.8
      )
        throw stopFault(
          "context_window",
          `Workflow context exceeds the ${window}-token window of ${request.profile.model}`,
        );
      const writer =
        request.profile.role === "implementer" || request.profile.role === "acceptance-writer";
      const registryTools = buildTools(root, async () => false, {
        contextManager: context,
        repoMap: context.isRepoMapReady() ? context.getRepoMap() : undefined,
        onApproveOutsideCwd: async () => false,
        onApproveDestructive: async () => writer && request.task !== undefined,
      });
      // An attempt with host tools gets those and, from the registry, only read-only tools.
      const rawTools: Record<string, unknown> = request.hostTools
        ? Object.fromEntries(
            Object.entries(registryTools).filter(([name]) => pureWorkflowTools.has(name)),
          )
        : { ...registryTools, ...(await this.mcpTools(request.profile.allowedTools, policy)) };
      const guard = new WorkflowToolPolicy(
        this.store,
        this.leases,
        request.runId,
        request.attemptId,
        request.profile,
        policy,
        request.task,
        root,
        watch.settings,
        (tool) => {
          // Repeated deadlines mean this attempt's tools cannot be used: stop it, do not loop.
          watch.deadlines++;
          if (watch.deadlines >= watch.settings.maxToolTimeouts)
            watch.abort(
              stalledFault(
                `${String(watch.deadlines)} tool calls of attempt ${request.attemptId} hit their deadline (last: ${tool})`,
              ),
            );
        },
        (path, count) => {
          // A file that differs from the run's record stays different however often the agent
          // reads and retries: stop the attempt rather than spend its cap on refusals (#954).
          if (count >= MAX_HASH_REFUSALS)
            watch.abort(
              new WorkflowFault(
                "INPUT_CHANGED",
                recoveryAdvice(
                  `Edits to ${path} were refused ${String(count)} times in attempt ${request.attemptId}: File changed outside this attempt. Keep the file as it is with \`baked workflow resume ${request.runId} --accept-workspace\`, or put back the content the run wrote and resume`,
                  `Edits to ${path} were refused ${count} times because the file changed outside this attempt. Keep these changes, or restore the content the run wrote before retrying.`,
                  { action: "accept-workspace", runId: request.runId },
                ),
                {
                  path,
                  refusals: count,
                  root: rootPath,
                  hash: fileHash(workspacePath(root, path)),
                },
              ),
            );
        },
      );
      const available: ToolSet = {};
      // Syntax error count of each file before this attempt's first edit of it (#977): an edit is
      // blamed only for errors the file did not already have, such as syntax the grammar predates.
      const syntaxBefore = new Map<string, Promise<number>>();
      // Reads off the event loop (#1533): a read a scanner holds waits without stopping the timers.
      const noteSyntaxBaseline = async (name: string, args: Record<string, unknown>) => {
        if (!["edit_file", "multi_edit"].includes(name) || typeof args.path !== "string") return;
        let path: string;
        try {
          path = guard.path(args.path);
        } catch {
          return;
        }
        if (syntaxBefore.has(path) || !syntaxCheckable(path)) return;
        let content: string | null = null;
        // Set first, so an edit of the same path in parallel keeps this baseline.
        let read: (count: Promise<number>) => void = () => {};
        syntaxBefore.set(path, new Promise<number>((resolve) => (read = (n) => resolve(n))));
        try {
          content = await readFile(workspacePath(root, path), "utf8");
        } catch {
          // A new file has no errors of its own yet.
        }
        read(
          content === null
            ? Promise.resolve(0)
            : syntaxErrors(path, content).then((errors) => errors.length),
        );
      };
      // Files the attempt's last edit of each left unparsable, for the watcher's steering (#1835).
      const broken = new Map<string, string[]>();
      /** `path:line:column: message` for each syntax error the attempt's edits left in `path`. */
      const syntaxRegressions = async (path: string): Promise<string[]> => {
        if (!syntaxCheckable(path)) return [];
        let content: string;
        try {
          content = await readFile(workspacePath(root, path), "utf8");
        } catch {
          return [];
        }
        const errors = await syntaxErrors(path, content);
        if (!errors.length) return [];
        const before = await (syntaxBefore.get(path) ?? Promise.resolve(0));
        return errors.length > before ? formatSyntaxErrors(path, errors) : [];
      };
      // Which code intelligence backend (and language server) answered each tool, for usage.
      const backends = new Map<string, ToolBackendCount>();
      // Reads of the attempt before its first edit, by file and span, with the file's hash (#1360).
      const earlierReads = new Map<string, { hash: string | null; read: number; call?: number }>();
      let readCalls = 0;
      // Tool calls of the attempt so far; history compaction keeps only the newest results.
      let toolCalls = 0;
      let edited = false;
      // Files the attempt's edit tools named, for the tests-written check it requests (#1421).
      const editedPaths = new Set<string>();
      // Whether an edit added doubled backslash escapes, for the hint of a failed check (#1516).
      let doubledEscapes = false;
      // A tool call is progress while it runs (it has its own deadline); the last one names a stall.
      const track = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
        // The model call of this step was silent until it asked for its first tool.
        if (watch.calledAt !== null) {
          recordModelSilence(request.runId, executionClock.now() - watch.calledAt);
          watch.calledAt = null;
        }
        watch.tools++;
        toolCalls++;
        watch.lastTool = name;
        watch.lastAt = executionClock.now();
        try {
          return await call();
        } finally {
          watch.tools--;
          watch.lastAt = executionClock.now();
          touchProgress(request.runId);
        }
      };
      for (const [name, definition] of Object.entries(rawTools)) {
        if (
          !toolListAllows(request.profile.allowedTools, name) ||
          !toolListAllows(policy.allowedTools, name)
        )
          continue;
        const original = definition as Tool;
        if (!original.execute) continue;
        const execute = original.execute;
        const mcp = isMcpToolName(name);
        available[name] = deriveTool(original, {
          ...(typeof original.description === "string"
            ? { description: withoutAstEditHint(original.description) }
            : {}),
          execute: async (input, options) =>
            track(name, async () => {
              const args = input as Record<string, unknown>;
              const normalized = { ...args };
              for (const key of ["path", "file", "from", "to"])
                if (!mcp && typeof args[key] === "string")
                  normalized[key] = workspacePath(root, guard.path(args[key]));
              if (!mcp && Array.isArray(args.files))
                normalized.files = args.files.map((f: unknown) =>
                  typeof f === "string"
                    ? workspacePath(root, guard.path(f))
                    : f && typeof f === "object" && "path" in f && typeof f.path === "string"
                      ? { ...f, path: workspacePath(root, guard.path(f.path)) }
                      : f,
                );
              const editMode = policy.editDiagnostics ?? "feedback";
              await noteSyntaxBaseline(name, args);
              let result = await withEditDiagnosticsMode(editMode, () =>
                guard.execute(name, args, async () => {
                  if (EDIT_TOOLS.has(name)) {
                    edited = true;
                    if (addsDoubledEscapes(args)) doubledEscapes = true;
                    if (!mcp)
                      for (const path of editedPathsOf(args)) editedPaths.add(guard.path(path));
                  }
                  if (name !== "read" || !Array.isArray(normalized.files))
                    return execute(normalized, options);
                  const { files: asked, unchanged } = unchangedRereads(
                    normalized.files,
                    earlierReads,
                    ++readCalls,
                    edited,
                    {
                      fresh: normalized.fresh === true,
                      mayEdit: Object.keys(available).some((tool) => EDIT_TOOLS.has(tool)),
                      call: toolCalls,
                    },
                  );
                  if (!asked.length) return { success: true, output: unchanged.join("\n") };
                  const { files, outlines } = await outlineLargeReads(
                    asked,
                    (request.task?.writes ?? []).map((w) => workspacePath(root, w.path)),
                  );
                  // The read tool refuses a fourth range read of a file as "already in your
                  // context"; after an outline the agent reads several spans of one file.
                  const fresh = files.length > 0 && files.every(isTargetedRead);
                  const input = { ...normalized, files, ...(fresh ? { fresh: true } : {}) };
                  if (outlines.length === 0 && unchanged.length === 0)
                    return execute(input, options);
                  const read = files.length
                    ? ((await execute(input, options)) as { output?: unknown })
                    : null;
                  const output = [
                    ...unchanged,
                    typeof read?.output === "string" ? read.output : "",
                    ...outlines,
                  ]
                    .filter(Boolean)
                    .join("\n\n");
                  return { ...(read ?? {}), success: true, output };
                }),
              );
              // A worktree's own edits are not in the project's index.
              if (rootPath && indexTools.has(name))
                result = markStaleIndexResult(
                  result,
                  writtenInRoot(this.store.effects(request.runId), rootPath),
                );
              const answered = result as { backend?: unknown; server?: unknown } | null;
              if (answered && typeof answered.backend === "string") {
                const server = typeof answered.server === "string" ? answered.server : null;
                const key = JSON.stringify([name, answered.backend, server]);
                const count = backends.get(key) ?? {
                  tool: name,
                  backend: answered.backend,
                  server,
                  calls: 0,
                };
                count.calls++;
                backends.set(key, count);
              }
              if (["edit_file", "multi_edit"].includes(name) && typeof args.path === "string") {
                const path = guard.path(args.path);
                result = await withSyntaxNote(result, async () => {
                  const errors = await syntaxRegressions(path);
                  if (errors.length) broken.set(path, errors);
                  else broken.delete(path);
                  return errors;
                });
              }
              if (!["edit_file", "multi_edit"].includes(name)) {
                const files = await sourceManifest(root, generatedPaths(policy), request.signal);
                const evidenceId = this.store.transaction(() => {
                  const snapshot = this.store.putSnapshot(request.runId, files);
                  const artifact = this.store.artifact(
                    request.runId,
                    "read",
                    `reads/${request.attemptId}/${crypto.randomUUID()}.json`,
                    canonical(JSON.parse(JSON.stringify({ tool: name, input, result }))),
                  );
                  return this.store.addEvidence(
                    request.runId,
                    "read",
                    snapshot.id,
                    artifact.id,
                    request.attemptId,
                  );
                });
                return { result, evidenceId };
              }
              return result;
            }),
        });
      }
      for (const [name, host] of Object.entries(request.hostTools ?? {})) {
        // Host tools are bounded by the gate's grants, not by the policy's tool list.
        if (!request.profile.allowedTools.includes(name)) continue;
        available[name] = tool({
          description: host.description,
          inputSchema: host.inputSchema,
          // Journaled like every other tool call, so a reviewer's repros and an acceptance agent's
          // commands show up in `tool.started`/`tool.finished` and can be attributed.
          execute: async (input: unknown) =>
            track(name, () => guard.host(name, () => host.execute(input))),
        });
      }
      if (
        !request.hostTools &&
        request.profile.allowedTools.includes("delete_file") &&
        policy.allowedTools.includes("delete_file")
      ) {
        available.delete_file = tool({
          description:
            "Delete a file explicitly declared with action=delete in the approved task. expectedHash is optional: pass the `hash:` footer `read` printed for the file (or its SHA-256) to refuse the delete when the file changed since that read. Without it the delete is still refused when the file changed outside this attempt.",
          inputSchema: z
            .object({
              path: z.string(),
              expectedHash: z
                .string()
                .regex(/^[a-f0-9]{1,64}$/)
                .optional(),
            })
            .strict(),
          execute: async (args) =>
            guard.execute("delete_file", args, async () => {
              const path = workspacePath(root, guard.path(args.path));
              if (!existsSync(path))
                throw new WorkflowFault("INPUT_CHANGED", `Delete target is missing: ${args.path}`);
              if (args.expectedHash !== undefined && !deleteHashMatches(path, args.expectedHash))
                throw new WorkflowFault(
                  "INPUT_CHANGED",
                  `Delete target changed: ${args.path} no longer has hash ${args.expectedHash}. Read it again and pass the new hash.`,
                );
              const content = canonical({
                encoding: "base64",
                content: readFileSync(path).toString("base64"),
              });
              this.store.transaction(() =>
                this.store.artifact(
                  request.runId,
                  "deleted-source",
                  `deleted/${request.attemptId}/${guard.path(args.path)}`,
                  content,
                ),
              );
              unlinkSync(path);
              return { success: true };
            }),
        });
      }
      if (
        !request.hostTools &&
        request.profile.role === "implementer" &&
        request.profile.allowedTools.includes("request_check") &&
        policy.allowedTools.includes("request_check")
      ) {
        available.request_check = tool({
          description: "Run an approved check by ID and return host evidence.",
          inputSchema: z.object({ checkId: z.string() }).strict(),
          execute: async ({ checkId }) => {
            const task = request.task;
            // The affected-tests check (#634) runs only the tests that reach the task's files.
            // So is the check of the test files the task writes (#1271).
            const affected =
              task && checkId.endsWith("-affected")
                ? affectedTestsFor(root, policy.checks, task.writes).check
                : task && checkId.endsWith("-written")
                  ? writtenTestsCheck(
                      root,
                      policy.checks,
                      requestedWrittenTests(task, request.writtenTests, editedPaths),
                      taskCaseText(task),
                    )
                  : null;
            // A correction whose findings point at no test file and that edited none has no
            // tests-written check, after the attempt either (#1421).
            if (
              task &&
              checkId.endsWith("-written") &&
              !affected &&
              request.writtenTests &&
              writtenTestsCheck(root, policy.checks, task.writes, taskCaseText(task))?.id ===
                checkId
            )
              return {
                checkId,
                status: "deferred",
                note: `${checkId} runs the test files this correction's findings point at and the ones it edits. It points at none and has edited none, so the host runs no ${checkId} after this attempt; the task's other checks and the checks stage still run. Edit a test file of the task to have it run.`,
              };
            const check =
              affected?.id === checkId ? affected : policy.checks.find((c) => c.id === checkId);
            if (!check || (check !== affected && !task?.checkIds.includes(checkId)))
              throw new WorkflowFault("CAPABILITY_DENIED", "Check ID is outside the task scope");
            // A planned task runs before integration, where a whole-unit formatter only reports the
            // other tasks' files; the checks stage formats the integrated change (#842).
            if (task?.origin === "planned" && isWholeUnitFormatter(check))
              return {
                checkId: check.id,
                status: "deferred",
                note: `${check.id} formats the whole project, so it runs in the checks stage after the tasks are integrated, where the host applies its fixer to the files this run writes. It is not run for a single task and is not a failure: do not run it or reformat files by hand for it.`,
              };
            const scope = new ProcessScope();
            try {
              const result = await new CheckRunner(this.store, scope).run(
                request.runId,
                request.attemptId,
                check,
                request.signal,
                root,
              );
              const own =
                result.status === "failed"
                  ? (request.attributeCheck?.(check, result.output) ?? null)
                  : null;
              // The full output stays in the evidence; the model gets a bounded view (#993).
              const hint =
                result.status === "failed" ? escapeHintFor(result.output, doubledEscapes) : null;
              const shown = {
                ...result,
                ...modelCheckOutput(result.output, result.evidenceId),
                ...(hint ? { escapeHint: hint } : {}),
              };
              const owner =
                result.status === "failed" ? request.failureOwner?.(result.output) : undefined;
              const ownershipNote = owner ? failureOwnerNote(owner) : undefined;
              if (!own)
                return {
                  ...shown,
                  ...(owner ? { failureOwner: owner } : {}),
                  ...(ownershipNote ? { note: ownershipNote } : {}),
                };
              return {
                ...shown,
                ...(owner ? { failureOwner: owner } : {}),
                taskErrors: own,
                note: [
                  ownershipNote,
                  `${check.id} analyzes the whole project and runs in the checks stage after the tasks are integrated; in this task's directory it also fails on files other tasks have not written yet. ${own.length ? "Only the errors in taskErrors are in this task's files: fix those and ignore the rest." : "None of its errors is in this task's files, so there is nothing to fix for it here."}`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              };
            } finally {
              await scope.stop();
            }
          },
        });
      }
      const probeable = reproExecutables(policy.checks);
      if (
        !request.hostTools &&
        request.profile.role === "implementer" &&
        request.profile.allowedTools.includes("run_probe") &&
        request.task &&
        (request.task.origin !== "planned" || writesDocumentation(request.task.writes)) &&
        probeable.length > 0
      ) {
        let probes = 0;
        const probe = probeTool(probeable, async (input) => {
          const scope = new ProcessScope();
          const started = executionClock.now();
          try {
            const outcome = await runProbe(scope, input, {
              root,
              executables: probeable,
              generated: generatedPaths(policy),
              signal: request.signal,
              sandbox: runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
            });
            // Each probe is evidence of how the repair went, so it is journaled with the attempt (#454).
            try {
              this.store.transaction(() =>
                this.store.artifact(
                  request.runId,
                  "probe",
                  `attempts/${request.attemptId}/probe-${String(++probes)}.json`,
                  canonical({
                    taskId: request.task?.id ?? null,
                    executable: input.executable,
                    args: input.args,
                    durationMs: executionClock.now() - started,
                    ...outcome,
                  }),
                ),
              );
            } catch {
              // The probe's answer matters more to the attempt than its journal entry.
            }
            return outcome;
          } finally {
            await scope.stop();
          }
        });
        available.run_probe = tool({
          description: probe.description,
          inputSchema: probe.inputSchema,
          // Under the tool policy, so the call has a deadline and `tool.started`/`tool.finished`.
          execute: async (input: unknown) => guard.host("run_probe", () => probe.execute(input)),
        });
      }
      // A correction runs the repros of its findings itself, the way the host checks them at
      // submit (#1283): ecfit 25614519 T029 spent 4.08M tokens on a reviewer's `go -C {files} run .`
      // program that run_probe could not start, learning each verdict only from a refused submit.
      const reproCheck = request.reproCheck;
      if (
        !request.hostTools &&
        reproCheck &&
        request.profile.role === "implementer" &&
        request.profile.allowedTools.includes("run_probe")
      ) {
        let runs = 0;
        available.run_repro = tool({
          description: `Run the repro of each finding this task corrects, exactly as the host runs it before it accepts submit_result: the reviewer's program, arguments, input files and stdin, on the files as they are now. Returns the findings that still show the reported behavior, with the program's output, or none when the fix holds. Use it after editing instead of guessing what the host will see. At most ${PROBE_TRIES} runs.`,
          inputSchema: z.object({}).strict(),
          execute: async () =>
            guard.host("run_repro", async () => {
              if (++runs > PROBE_TRIES)
                return {
                  status: "refused",
                  reason: `Only ${PROBE_TRIES} repro runs are allowed per attempt`,
                };
              const live = await reproCheck(root, request.signal);
              return live.length
                ? { status: "reproduced", findings: live }
                : { status: "fixed", findings: [] };
            }),
        });
      }
      // A source task replays the audited rows of its criteria on its own code (#1617), the way
      // the host replays them before it accepts submit_result.
      const rowReplay = request.rowReplay;
      let replayHarness: string | null = null;
      let lastReplay: { result: ReplayResult; edits: number } | null = null;
      const attemptEdits = () =>
        this.store
          .effects(request.runId)
          .filter((e) => e.attempt_id === request.attemptId && e.kind === "file_patch").length;
      const replay = async (harness: string): Promise<ReplayResult> => {
        if (!rowReplay) throw new WorkflowFault("CAPABILITY_DENIED", "No rows to replay");
        replayHarness = harness;
        const edits = attemptEdits();
        const result = await rowReplay.run(root, harness, request.signal);
        lastReplay = { result, edits };
        return result;
      };
      if (!request.hostTools && rowReplay && request.profile.role === "implementer") {
        let runs = 0;
        available.replay_rows = tool({
          description: `Replay the audited rows of ${rowReplay.replay.criteria.join(", ")} on the code as it is now: harness is the whole source of ${rowReplay.replay.file.path}, which defines the function the rows block calls. The host appends the block, runs the file with the project's test command, removes it, and returns the rows that fail with their output. At most ${PROBE_TRIES} runs.`,
          inputSchema: z
            .object({
              harness: z
                .string()
                .min(1)
                .max(64 * 1024),
            })
            .strict(),
          execute: async ({ harness }: { harness: string }) =>
            guard.host("replay_rows", async () => {
              if (++runs > PROBE_TRIES)
                return {
                  status: "refused",
                  reason: `Only ${PROBE_TRIES} row replays are allowed per attempt`,
                };
              return replay(harness);
            }),
        });
      }
      const fixable = policy.checks.filter((c) => c.fix);
      if (
        !request.hostTools &&
        request.profile.role === "implementer" &&
        request.profile.allowedTools.includes("edit_file") &&
        policy.allowedTools.includes("edit_file") &&
        fixable.length > 0
      ) {
        const task = request.task;
        available.apply_fix = tool({
          description: `Run the automatic fixer of a check (${fixable.map((c) => c.id).join(", ")}) on each file this task writes, then run the check and return its result. Use it first for lint or format findings the fixer can resolve, then edit by hand only what remains.`,
          inputSchema: z.object({ checkId: z.string() }).strict(),
          execute: async ({ checkId }) => {
            const check = fixable.find((c) => c.id === checkId);
            if (!check?.fix || !task)
              throw new WorkflowFault("CAPABILITY_DENIED", `Check ${checkId} has no fixer`);
            const tiers = fixerTiers(check);
            const exists = (path: string) => !!fileHash(workspacePath(root, path));
            const paths = task.writes
              .filter((w) => w.action !== "delete" && exists(w.path))
              .map((w) => w.path);
            // A whole-unit formatter reads only source code; README and LICENSE give it nothing to do.
            const codePaths = writtenCodePaths(task).filter(exists);
            const generated = generatedPaths(policy);
            const before = await sourceManifest(root, generated, request.signal);
            const kept = keepOutside(root, before, new Set(paths));
            const scope = new ProcessScope();
            // Unsignalled, so the put-back also runs after the call was aborted.
            const changedOutside = async () =>
              changedPaths(before, await sourceManifest(root, generated)).filter(
                (p) => !paths.includes(p),
              );
            let reverted: string[] = [];
            try {
              const outputs: string[] = [];
              const runFixer = async (
                command: { executable: string; args: string[] },
                targets: string[],
              ) => {
                const executable =
                  command.executable === "bun" ? process.execPath : command.executable;
                const once = () =>
                  executeCheckCommand(scope, executable, command.args, {
                    cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
                    env: buildCheckEnv(check),
                    timeoutMs: check.timeoutMs,
                    signal: request.signal,
                    sandbox: runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
                  });
                // A directory argument or wrapper can make any fixer rewrite sibling task files.
                // Capture every pre-image before running it, as for a whole-unit formatter, so
                // later edits and resume recognize those changes as this attempt's own (#1593).
                // Distinct paths avoid nesting a guard inside its own serialized path queue.
                return [...new Set(paths)].reduceRight<() => Promise<unknown>>(
                  (inner, path) => () => guard.execute("edit_file", { path }, inner),
                  async () => {
                    const result = await once();
                    outputs.push(`${targets.join(", ")}: exit ${String(result.exitCode)}`);
                  },
                )();
              };
              try {
                for (const fix of tiers) {
                  if (isWholeUnitFixer(fix)) {
                    if (!codePaths.length) continue;
                    await runFixer(
                      wholeUnitFixerCommand(
                        fix,
                        codePaths.map((path) => cwdPath(check, path)),
                      ),
                      codePaths,
                    );
                    continue;
                  }
                  // The fixer runs in the check's cwd, so it names the file from there.
                  for (const path of paths)
                    await runFixer(fixerCommand(fix, cwdPath(check, path)), [path]);
                }
              } finally {
                // Also when a run throws: a whole-crate formatter may already have rewritten
                // sibling files (bench round 13, mdrefs T010: five files left reformatted).
                reverted = await changedOutside();
                restoreOutside(root, kept, reverted);
              }
              const outside = await changedOutside();
              if (outside.length)
                throw new WorkflowFault(
                  "CAPABILITY_DENIED",
                  `The ${check.id} fixer changed files outside the task: ${outside.join(", ")}`,
                );
              const checked = await new CheckRunner(this.store, scope).run(
                request.runId,
                request.attemptId,
                check,
                request.signal,
                root,
              );
              return {
                fixed: outputs,
                check: { ...checked, ...modelCheckOutput(checked.output, checked.evidenceId) },
                ...(reverted.length
                  ? {
                      reverted,
                      note: "The fixer also rewrote these files of other tasks; they were put back as they were.",
                    }
                  : {}),
              };
            } finally {
              await scope.stop();
            }
          },
        });
      }
      // A file the task's edits left unparsable goes back to its last version that parsed (#1835).
      if (
        !request.hostTools &&
        policy.restoreFile === "on" &&
        request.profile.role === "implementer" &&
        request.profile.allowedTools.includes("edit_file") &&
        policy.allowedTools.includes("edit_file")
      ) {
        available.restore_file = tool({
          description:
            "Put back a file your edits left not parsing, to its last version from this task that parsed, when a repair of the syntax error does not hold. The edits after that version are undone; make them again with edit_file.",
          inputSchema: z.object({ path: z.string() }).strict(),
          execute: async ({ path: raw }: { path: string }) =>
            track("restore_file", async () => {
              const path = guard.path(raw);
              if (!syntaxCheckable(path))
                return {
                  success: false,
                  output: `The syntax check does not read ${path}, so restore_file cannot tell which version of it parsed. Fix it with edit_file.`,
                };
              const errors = await syntaxRegressions(path);
              if (!errors.length)
                return {
                  success: false,
                  output: `${path} parses; restore_file puts back only a file your edits left not parsing. Edit it instead.`,
                };
              const version = await restorableVersion(this.store, {
                runId: request.runId,
                root: rootField(this.store.workspace, root).root ?? "",
                path,
                taskId: request.task?.id ?? null,
                attemptId: request.attemptId,
              });
              if ("reason" in version) return { success: false, output: version.reason };
              await guard.execute("edit_file", { path }, async () =>
                writeFileSync(workspacePath(root, path), version.content),
              );
              broken.delete(path);
              return {
                success: true,
                output: `Restored ${path} to its last version that parsed; ${version.editsUndone} edit${version.editsUndone === 1 ? " was" : "s were"} undone. Read the lines you change and make the change again, writing each quote and backslash once.`,
              };
            }),
        });
      }
      const resultSchema = outputSchemas[request.profile.output];
      if (!resultSchema) throw new WorkflowFault("OUTPUT_INVALID", "Unknown profile output schema");
      const schema = withHostConstants(request.profile.output, resultSchema);
      let submitted: unknown;
      let lastRefusal: { accepted: false; errors: string[]; instruction: string } | undefined;
      const refuse = (errors: string[], instruction: string) => {
        lastRefusal = { accepted: false, errors, instruction };
        return lastRefusal;
      };
      let rejected = 0;
      let invalidSubmissions = 0;
      // A submission the result schema refuses never reaches submit_result's execute; it is kept
      // as evidence that the call was refused, as a rejected one is, on every path that offers
      // submit_result (#1871).
      const keepInvalidSubmissions = (
        content: readonly { type: string; toolName?: string; error?: unknown; input?: unknown }[],
      ) => {
        for (const part of content)
          if (part.type === "tool-error" && part.toolName === "submit_result") {
            invalidSubmissions++;
            const error = part.error instanceof Error ? part.error.message : String(part.error);
            this.store.transaction(() =>
              this.store.artifact(
                request.runId,
                "diagnostic",
                `attempts/${request.attemptId}/invalid-${String(invalidSubmissions)}.json`,
                canonical({ error: error.slice(0, 20_000), submitted: part.input ?? null }),
              ),
            );
          }
      };
      let taskEndChecked = false;
      let editsNoted = false;
      let syntaxRefusals = 0;
      let lastSyntaxRefusal = "";
      let caseRefusals = 0;
      let lastCaseRefusal = "";
      let reproRefusals = 0;
      let replayRefusals = 0;
      let lastReplayRefusal = "";
      const submitResult = tool({
        description:
          "Submit the final typed result. Evidence IDs must come from the host context or tools.",
        inputSchema: schema,
        execute: async (value) => {
          const parsed = schema.parse(value);
          const errors = [...(request.validate?.(parsed) ?? [])];
          if (findAccountIdentity(canonical(parsed), foreignAccountIdentities(root)))
            errors.push(accountIdentityMessage("The result"));
          // After the bounded corrections the scheduler rejects the result with these errors.
          if (errors.length && rejected < MAX_SEMANTIC_CORRECTIONS) {
            rejected++;
            // The payload is the evidence when the attempt later ends without an accepted result.
            this.store.transaction(() =>
              this.store.artifact(
                request.runId,
                "diagnostic",
                `attempts/${request.attemptId}/rejected-${String(rejected)}.json`,
                canonical({ errors, submitted: parsed }),
              ),
            );
            return refuse(
              errors,
              "The result was not accepted. Fix every listed problem and call submit_result again with the complete corrected result.",
            );
          }
          // An agent that hit a refusal outside BAKED's tools (Codex's own read-only sandbox) can
          // report a blocked task with "no changes were made" after BAKED applied its edits (#846).
          const outcome = (parsed as { outcome?: unknown }).outcome;
          if (
            !errors.length &&
            !editsNoted &&
            request.task &&
            (outcome === "blocked" || outcome === "failed")
          ) {
            editsNoted = true;
            const written = appliedPaths(this.store.effects(request.runId), request.attemptId);
            if (written.length)
              return refuse(
                [
                  `This attempt applied edits to ${written.join(", ")} with BAKED's edit tools; they are in the workspace. Only edit_file, multi_edit and delete_file change files, and no sandbox setting refuses them.`,
                ],
                "Check the files as they are now. If the task is done, submit outcome implemented; if something is still missing, finish it with BAKED's edit tools or submit blocked naming what remains, not that no changes were made. The next submission is accepted.",
              );
          }
          // A file this attempt wrote that does not parse is refused here, in the attempt that
          // broke it, not found by a whole-unit check after another task (#977). The same errors
          // submitted again pass: the grammar may predate valid syntax the file uses.
          if (!errors.length && request.task && outcome === "implemented") {
            const written = appliedPaths(this.store.effects(request.runId), request.attemptId);
            const broken = (await Promise.all(written.map(syntaxRegressions))).flat();
            const key = broken.join("\n");
            if (broken.length) {
              const shouldRefuse =
                syntaxRefusals < MAX_SYNTAX_REFUSALS && key !== lastSyntaxRefusal;
              if (shouldRefuse) {
                syntaxRefusals++;
                lastSyntaxRefusal = key;
              }
              this.store.transaction(() =>
                this.store.artifact(
                  request.runId,
                  "diagnostic",
                  `attempts/${request.attemptId}/syntax-${crypto.randomUUID()}.json`,
                  canonical({ accepted: !shouldRefuse, errors: broken }),
                ),
              );
              if (shouldRefuse)
                return refuse(
                  broken.map((line) => `Syntax error: ${line}`),
                  "These files written by this task do not parse. Fix each listed line, then call submit_result again with the complete result. If the code is valid and only newer than the syntax checker, submit again unchanged: the same errors are not refused twice.",
                );
            }
          }
          // A case the criteria quote that the task's tests leave out goes back here, not to a
          // review finding and a corrective task after integration (leaguetab, cochange-update).
          if (
            !errors.length &&
            request.caseCheck &&
            caseRefusals < MAX_CASE_REFUSALS &&
            outcome === "implemented"
          ) {
            const missing = await request.caseCheck(root);
            const key = missing.join("\n");
            if (missing.length && key !== lastCaseRefusal) {
              caseRefusals++;
              lastCaseRefusal = key;
              this.store.transaction(() =>
                this.store.artifact(
                  request.runId,
                  "diagnostic",
                  `attempts/${request.attemptId}/cases-${crypto.randomUUID()}.json`,
                  canonical({ missing }),
                ),
              );
              return refuse(
                missing,
                "The criteria this task covers quote these cases, and the test files it writes do not contain them. Add a test for each one that checks the exact expected output and exit code, then call submit_result again with the complete result. If a case is already tested in another spelling, submit again unchanged: the same list is not refused twice.",
              );
            }
          }
          // A source defect an audited row names goes back to this task, not to a test task
          // that cannot edit the source and a corrective after it (#1617).
          if (
            !errors.length &&
            rowReplay &&
            replayRefusals < MAX_REPLAY_REFUSALS &&
            outcome === "implemented"
          ) {
            const result =
              replayHarness === null
                ? null
                : lastReplay && lastReplay.edits === attemptEdits()
                  ? lastReplay.result
                  : await replay(replayHarness);
            const problems = replayProblems(rowReplay.replay, result);
            const key = problems.join("\n");
            if (problems.length && key !== lastReplayRefusal) {
              replayRefusals++;
              lastReplayRefusal = key;
              return refuse(
                problems,
                "The host replays the audited rows of the criteria this task implements on its code before it accepts the task. Fix the code this task writes so each listed row gives its expected value (the rows are audited spec values: do not change them), confirm with replay_rows, then call submit_result again with the complete result. If the rows call code a later task writes, or the replay cannot run in this project yet, submit again unchanged: the same list is not refused twice.",
              );
            }
          }
          if (
            !errors.length &&
            request.taskEndCheck &&
            !taskEndChecked &&
            (parsed as { outcome?: unknown }).outcome === "implemented"
          ) {
            taskEndChecked = true;
            const typeErrors = await request.taskEndCheck(root, request.signal);
            if (typeErrors.length)
              return refuse(
                typeErrors,
                "The project's type check reports these errors in the files this task writes. Fix them, then call submit_result again with the complete result. This check runs once; the next submission is accepted.",
              );
          }
          // A correction that reports its finding fixed while the finding's repro still shows it
          // goes back here, not to another repair round (stmtsplit-update T007 and T008 ended
          // already_satisfied twice for 546k tokens with the defect still there).
          if (
            !errors.length &&
            request.reproCheck &&
            reproRefusals < MAX_REPRO_REFUSALS &&
            (outcome === "implemented" || outcome === "already_satisfied")
          ) {
            const live = await request.reproCheck(root, request.signal);
            if (live.length) {
              reproRefusals++;
              return refuse(
                live,
                "The host ran the repro of each finding this task corrects on the files as they are now, and these still show the reported behavior, so the task is not done. Fix the cause with BAKED's edit tools, confirm with run_repro that no finding reproduces, then call submit_result again with the complete result. If the fix needs a file outside this task's write scope, submit blocked and name that file in unresolved.",
              );
            }
          }
          submitted = parsed;
          return { accepted: true };
        },
      });
      available.submit_result = submitResult;
      for (const alias of ["submit_artifact", "submit_review"])
        if (request.profile.allowedTools.includes(alias) && policy.allowedTools.includes(alias))
          available[alias] = submitResult;
      const submitTools = ["submit_result", "submit_artifact", "submit_review"].filter(
        (name) => name in available,
      );
      // Sizing supplies each test slice's own price, including its literal cases. Preserve that
      // cap instead of falling back to the policy's smaller generic attempt cap.
      const attemptCap = Math.min(
        request.maxTokens ?? Number.POSITIVE_INFINITY,
        request.attemptTokens ?? policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS,
      );
      // An attempt starts only while the run's forecast fits its dollar cap, or the person chose
      // to go on, and while the run budget, grown if it may, still covers its cap.
      assertForecastFits(this.store, request.runId, policy);
      assertAttemptFits(this.store, request.runId, request.attemptId, policy, attemptCap);
      // The run budget still free bounds every token of the attempt, so an attempt started close
      // to the run limit finalizes and submits instead of failing on the run cap mid-loop.
      const remaining = this.store.remainingTokens(request.runId, policy, request.attemptId);
      const elsewhere = policy.maxTotalTokens - remaining;
      const budget = new AttemptStepController({
        maxSteps: request.maxSteps,
        // The cap leaves cache reads out (#1070); the ceiling, the run's free budget, counts them.
        maxTokens: Math.min(attemptCap, remaining),
        // Token caps come from history on whatever provider produced it; each attempt may still
        // take a minimum number of steps at its own step cost, within what the run allows.
        minSteps: Math.min(request.maxSteps, MIN_ATTEMPT_STEPS),
        ceilingTokens: remaining,
        // What the run committed elsewhere when the attempt started stays committed; the budget
        // grows by what this attempt still needs (#1298).
        growCeiling: (tokens) => {
          growBudgetOnProgress(this.store, request.runId, policy, elsewhere + tokens);
          return this.store.remainingTokens(request.runId, policy, request.attemptId);
        },
        submitTools,
        fallbackStepTokens:
          request.profile.maxOutputTokens + Math.ceil(Buffer.byteLength(request.prompt) / 2),
        maxOutputTokens: request.profile.maxOutputTokens,
        ...(request.profile.compaction ? { compaction: request.profile.compaction } : {}),
        ...(request.profile.role === "implementer" && request.task?.writes.length
          ? { editNudgeAfterReads: EDIT_NUDGE_AFTER_READS }
          : {}),
        watch: {
          mustEdit: request.profile.role === "implementer" && !!request.task?.writes.length,
          editTools: Object.keys(available).filter((name) => EDIT_TOOLS.has(name)),
          ...(available.restore_file
            ? { broken: () => [...broken].map(([path, errors]) => ({ path, errors })) }
            : {}),
          onSignal: (finding, action) =>
            this.store.transaction(() =>
              this.store.emit(request.runId, {
                type: "attempt.advisory",
                payload: {
                  attemptId: request.attemptId,
                  signal: finding.signal,
                  action,
                  detail: finding.detail.slice(0, 500),
                },
              }),
            ),
        },
      });
      const meta = { profileId: request.profile.id, taskId: request.task?.id ?? null };
      const model = this.attemptModel(request, policy, watch);
      const effort = sentEffort(provider.providerOptions);
      const writeUsage = (usage: AttemptUsageRecord) =>
        this.store.transaction(() =>
          this.store.artifact(
            request.runId,
            "usage",
            `attempts/${request.attemptId}/usage.json`,
            canonical({
              ...usage,
              ...(backends.size ? { toolBackends: [...backends.values()] } : {}),
              ...(effort ? { effort } : {}),
              ...(webSearch ? { webSearch } : {}),
              ...(watch.calls.length ? { calls: watch.calls } : {}),
            }),
          ),
        );
      // Usage is persisted as each step finishes, so a loop that throws keeps its real spend.
      const finished: Array<
        StepLike & { toolCalls: readonly { toolName: string; input?: unknown }[] }
      > = [];
      // Usage of the latest model call, which a step rejected for its tool choice never reports.
      let lastCallUsage: LanguageModelUsage | undefined;
      // Each model step of a run also goes to the model events view of this process.
      let stepStartedAt = Date.now();
      let stepExecutionAt = executionClock.now();
      const recordStep = (usage: Partial<LanguageModelUsage> | undefined, failure?: unknown) => {
        recordModelCall({
          modelId: request.profile.model,
          source: "run",
          startedAt: stepStartedAt,
          durationMs: Math.ceil(executionClock.now() - stepExecutionAt),
          state: failure === undefined ? "ok" : "error",
          runId: request.runId,
          agentId: request.profile.id,
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          cacheRead: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
          ...(failure === undefined
            ? {}
            : {
                errorMessage: (failure instanceof Error ? failure.message : String(failure)).slice(
                  0,
                  500,
                ),
              }),
        });
        stepStartedAt = Date.now();
        stepExecutionAt = executionClock.now();
      };
      // A call past the output cap reports no usage: it is charged as a step at its estimate.
      const chargeOutputLimit = (error: unknown): boolean => {
        if (request.signal.aborted || !isOutputLimit(error)) return false;
        const usage = outputLimitUsage(
          budget.lastSentBytes() ?? Buffer.byteLength(request.prompt),
          request.profile.maxOutputTokens,
        );
        finished.push({ usage, finishReason: "length", toolCalls: [] });
        recordStep(usage, error);
        this.store.recordAttemptUsage(request.runId, request.attemptId, budget.consumed(finished));
        return true;
      };
      // A turn whose answer was lost was billed all the same (#1957): the usage it reported, or the
      // messages it was sent when it reported none, is charged as a step, and its evidence kept.
      const chargeLostAnswer = (error: unknown): AttemptUsageRecord["lostAnswer"] | undefined => {
        const lost = request.signal.aborted ? null : lostAnswer(error);
        if (!lost) return undefined;
        const promptBytes = budget.lastSentBytes() ?? Buffer.byteLength(request.prompt);
        const usage = {
          inputTokens: lost.usage?.inputTokens ?? Math.ceil(promptBytes / 4),
          outputTokens: lost.usage?.outputTokens ?? 0,
        };
        finished.push({ usage, finishReason: "error", toolCalls: [] });
        recordStep(usage, error);
        this.store.recordAttemptUsage(request.runId, request.attemptId, budget.consumed(finished));
        return { ...lost.evidence, message: lost.message.slice(0, 500), promptBytes };
      };
      const opening = openingMessage(request.prompt, this.config.cache?.ttl ?? "5m");
      let result: {
        steps: readonly StepLike[];
        text: string;
        usage: Partial<LanguageModelUsage>;
        /** The conversation so far, when the loop ended normally: a continuation resumes it. */
        messages?: ModelMessage[];
      };
      try {
        // Anthropic prompt cache: a breakpoint after the tools and system prompt, and the
        // automatic one after the newest message, so each step re-reads the earlier ones.
        const cacheTtl = this.config.cache?.ttl ?? "5m";
        let messages: ModelMessage[] = [opening];
        for (let recovery = 0; ; recovery++) {
          const earlier = [...finished];
          const generated = await generateText({
            model,
            instructions: {
              role: "system",
              content: request.profile.instructions,
              providerOptions: getEphemeralCache(cacheTtl),
            },
            messages,
            tools: available,
            stopWhen: [
              () => submitted !== undefined,
              isStepCount(request.maxSteps - earlier.length),
              ({ steps: done }) => budget.overBudget([...earlier, ...done]),
            ],
            maxRetries: 0,
            maxOutputTokens: request.profile.maxOutputTokens,
            abortSignal: modelCalls.signal,
            providerOptions: withAutomaticCache(provider.providerOptions, cacheTtl),
            headers: provider.headers,
            onStepEnd: (step) => {
              if (watch.calledAt !== null) {
                recordModelSilence(request.runId, executionClock.now() - watch.calledAt);
                watch.calledAt = null;
              }
              watch.lastAt = executionClock.now();
              touchProgress(request.runId);
              finished.push(step);
              recordStep(step.usage);
              keepInvalidSubmissions(step.content);
              this.store.recordAttemptUsage(
                request.runId,
                request.attemptId,
                budget.consumed(finished),
              );
            },
            prepareStep: ({ stepNumber, steps: done, ...history }) => {
              watch.lastAt = executionClock.now();
              watch.calledAt = executionClock.now();
              request.signal.throwIfAborted();
              // Compaction and the finalize notice are recomputed from the clean history each step.
              const messages = cleanStepMessages(history);
              const steps = [...earlier, ...done];
              const prepared = budget.prepare({
                stepNumber: earlier.length + stepNumber,
                steps,
                messages,
              });
              this.store.expandReservation(
                request.runId,
                request.attemptId,
                budget.reservation(steps, prepared.messages ?? messages),
                policy,
              );
              return prepared;
            },
            onLanguageModelCallEnd: ({ usage }) => {
              lastCallUsage = usage;
            },
          });
          result = {
            steps: finished,
            text: generated.text,
            usage: sumUsage(finished),
            messages: [...messages.slice(1), ...generated.response.messages],
          };
          // A status report after a refusal still needs work. Replay the exact refusal once with
          // all granted tools, in this attempt and within its original step and token limits.
          if (
            recovery > 0 ||
            submitted !== undefined ||
            !lastRefusal ||
            request.signal.aborted ||
            generated.steps.at(-1)?.toolCalls.length !== 0 ||
            generated.steps.at(-1)?.finishReason === "length" ||
            finished.length >= request.maxSteps ||
            budget.overBudget(finished)
          )
            break;
          messages = [
            opening,
            ...(result.messages ?? []),
            {
              role: "user",
              content: `Your submit_result was refused. Continue working on the listed problems before submitting again.\n${canonical(lastRefusal)}`,
            },
          ];
        }
      } catch (error) {
        // A forced submit step answered with text. Keep that text for the format correction
        // below, and record the rejected step's spend, which never reaches onStepEnd.
        if (ToolChoiceViolationError.isInstance(error) && !request.signal.aborted) {
          if (lastCallUsage) {
            finished.push({ usage: lastCallUsage, toolCalls: [] });
            this.store.recordAttemptUsage(
              request.runId,
              request.attemptId,
              budget.consumed(finished),
            );
          }
          result = {
            steps: finished,
            text: error.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            usage: sumUsage(finished),
          };
        } else {
          const charged = chargeOutputLimit(error);
          const lost = charged ? undefined : chargeLostAnswer(error);
          if (!request.signal.aborted && !charged && !lost) recordStep(undefined, error);
          try {
            const usage = budget.record(
              finished,
              false,
              meta,
              request.signal.aborted ? "aborted" : "error",
            );
            const total = sumUsage(finished);
            const estimated =
              charged || (lost && !lostAnswer(error)?.usage)
                ? {
                    estimatedUsage: {
                      inputTokens: total.inputTokens ?? 0,
                      outputTokens: total.outputTokens ?? 0,
                    },
                  }
                : {};
            writeUsage({ ...usage, ...estimated, ...(lost ? { lostAnswer: lost } : {}) });
          } catch {
            // The original failure matters more than a usage record that could not be stored.
          }
          throw error;
        }
      }
      // A response the provider withheld under its usage policy is a refusal, not a prose ending
      // to correct (#1895): the scheduler retries it once and then stops for a reroute.
      if (
        submitted === undefined &&
        !request.signal.aborted &&
        result.steps.at(-1)?.finishReason === "content-filter"
      ) {
        try {
          writeUsage(budget.record(finished, false, meta, "error"));
        } catch {
          // The refusal matters more than a usage record that could not be stored.
        }
        throw new AbnormalFinishError("content-filter");
      }
      // The loop ended on a step without a tool call. Its context is intact, so the model is asked
      // once more to submit in the same conversation, with only the submit tool active, instead of
      // a context-free reformat that has neither the task id nor the evidence handles (R7: keeplint
      // T003, md-site T006, url-shortener T002 and the mouse-mover plan ended on prose).
      let proseEnd = "";
      if (
        submitted === undefined &&
        result.messages &&
        !request.signal.aborted &&
        result.steps.at(-1)?.toolCalls.length === 0 &&
        result.steps.at(-1)?.finishReason !== "length" &&
        !budget.overBudget(result.steps)
      ) {
        proseEnd = result.text;
        try {
          const continued = await generateText({
            model,
            instructions: {
              role: "system",
              content: request.profile.instructions,
              providerOptions: getEphemeralCache(this.config.cache?.ttl ?? "5m"),
            },
            messages: [opening, ...result.messages, { role: "user", content: SUBMIT_NOW_NOTICE }],
            tools: available,
            activeTools: submitTools,
            toolChoice: "required",
            // One more step corrects a submission the stage validators reject.
            stopWhen: [() => submitted !== undefined, isStepCount(2)],
            maxRetries: 0,
            maxOutputTokens: request.profile.maxOutputTokens,
            abortSignal: modelCalls.signal,
            providerOptions: withAutomaticCache(
              provider.providerOptions,
              this.config.cache?.ttl ?? "5m",
            ),
            headers: provider.headers,
            onStepEnd: (step) => {
              finished.push(step);
              recordStep(step.usage);
              keepInvalidSubmissions(step.content);
              this.store.recordAttemptUsage(
                request.runId,
                request.attemptId,
                budget.consumed(finished),
              );
            },
            prepareStep: () => {
              request.signal.throwIfAborted();
              return {};
            },
            onLanguageModelCallEnd: ({ usage: callUsage }) => {
              lastCallUsage = callUsage;
            },
          });
          result = {
            steps: finished,
            text: continued.text || result.text,
            usage: sumUsage(finished),
          };
        } catch (error) {
          // A continuation past the output cap goes back to the scheduler, which retries the step
          // at a lower effort; its estimate is charged to the attempt first.
          if (chargeOutputLimit(error)) throw error;
          if (request.signal.aborted || isTransient(error)) {
            if (!request.signal.aborted) recordStep(undefined, error);
            throw error;
          }
          // A text reply to the forced step or a submission the schema rejects: the format
          // correction below makes the last attempt with whatever text exists.
          if (ToolChoiceViolationError.isInstance(error)) {
            if (lastCallUsage) {
              finished.push({ usage: lastCallUsage, toolCalls: [] });
              this.store.recordAttemptUsage(
                request.runId,
                request.attemptId,
                budget.consumed(finished),
              );
            }
            result = {
              steps: finished,
              text:
                error.content.map((part) => (part.type === "text" ? part.text : "")).join("") ||
                proseEnd,
              usage: sumUsage(finished),
            };
          } else {
            recordStep(undefined, error);
            result = { steps: finished, text: proseEnd, usage: sumUsage(finished) };
          }
        }
      }
      const estimated = reportedNoTokens(result.steps)
        ? estimateUnreportedUsage(request.prompt, result.steps, result.text)
        : undefined;
      const usage = budget.record(result.steps, submitted !== undefined, meta);
      writeUsage(estimated ? { ...usage, estimatedUsage: estimated } : usage);
      if (usage.stopReason === "tokens")
        throw attemptCapFault(
          request.profile.id,
          usage.cappedTokens ?? usage.totalTokens,
          usage.maxTokens,
          {
            totalTokens: usage.totalTokens,
            allTokensCap: budget.allTokensCap(result.steps),
            ...(usage.ceilingTokens !== undefined ? { ceilingTokens: usage.ceilingTokens } : {}),
          },
        );
      // An attempt that had to edit and was finalized by the run's free budget before any edit
      // did not fail its task: the budget stopped it, and an extension lets the task go on
      // instead of the run ending `invalid_output` with its budget unused (#1298).
      const outcome = (submitted as { outcome?: unknown } | undefined)?.outcome;
      if (
        budget.stoppedByCeiling &&
        request.profile.role === "implementer" &&
        request.task?.writes.length &&
        (outcome === "failed" || outcome === "blocked") &&
        !result.steps.some((step) =>
          step.toolCalls.some((call) => EDIT_TOOLS.has(toolCallName(call))),
        )
      )
        throw stopFault(
          "budget_exhausted",
          `Task ${request.task.id} was stopped by the run budget before its first edit`,
          {
            usedTokens: usage.totalTokens,
            remainingTokens: this.store.remainingTokens(request.runId, policy, request.attemptId),
            maxTotalTokens: policy.maxTotalTokens,
          },
        );
      if (submitted === undefined) {
        // Nothing to reformat: a correction pass over empty text would invent a result. The
        // scheduler repeats an attempt that ended at its step cap with more steps.
        if (!result.text.trim())
          throw new WorkflowFault(
            "OUTPUT_INVALID",
            `Profile ${request.profile.id} ended after ${result.steps.length} steps without submitting a result`,
            // A step cap is its own reason: a task that edited continues at it like at the token
            // cap, and a stop names it (#1478).
            usage.stopReason === "steps"
              ? { reason: "step_cap" }
              : usage.stopReason === "no_submission"
                ? { reason: "no_submission" }
                : {},
          );
        try {
          submitted = schema.parse(JSON.parse(result.text));
        } catch {
          // The raw text is the only record of what the model said instead of submitting.
          this.store.transaction(() =>
            this.store.artifact(
              request.runId,
              "diagnostic",
              `attempts/${request.attemptId}/prose-end.json`,
              canonical({ profileId: request.profile.id, text: result.text.slice(0, 64 * 1024) }),
            ),
          );
          const step = this.store
            .attempts(request.runId)
            .find((a) => a.id === request.attemptId)?.step_id;
          if (!step) throw new WorkflowFault("OUTPUT_INVALID", "Result attempt missing");
          const correctionPrompt = `Reformat this previous result using submit_result. Preserve its claims and evidence IDs. Do not implement or verify anything again.${request.formatHints ? `\n${request.formatHints}` : ""}\n${result.text.slice(0, 256 * 1024)}`;
          const attempt = this.store.reserve(
            request.runId,
            step,
            request.profile.model,
            Math.ceil(Buffer.byteLength(correctionPrompt) / 2) +
              request.profile.maxOutputTokens +
              8192,
            policy,
          );
          // Zero until the single correction step reports its usage.
          let correctionTokens = 0;
          try {
            let correctedText = "";
            try {
              const corrected = await generateText({
                model,
                prompt: correctionPrompt,
                tools: { submit_result: submitResult },
                toolChoice: { type: "tool", toolName: "submit_result" },
                stopWhen: isStepCount(1),
                maxRetries: 0,
                maxOutputTokens: request.profile.maxOutputTokens,
                abortSignal: modelCalls.signal,
                providerOptions: provider.providerOptions,
                headers: provider.headers,
                onStepEnd: (step) => keepInvalidSubmissions(step.content),
                // Counted per model call so a response that skips the tool is still charged.
                onLanguageModelCallEnd: ({ usage, content }) => {
                  correctionTokens += stepTokens(usage, request.profile.maxOutputTokens);
                  correctedText = content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("");
                },
              });
              correctedText = corrected.text;
            } catch (error) {
              // A plain-text reply is still parsed as the result, as with AI SDK 6.
              if (!ToolChoiceViolationError.isInstance(error)) throw error;
            }
            if (submitted === undefined && !correctedText.trim())
              throw new WorkflowFault(
                "OUTPUT_INVALID",
                `Profile ${request.profile.id} returned no result from format correction`,
                { reason: "no_submission" },
              );
            submitted = schema.parse(submitted ?? JSON.parse(correctedText));
            this.store.transaction(() =>
              this.store.finishAttempt(request.runId, attempt, "completed", correctionTokens),
            );
          } catch (error) {
            if (isOutputLimit(error) && !request.signal.aborted)
              correctionTokens += stepTokens(
                outputLimitUsage(
                  Buffer.byteLength(request.prompt),
                  request.profile.maxOutputTokens,
                ),
                request.profile.maxOutputTokens,
              );
            this.store.transaction(() =>
              this.store.finishAttempt(
                request.runId,
                attempt,
                request.signal.aborted ? "cancelled" : "failed",
                correctionTokens,
                false,
                error,
              ),
            );
            // A provider outage is not invalid output: the scheduler retries or falls back, and
            // retries a response past the output cap at a lower effort.
            if (isTransient(error) || isOutputLimit(error)) throw error;
            if (error instanceof WorkflowFault && error.details.reason === "no_submission")
              throw error;
            throw new WorkflowFault(
              "OUTPUT_INVALID",
              `Profile ${request.profile.id} returned invalid output after one format correction`,
              { reason: "prose_end", prose: result.text.slice(0, 4000) },
            );
          }
        }
      }
      return {
        output: submitted,
        ...(estimated
          ? { ...estimated, usageComplete: false, usageEstimated: true }
          : {
              inputTokens: result.usage.inputTokens ?? null,
              outputTokens: result.usage.outputTokens ?? null,
            }),
      };
    } finally {
      request.signal.removeEventListener("abort", stopModelCalls);
      modelCalls.abort(new DOMException("The workflow attempt ended.", "AbortError"));
      context.dispose({ preserveSharedIO: true });
    }
  }
  /**
   * MCP tools that both the profile and the run policy grant. Only the servers those grants name
   * are connected; a server that fails to connect contributes no tools.
   */
  /** The recorded calls of the workspace's latest attempts, newest last (#1766). */
  private firstByteHistory(): FirstByteHistory {
    if (this.firstBytes) return this.firstBytes;
    const history = new FirstByteHistory(join(dataDir(), "first-byte-history.json"));
    const rows = this.store.connection
      .query(
        `SELECT a.run_id, a.id, t.model_id FROM artifacts a
         JOIN attempts t ON t.run_id = a.run_id AND a.logical_path = 'attempts/' || t.id || '/usage.json'
         WHERE a.kind = 'usage' AND t.model_id IS NOT NULL AND a.revision =
           (SELECT MAX(b.revision) FROM artifacts b WHERE b.run_id = a.run_id AND b.logical_path = a.logical_path)
         ORDER BY a.created_at DESC LIMIT 200`,
      )
      .all() as { run_id: string; id: string; model_id: string }[];
    for (const row of rows.reverse()) {
      try {
        const usage = JSON.parse(this.store.readArtifact(row.run_id, row.id)) as {
          calls?: CallTiming[];
        };
        for (const call of usage.calls ?? []) history.record(row.model_id, call);
      } catch {
        // An unreadable usage record only leaves its calls out of the history.
      }
    }
    this.firstBytes = history;
    return history;
  }
  /**
   * The attempt's model: the provider's, or with `modelCalls` in the policy one that records
   * each call in the run, or answers from a recording (#856).
   */
  private attemptModel(
    request: ExecutionRequest,
    policy: RunPolicy,
    watch: AttemptWatch,
  ): LanguageModel {
    const calls = policy.modelCalls;
    const model = () => {
      const resolved = resolveModel(request.profile.model);
      const history = this.firstByteHistory();
      const shared = policy.sharedFirstByteHistory === "on";
      return withProviderHealth(resolved, request.profile.model, {
        stage: request.profile.output,
        firstByteLimit: (ceilingMs, call) =>
          history.deadline(ceilingMs, request.profile.model, call, shared),
        timing: (call) => {
          watch.calls.push(call);
          history.record(request.profile.model, call, shared);
        },
        // A call that may reason silently (a CLI adapter, or high effort on a provider whose
        // reasoning does not stream) is not a stall while it waits (#1652).
        pending: (buffered) => {
          if (buffered) watch.bufferedProviders++;
          const settle = request.providerPending?.();
          return (responded) => {
            if (buffered) watch.bufferedProviders--;
            settle?.(responded);
          };
        },
        progress: () => {
          watch.lastAt = executionClock.now();
          touchProgress(request.runId);
        },
      });
    };
    if (!calls?.record && !calls?.replay) return model();
    const key = recordingKey(request.profile.id, request.task?.id);
    const paths = this.store.artifacts(request.runId).map((a) => a.logical_path);
    if (calls.replay && !this.replays.has(calls.replay))
      this.replays.set(calls.replay, readRecording(calls.replay).calls);
    return attemptModel({
      model,
      modelId: request.profile.model,
      key,
      attempt: recordedAttempts(paths, key).length,
      ...(calls.replay ? { replay: this.replays.get(calls.replay) ?? [] } : {}),
      record: (call) =>
        this.store.transaction(() =>
          this.store.artifact(
            request.runId,
            "recording",
            recordingPath(key, request.attemptId, call.call),
            canonical(call),
          ),
        ),
    });
  }
  private async mcpTools(profileTools: readonly string[], policy: RunPolicy): Promise<ToolSet> {
    const servers = grantedMcpServers(
      this.config.mcpServers ?? [],
      profileTools,
      policy.allowedTools,
    );
    if (!servers.length) return {};
    const { getMCPManager } = await import("../mcp/index.js");
    const manager = getMCPManager();
    await manager.ensureConnected(servers);
    return Object.fromEntries(
      Object.entries(manager.getTools()).filter(
        ([name]) => toolListAllows(profileTools, name) && toolListAllows(policy.allowedTools, name),
      ),
    );
  }
  /** Resolves once the owned context has closed its databases, so its directory can be removed. */
  dispose(): Promise<void> {
    return this.ownsRootContext ? this.rootContext.dispose().catch(() => {}) : Promise.resolve();
  }
}

/**
 * The reasoning effort a call sends, whichever provider reads it: `effort` (Anthropic, Claude
 * Code) or `reasoningEffort` (OpenAI, Codex) in its provider options (#936).
 */
/**
 * Whether an attempt may use Codex's own web search: `codeWebSearch` in the run policy, a writing
 * profile (implementer or acceptance-writer) and a Codex model (#1239). Checks, tests and linters
 * run outside the model and keep the policy's network setting.
 */
export function codeWebSearchFor(
  policy: Pick<RunPolicy, "codeWebSearch">,
  profile: { role: string; model: string },
): boolean {
  return (
    policy.codeWebSearch === true &&
    (profile.role === "implementer" || profile.role === "acceptance-writer") &&
    profile.model.startsWith("codex/")
  );
}

/** Provider options with Codex's web search on, read by the Codex adapter (`codexWebSearch`). */
export function withCodexWebSearch(options: ProviderOptions): ProviderOptions {
  return { ...options, codex: { ...options.codex, webSearch: true } };
}

/** The recovery ladder's session and transport rungs, read by the Codex adapter (#1877). */
export function withCodexRecovery(
  options: ProviderOptions,
  request: Pick<ExecutionRequest, "freshSession" | "transport">,
): ProviderOptions {
  return {
    ...options,
    codex: {
      ...options.codex,
      ...(request.freshSession ? { freshThread: true } : {}),
      ...(request.transport ? { transport: request.transport } : {}),
    },
  };
}

export function sentEffort(
  options: Record<string, Record<string, unknown> | undefined> | undefined,
): string | undefined {
  for (const entry of Object.values(options ?? {})) {
    const effort = entry?.effort ?? entry?.reasoningEffort;
    if (typeof effort === "string") return effort;
  }
  return undefined;
}

/**
 * An attempt that used its token cap without submitting. It stops the run with its own reason:
 * the cap is not a run limit, so `workflow extend` cannot help, and a resume continues the task on
 * the edits already in place (#935).
 */
export const attemptCapFault = (
  profileId: string,
  tokens: number,
  cap: number,
  totals: { totalTokens: number; allTokensCap: number; ceilingTokens?: number } = {
    totalTokens: tokens,
    allTokensCap: cap * ALL_TOKENS_FACTOR,
  },
): WorkflowFault => {
  const capKind =
    tokens >= cap
      ? "uncached-token cap"
      : totals.totalTokens >= totals.allTokensCap
        ? "all-token cap"
        : "run-budget ceiling";
  return stopFault(
    "attempt_cap",
    `Profile ${profileId} reached the ${capKind} without submitting a result: uncached tokens ${tokens}/${cap}, total tokens ${totals.totalTokens}/${totals.allTokensCap}${totals.ceilingTokens !== undefined ? `, run-budget ceiling ${totals.ceilingTokens}` : ""}`,
    { capKind, tokens, cap, ...totals },
  );
};

/** Reads an attempt may make before an edit before an unchanged re-read is answered short. */
export const REREADS_BEFORE_STUB = 3;

/**
 * The files of a `read` call that still need reading, and a short answer for each one the attempt
 * already read with the same span while its content stayed the same (#1360). It applies from the
 * attempt's fourth read until its first edit: md-site 4b08acf6 T006 (bench round 35) re-read one
 * 27 KB test file five times in a restarted session that never edited, 805k tokens. `earlier`
 * keeps each read's span, hash and read number.
 */
export function unchangedRereads<T>(
  files: T[],
  earlier: Map<string, { hash: string | null; read: number; call?: number }>,
  read: number,
  edited: boolean,
  options: { fresh?: boolean; mayEdit?: boolean; call?: number } = {},
): { files: T[]; unchanged: string[] } {
  const { fresh = false, mayEdit = true, call } = options;
  const asked: T[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    const spec = (typeof file === "string" ? { path: file } : file) as {
      path?: unknown;
      ranges?: unknown;
      target?: unknown;
      name?: unknown;
      ifHash?: unknown;
    };
    if (typeof spec.path !== "string" || spec.ifHash !== undefined) {
      asked.push(file);
      continue;
    }
    const key = canonical({
      path: spec.path,
      ranges: spec.ranges ?? null,
      target: spec.target ?? null,
      name: spec.name ?? null,
    });
    let hash: string | null = null;
    try {
      hash = fileHash(spec.path);
    } catch {}
    const before = earlier.get(key);
    // The stub points at the earlier output, so it is given only while that output is still in
    // the history: not for a fresh read (the compaction stub asks for one), not once history
    // compaction may have elided it, and not to a role that cannot edit (#1409).
    const inHistory =
      call === undefined ||
      before?.call === undefined ||
      call - before.call <= KEEP_RECENT_TOOL_MESSAGES;
    if (
      !edited &&
      !fresh &&
      mayEdit &&
      inHistory &&
      read > REREADS_BEFORE_STUB &&
      before &&
      hash !== null &&
      before.hash === hash
    ) {
      unchanged.push(
        `[${spec.path} is unchanged since your read #${String(before.read)} in this attempt; its content is in your context above. Apply your edit now.]`,
      );
      continue;
    }
    earlier.set(key, { hash, read, ...(call !== undefined ? { call } : {}) });
    asked.push(file);
  }
  return { files: asked, unchanged };
}

/** The file paths an edit tool call names: `path`, `file`, a rename's `to` and `files`. */
function editedPathsOf(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file", "to"]) {
    const value = args[key];
    if (typeof value === "string") paths.push(value);
  }
  if (Array.isArray(args.files))
    for (const f of args.files) {
      if (typeof f === "string") paths.push(f);
      else if (f && typeof f === "object" && "path" in f && typeof f.path === "string")
        paths.push(f.path);
    }
  return paths;
}

/**
 * The writes whose test files a requested tests-written check runs: the list the host gave the
 * attempt and the test files of the task the attempt has edited so far, which the host's check
 * after the attempt runs too (#1421).
 */
export function requestedWrittenTests(
  task: Task,
  given: Task["writes"] | undefined,
  edited: ReadonlySet<string>,
): Task["writes"] {
  if (!given) return task.writes;
  const extra = task.writes.filter(
    (w) => edited.has(w.path) && !given.some((g) => g.path === w.path),
  );
  return [...given, ...extra];
}
