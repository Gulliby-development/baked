import { readFileSync, unlinkSync } from "node:fs";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type Tool,
  ToolChoiceViolationError,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { cleanStepMessages } from "../agents/stream-options.js";
import { ContextManager } from "../context/manager.js";
import { SharedRootContext } from "../context/shared-root.js";
import { recordModelCall } from "../diagnostics/model-events.js";
import { hasToolHooks } from "../hooks/index.js";
import { resolveModel } from "../llm/provider.js";
import {
  buildProviderOptions,
  getEphemeralCache,
  withAutomaticCache,
  withRouteEffort,
} from "../llm/provider-options.js";
import { runSandbox } from "../security/sandbox.js";
import { canonical } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { buildTools } from "../tools/index.js";
import { deriveTool, withoutAstEditHint } from "../tools/tool-utils.js";
import { buildCheckEnv, CheckRunner, executeCheckCommand } from "../verification/check-runner.js";
import { probeTool, reproExecutables, runProbe } from "../verification/repro.js";
import { changedPaths, sourceManifest } from "../verification/snapshot.js";
import { fixerCommand } from "./check-policy.js";
import { fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { withHostConstants } from "./host-constants.js";
import { InitiativePlanSchema } from "./initiatives/plan.js";
import type { WorkspaceLeases } from "./leases.js";
import { grantedMcpServers, isMcpToolName, toolListAllows } from "./mcp-grants.js";
import { ProcessScope } from "./process-scope.js";
import { isTargetedRead, outlineLargeReads } from "./read-outline.js";
import { settleInterruptedEdits } from "./recovery.js";
import { isTransient } from "./retry.js";
import {
  AnalysisSchema,
  generatedPaths,
  ImplementationSchema,
  PlanSchema,
  RefutationSchema,
  ReportSchema,
  ResearchSchema,
  ReviewSchema,
  type RunPolicy,
  SpecSchema,
} from "./schemas.js";
import { type StallSettings, stalledFault, stallSettings, touchProgress } from "./stall.js";
import {
  AttemptStepController,
  type AttemptUsageRecord,
  DEFAULT_MAX_ATTEMPT_TOKENS,
  MIN_ATTEMPT_STEPS,
  type StepLike,
  stepTokens,
} from "./step-budget.js";
import type { WorkflowStore } from "./store.js";
import { pureWorkflowTools, WorkflowToolPolicy } from "./tool-policy.js";
import type { AgentExecutor, ExecutionRequest, ExecutionResponse } from "./types.js";
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
};
const MAX_SEMANTIC_CORRECTIONS = 2;
/** Read-only steps in a row before an implementer is told to edit. */
const EDIT_NUDGE_AFTER_READS = 4;

/** Input and output tokens over steps; a side stays undefined when no step reported it. */
/** Sent after a step that ended without a tool call, before the one forced submission. */
const SUBMIT_NOW_NOTICE =
  "You ended your turn without calling submit_result. Call submit_result now with the complete result for the work already done. If the task is not finished or something failed, submit outcome blocked (or the matching unfinished state) and list what is unresolved. Do not call any other tool.";

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
  deadlines: number;
  abort(error: Error): void;
}

