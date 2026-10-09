import { readFileSync, unlinkSync } from "node:fs";
import { generateText, stepCountIs, type Tool, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { ContextManager } from "../context/manager.js";
import { hasToolHooks } from "../hooks/index.js";
import { resolveModel } from "../llm/provider.js";
import { buildProviderOptions } from "../llm/provider-options.js";
import { canonical } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { buildTools } from "../tools/index.js";
import { deriveTool } from "../tools/tool-utils.js";
import { CheckRunner } from "../verification/check-runner.js";
import { sourceManifest } from "../verification/snapshot.js";
import { fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import type { WorkspaceLeases } from "./leases.js";
import { ProcessScope } from "./process-scope.js";
import {
  AnalysisSchema,
  ImplementationSchema,
  PlanSchema,
  RefutationSchema,
  ResearchSchema,
  ReviewSchema,
  type RunPolicy,
  SpecSchema,
} from "./schemas.js";
import { AttemptStepController, DEFAULT_MAX_ATTEMPT_TOKENS } from "./step-budget.js";
import type { WorkflowStore } from "./store.js";
import { WorkflowToolPolicy } from "./tool-policy.js";
import type { AgentExecutor, ExecutionRequest, ExecutionResponse } from "./types.js";

export const outputSchemas: Record<string, z.ZodType> = {
  research: ResearchSchema,
  spec: SpecSchema,
  plan: PlanSchema,
  analysis: AnalysisSchema,
  implementation: ImplementationSchema,
  review: ReviewSchema,
  convergence: ReviewSchema,
  refutation: RefutationSchema,
};
const MAX_SEMANTIC_CORRECTIONS = 2;
export class NativeAgentExecutor implements AgentExecutor {
  private ownedContext: Promise<ContextManager> | undefined;
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
    private config: AppConfig,
    private parentContext?: ContextManager,
  ) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    if (hasToolHooks(this.store.workspace))
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        "Workflow v1 cannot classify command hook effects. Disable project tool hooks for this run.",
      );
    const policy = JSON.parse(this.store.run(request.runId).policy_json) as RunPolicy;
    if (!this.parentContext && !this.ownedContext)
      this.ownedContext = ContextManager.createAsync(this.store.workspace, undefined, {
        repoMapEnabled: this.config.repoMap !== false,
      });
    const root = request.root ?? this.store.workspace;
    const parent = this.parentContext ?? (await this.ownedContext);
    if (!parent) throw new WorkflowFault("OUTPUT_INVALID", "Context initialization failed");
    const context = new ContextManager(root, parent.getSharedResources());
    try {
      const provider = await buildProviderOptions(request.profile.model, this.config);
      if (
        provider.contextWindow > 0 &&
        Math.ceil(Buffer.byteLength(request.prompt) / 3) + request.profile.maxOutputTokens >
          provider.contextWindow * 0.8
      )
        throw new WorkflowFault(
          "BUDGET_EXHAUSTED",
          "Workflow context exceeds the selected model window",
        );
      const rawTools = buildTools(root, async () => false, {
        contextManager: context,
        repoMap: context.isRepoMapReady() ? context.getRepoMap() : undefined,
        onApproveOutsideCwd: async () => false,
        onApproveDestructive: async () =>
          request.profile.role === "implementer" && request.task !== undefined,
      });
      const guard = new WorkflowToolPolicy(
        this.store,
        this.leases,
        request.runId,
        request.attemptId,
        request.profile,
        policy,
        request.task,
        root,
      );
      const available: ToolSet = {};
      for (const [name, definition] of Object.entries(rawTools)) {
        if (!request.profile.allowedTools.includes(name) || !policy.allowedTools.includes(name))
          continue;
        const original = definition as Tool;
        if (!original.execute) continue;
        const execute = original.execute;
        available[name] = deriveTool(original, {
          execute: async (input, options) => {
            const args = input as Record<string, unknown>;
            const normalized = { ...args };
            for (const key of ["path", "file", "from", "to"])
              if (typeof args[key] === "string")
                normalized[key] = workspacePath(root, guard.path(args[key]));
            if (Array.isArray(args.files))
              normalized.files = args.files.map((f: unknown) =>
                typeof f === "string"
                  ? workspacePath(root, guard.path(f))
                  : f && typeof f === "object" && "path" in f && typeof f.path === "string"
                    ? { ...f, path: workspacePath(root, guard.path(f.path)) }
                    : f,
              );
            const result = await guard.execute(name, args, async () =>
              execute(normalized, options),
            );
            if (!["edit_file", "multi_edit"].includes(name)) {
              const files = await sourceManifest(
                root,
                policy.checks.flatMap((c) => c.writes),
                request.signal,
              );
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
          },
        });
      }
      if (
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
      const schema = outputSchemas[request.profile.output];
      if (!schema) throw new WorkflowFault("OUTPUT_INVALID", "Unknown profile output schema");
      let submitted: unknown;
      let rejected = 0;
      available.submit_result = tool({
        description:
          "Submit the final typed result. Evidence IDs must come from the host context or tools.",
        inputSchema: schema,
        execute: async (value) => {
          const parsed = schema.parse(value);
          const errors = request.validate?.(parsed) ?? [];
          // After the bounded corrections the scheduler rejects the result with these errors.
          if (errors.length && rejected < MAX_SEMANTIC_CORRECTIONS) {
            rejected++;
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
      for (const alias of ["submit_artifact", "submit_review"])
        if (request.profile.allowedTools.includes(alias) && policy.allowedTools.includes(alias))
          available[alias] = available.submit_result;
      const submitTools = ["submit_result", "submit_artifact", "submit_review"].filter(
        (name) => name in available,
      );
      const budget = new AttemptStepController({
        maxSteps: request.maxSteps,
        maxTokens: policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS,
        submitTools,
        fallbackStepTokens:
          request.profile.maxOutputTokens + Math.ceil(Buffer.byteLength(request.prompt) / 2),
      });
      const result = await generateText({
        model: resolveModel(request.profile.model),
        system: request.profile.instructions,
        prompt: request.prompt,
        tools: available,
        stopWhen: [
          () => submitted !== undefined,
          stepCountIs(request.maxSteps),
          ({ steps: done }) => budget.overBudget(done),
        ],
        maxRetries: 0,
        maxOutputTokens: request.profile.maxOutputTokens,
        abortSignal: request.signal,
        providerOptions: provider.providerOptions,
        headers: provider.headers,
        prepareStep: ({ stepNumber, steps: done, messages }) => {
          request.signal.throwIfAborted();
          const reserve =
            budget.consumed(done) +
            Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 2) +
            request.profile.maxOutputTokens +
            8192;
          this.store.expandReservation(request.runId, request.attemptId, reserve, policy);
          return budget.prepare({ stepNumber, steps: done, messages });
        },
      });
      const usage = budget.record(result.steps, submitted !== undefined, {
        profileId: request.profile.id,
        taskId: request.task?.id ?? null,
      });
      this.store.transaction(() =>
        this.store.artifact(
          request.runId,
          "usage",
          `attempts/${request.attemptId}/usage.json`,
          canonical(usage),
        ),
      );
      if (usage.stopReason === "tokens")
        throw new WorkflowFault(
          "BUDGET_EXHAUSTED",
          `Profile ${request.profile.id} used ${String(usage.totalTokens)} tokens without submitting a result (attempt cap ${String(usage.maxTokens)})`,
        );
      if (submitted === undefined) {
        try {
          submitted = schema.parse(JSON.parse(result.text));
        } catch {
          const step = this.store
            .attempts(request.runId)
            .find((a) => a.id === request.attemptId)?.step_id;
          if (!step) throw new WorkflowFault("OUTPUT_INVALID", "Result attempt missing");
          const correctionPrompt = `Reformat this previous result using submit_result. Preserve its claims and evidence IDs. Do not implement or verify anything again.\n${result.text.slice(0, 256 * 1024)}`;
          const attempt = this.store.reserve(
            request.runId,
            step,
            request.profile.model,
            Math.ceil(Buffer.byteLength(correctionPrompt) / 2) +
              request.profile.maxOutputTokens +
              8192,
            policy,
          );
          try {
            const corrected = await generateText({
              model: resolveModel(request.profile.model),
              prompt: correctionPrompt,
              tools: { submit_result: available.submit_result },
              toolChoice: { type: "tool", toolName: "submit_result" },
              stopWhen: stepCountIs(1),
              maxRetries: 0,
              maxOutputTokens: request.profile.maxOutputTokens,
              abortSignal: request.signal,
              providerOptions: provider.providerOptions,
              headers: provider.headers,
            });
            submitted = schema.parse(submitted ?? JSON.parse(corrected.text));
            this.store.transaction(() =>
              this.store.finishAttempt(
                request.runId,
                attempt,
                "completed",
                corrected.totalUsage.totalTokens ?? null,
              ),
            );
          } catch {
            this.store.transaction(() =>
              this.store.finishAttempt(request.runId, attempt, "failed", null),
            );
            throw new WorkflowFault(
              "OUTPUT_INVALID",
              `Profile ${request.profile.id} returned invalid output after one format correction`,
            );
          }
        }
      }
      return {
        output: submitted,
        inputTokens: result.totalUsage.inputTokens ?? null,
        outputTokens: result.totalUsage.outputTokens ?? null,
      };
    } finally {
      context.dispose({ preserveSharedIO: true });
    }
  }
  dispose(): void {
    this.ownedContext
      ?.then((context) => context.dispose({ preserveSharedIO: true }))
      .catch(() => {});
    this.ownedContext = undefined;
  }
}