export class NativeAgentExecutor implements AgentExecutor {
  private readonly rootContext: SharedRootContext;
  private readonly ownsRootContext: boolean;
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
      lastAt: Date.now(),
      lastTool: null,
      tools: 0,
      deadlines: 0,
      abort: (error) => stall.abort(error),
    };
    const interval = setInterval(
      () => {
        if (watch.tools > 0 || Date.now() - watch.lastAt < settings.stepStallMs) return;
        stall.abort(
          stalledFault(
            `Attempt ${request.attemptId} of ${request.profile.id} made no progress for ${Math.round((Date.now() - watch.lastAt) / 60_000)} min (last tool: ${watch.lastTool ?? "none"})`,
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
    const parent = await this.rootContext.get();
    const context = new ContextManager(root, parent.getSharedResources());
    try {
      const provider = await buildProviderOptions(
        request.profile.model,
        withRouteEffort(request.profile.model, this.config, request.effort),
      );
      if (
        provider.contextWindow > 0 &&
        Math.ceil(Buffer.byteLength(request.prompt) / 3) + request.profile.maxOutputTokens >
          provider.contextWindow * 0.8
      )
        throw new WorkflowFault(
          "BUDGET_EXHAUSTED",
          `Workflow context exceeds the window of ${request.profile.model}`,
          { reason: "context_window" },
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
      );
      const available: ToolSet = {};
      // A tool call is progress while it runs (it has its own deadline); the last one names a stall.
      const track = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
        watch.tools++;
        watch.lastTool = name;
        watch.lastAt = Date.now();
        try {
          return await call();
        } finally {
          watch.tools--;
          watch.lastAt = Date.now();
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
              const result = await guard.execute(name, args, async () => {
                if (name !== "read" || !Array.isArray(normalized.files))
                  return execute(normalized, options);
                const { files, outlines } = await outlineLargeReads(
                  normalized.files,
                  (request.task?.writes ?? []).map((w) => workspacePath(root, w.path)),
                );
                // The read tool refuses a fourth range read of a file as "already in your
                // context"; after an outline the agent reads several spans of one file.
                const fresh = files.length > 0 && files.every(isTargetedRead);
                const input = { ...normalized, files, ...(fresh ? { fresh: true } : {}) };
                if (outlines.length === 0) return execute(input, options);
                const read = files.length
                  ? ((await execute(input, options)) as { output?: unknown })
                  : null;
                const output = [typeof read?.output === "string" ? read.output : "", ...outlines]
                  .filter(Boolean)
                  .join("\n\n");
                return { ...(read ?? {}), success: true, output };
              });
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
          execute: async (input: unknown) => host.execute(input),
        });
      }
      if (
        !request.hostTools &&
        request.profile.allowedTools.includes("delete_file") &&
        policy.allowedTools.includes("delete_file")
      ) {
        available.delete_file = tool({
          description:
            "Delete a file explicitly declared with action=delete in the approved task. Requires its current SHA-256 hash.",
          inputSchema: z
            .object({ path: z.string(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict(),
          execute: async (args) =>
            guard.execute("delete_file", args, async () => {
              const path = workspacePath(root, guard.path(args.path));
              if (fileHash(path) !== args.expectedHash)
                throw new WorkflowFault("INPUT_CHANGED", "Delete target changed");
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
            const check = policy.checks.find((c) => c.id === checkId);
            if (!check || !request.task?.checkIds.includes(checkId))
              throw new WorkflowFault("CAPABILITY_DENIED", "Check ID is outside the task scope");
            const scope = new ProcessScope();
            try {
              return await new CheckRunner(this.store, scope).run(
                request.runId,
                request.attemptId,
                check,
                request.signal,
                root,
              );
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
        request.task.origin !== "planned" &&
        probeable.length > 0
      ) {
        const probe = probeTool(probeable, async (input) => {
          const scope = new ProcessScope();
          try {
            return await runProbe(scope, input, {
              root,
              executables: probeable,
              generated: generatedPaths(policy),
              signal: request.signal,
              sandbox: runSandbox(policy, root),
            });
          } finally {
            await scope.stop();
          }
        });
        available.run_probe = tool({
          description: probe.description,
          inputSchema: probe.inputSchema,
          execute: async (input: unknown) => probe.execute(input),
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
            const fix = check.fix;
            const paths = task.writes
              .filter((w) => w.action !== "delete" && fileHash(workspacePath(root, w.path)))
              .map((w) => w.path);
            const generated = generatedPaths(policy);
            const before = await sourceManifest(root, generated, request.signal);
            const scope = new ProcessScope();
            try {
              const outputs: string[] = [];
              // One run per file, each recorded like an edit, so undo and rollback see it.
              for (const path of paths)
                await guard.execute("edit_file", { path }, async () => {
                  const command = fixerCommand(fix, path);
                  const executable =
                    command.executable === "bun" ? process.execPath : command.executable;
                  const result = await executeCheckCommand(scope, executable, command.args, {
                    cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
                    env: buildCheckEnv(check),
                    timeoutMs: check.timeoutMs,
                    signal: request.signal,
                    sandbox: runSandbox(policy, root),
                  });
                  outputs.push(`${path}: exit ${String(result.exitCode)}`);
                });
              const after = await sourceManifest(root, generated, request.signal);
              const outside = changedPaths(before, after).filter((p) => !paths.includes(p));
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
              return { fixed: outputs, check: checked };
            } finally {
              await scope.stop();
            }
          },
        });
      }
      const resultSchema = outputSchemas[request.profile.output];
      if (!resultSchema) throw new WorkflowFault("OUTPUT_INVALID", "Unknown profile output schema");
      const schema = withHostConstants(request.profile.output, resultSchema);
      let submitted: unknown;
      let rejected = 0;
      const submitResult = tool({
        description:
          "Submit the final typed result. Evidence IDs must come from the host context or tools.",
        inputSchema: schema,
        execute: async (value) => {
          const parsed = schema.parse(value);
          const errors = request.validate?.(parsed) ?? [];
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
            return {
              accepted: false,
              errors,
              instruction:
                "The result was not accepted. Fix every listed problem and call submit_result again with the complete corrected result.",
            };
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
      // The attempt cap never exceeds what the run budget still allows, so an attempt started
      // close to the run limit finalizes and submits instead of failing on the run cap mid-loop.
      const remaining = this.store.remainingTokens(request.runId, policy, request.attemptId);
      const budget = new AttemptStepController({
        maxSteps: request.maxSteps,
        maxTokens: Math.min(
          request.maxTokens ?? Number.POSITIVE_INFINITY,
          request.attemptTokens ?? policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS,
          remaining,
        ),
        // Token caps come from history on whatever provider produced it; each attempt may still
        // take a minimum number of steps at its own step cost, within what the run allows.
        minSteps: Math.min(request.maxSteps, MIN_ATTEMPT_STEPS),
        ceilingTokens: remaining,
        submitTools,
        fallbackStepTokens:
          request.profile.maxOutputTokens + Math.ceil(Buffer.byteLength(request.prompt) / 2),
        maxOutputTokens: request.profile.maxOutputTokens,
        ...(request.profile.role === "implementer" && request.task?.writes.length
          ? { editNudgeAfterReads: EDIT_NUDGE_AFTER_READS }
          : {}),
      });
      const meta = { profileId: request.profile.id, taskId: request.task?.id ?? null };
      const writeUsage = (usage: AttemptUsageRecord) =>
        this.store.transaction(() =>
          this.store.artifact(
            request.runId,
            "usage",
            `attempts/${request.attemptId}/usage.json`,
            canonical(usage),
          ),
        );
      // Usage is persisted as each step finishes, so a loop that throws keeps its real spend.
      const finished: StepLike[] = [];
      // Usage of the latest model call, which a step rejected for its tool choice never reports.
      let lastCallUsage: LanguageModelUsage | undefined;
      // Each model step of a run also goes to the model events view of this process.
      let stepStartedAt = Date.now();
      const recordStep = (usage: Partial<LanguageModelUsage> | undefined, failure?: unknown) => {
        recordModelCall({
          modelId: request.profile.model,
          source: "run",
          startedAt: stepStartedAt,
          durationMs: Math.max(0, Date.now() - stepStartedAt),
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
      };
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
        const generated = await generateText({
          model: resolveModel(request.profile.model),
          instructions: {
            role: "system",
            content: request.profile.instructions,
            providerOptions: getEphemeralCache(cacheTtl),
          },
          prompt: request.prompt,
          tools: available,
          stopWhen: [
            () => submitted !== undefined,
            isStepCount(request.maxSteps),
            ({ steps: done }) => budget.overBudget(done),
          ],
          maxRetries: 0,
          maxOutputTokens: request.profile.maxOutputTokens,
          abortSignal: request.signal,
          providerOptions: withAutomaticCache(provider.providerOptions, cacheTtl),
          headers: provider.headers,
          onStepEnd: (step) => {
            watch.lastAt = Date.now();
            touchProgress(request.runId);
            finished.push(step);
            recordStep(step.usage);
            this.store.recordAttemptUsage(
              request.runId,
              request.attemptId,
              budget.consumed(finished),
            );
          },
          prepareStep: ({ stepNumber, steps: done, ...history }) => {
            watch.lastAt = Date.now();
            request.signal.throwIfAborted();
            // Compaction and the finalize notice are recomputed from the clean history each step.
            const messages = cleanStepMessages(history);
            const prepared = budget.prepare({ stepNumber, steps: done, messages });
            this.store.expandReservation(
              request.runId,
              request.attemptId,
              budget.reservation(done, prepared.messages ?? messages),
              policy,
            );
            return prepared;
          },
          onLanguageModelCallEnd: ({ usage }) => {
            lastCallUsage = usage;
          },
        });
        result = {
          steps: generated.steps,
          text: generated.text,
          usage: generated.usage,
          messages: generated.response.messages,
        };
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
          if (!request.signal.aborted) recordStep(undefined, error);
          try {
            writeUsage(
              budget.record(finished, false, meta, request.signal.aborted ? "aborted" : "error"),
            );
          } catch {
            // The original failure matters more than a usage record that could not be stored.
          }
          throw error;
        }
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
            model: resolveModel(request.profile.model),
            instructions: {
              role: "system",
              content: request.profile.instructions,
              providerOptions: getEphemeralCache(this.config.cache?.ttl ?? "5m"),
            },
            messages: [
              { role: "user", content: request.prompt },
              ...result.messages,
              { role: "user", content: SUBMIT_NOW_NOTICE },
            ],
            tools: available,
            activeTools: submitTools,
            toolChoice: "required",
            // One more step corrects a submission the stage validators reject.
            stopWhen: [() => submitted !== undefined, isStepCount(2)],
            maxRetries: 0,
            maxOutputTokens: request.profile.maxOutputTokens,
            abortSignal: request.signal,
            providerOptions: withAutomaticCache(
              provider.providerOptions,
              this.config.cache?.ttl ?? "5m",
            ),
            headers: provider.headers,
            onStepEnd: (step) => {
              finished.push(step);
              recordStep(step.usage);
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
      const usage = budget.record(result.steps, submitted !== undefined, meta);
      writeUsage(usage);
      if (usage.stopReason === "tokens")
        throw new WorkflowFault(
          "BUDGET_EXHAUSTED",
          `Profile ${request.profile.id} used ${String(usage.totalTokens)} tokens without submitting a result (attempt cap ${String(usage.maxTokens)})`,
        );
      if (submitted === undefined) {
        // Nothing to reformat: a correction pass over empty text would invent a result. The
        // scheduler repeats an attempt that ended at its step cap with more steps.
        if (!result.text.trim())
          throw new WorkflowFault(
            "OUTPUT_INVALID",
            `Profile ${request.profile.id} ended after ${result.steps.length} steps without submitting a result`,
            usage.stopReason === "steps" || usage.stopReason === "no_submission"
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
                model: resolveModel(request.profile.model),
                prompt: correctionPrompt,
                tools: { submit_result: submitResult },
                toolChoice: { type: "tool", toolName: "submit_result" },
                stopWhen: isStepCount(1),
                maxRetries: 0,
                maxOutputTokens: request.profile.maxOutputTokens,
                abortSignal: request.signal,
                providerOptions: provider.providerOptions,
                headers: provider.headers,
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
            submitted = schema.parse(submitted ?? JSON.parse(correctedText));
            this.store.transaction(() =>
              this.store.finishAttempt(request.runId, attempt, "completed", correctionTokens),
            );
          } catch (error) {
            this.store.transaction(() =>
              this.store.finishAttempt(
                request.runId,
                attempt,
                request.signal.aborted ? "cancelled" : "failed",
                correctionTokens,
              ),
            );
            // A provider outage is not invalid output: the scheduler retries or falls back.
            if (isTransient(error)) throw error;
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
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      };
    } finally {
      context.dispose({ preserveSharedIO: true });
    }
  }
  /**
   * MCP tools that both the profile and the run policy grant. Only the servers those grants name
   * are connected; a server that fails to connect contributes no tools.
   */
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
