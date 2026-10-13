import type { AppConfig } from "../../types/index.js";
import type { SharedCacheRef } from "../agents/subagent-tools.js";
import { compactConversation } from "../compaction/manual.js";
import { ContextManager } from "../context/manager.js";
import { SharedRootContext } from "../context/shared-root.js";
import { buildInstructionPrompt, loadInstructions } from "../instructions.js";
import { resolveModel } from "../llm/provider.js";
import { buildProviderOptions, withChatEffort } from "../llm/provider-options.js";
import { resolveTaskModel } from "../llm/task-router.js";
import { emitCacheReset } from "../tools/file-events.js";
import { createChatAgent, createSharedCacheRef } from "./agent.js";
import { BRIEF_TOOL, BriefStore, briefTool, coordinatorInstructions } from "./coordinator.js";
import { ScheduleStore, scheduleInstructions } from "./coordinator-schedules.js";
import { type ExpandedChatInput, expandChatInput } from "./input-expansion.js";
import { type MentionSuggestion, suggestMentions } from "./mention-suggest.js";
import type {
  ChatAgentHost,
  CompactionRequest,
  CompactionResponse,
  InputExpansionRequest,
  TurnAgent,
  TurnAgentRequest,
} from "./sessions.js";

interface SessionResources {
  context: ContextManager;
  cache: SharedCacheRef;
  disposeCache: () => void;
  /** The Baked map settings last applied to `context`, to apply a changed config only once. */
  mapSettings?: string;
}

/**
 * Builds chat turns with the same agent as the terminal UI. The repository map, memory and MCP
 * servers are started once, on the first turn, and shared by every session; each session gets its
 * own context manager and file cache. Given the workflow service's root context, chat and workflow
 * runs share one code-intelligence worker and one set of language servers.
 */
export class BakeChatHost implements ChatAgentHost {
  private readonly root: SharedRootContext;
  private readonly ownsRoot: boolean;
  private readonly sessions = new Map<string, SessionResources>();
  private mcpConnected = false;

  /** Without `root`, the host creates a root of its own and disposes it with the host. */
  constructor(
    private readonly workspace: string,
    private readonly config: AppConfig,
    root?: SharedRootContext,
  ) {
    this.root = root ?? SharedRootContext.forWorkspace(workspace, config);
    this.ownsRoot = !root;
  }

  private parentContext(): Promise<ContextManager> {
    return this.root.get();
  }

  private async resources(sessionId: string): Promise<SessionResources> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const parent = await this.parentContext();
    const context = new ContextManager(this.workspace, parent.getSharedResources());
    context.setTabId(sessionId);
    const { ref, dispose } = createSharedCacheRef(this.workspace);
    const created = { context, cache: ref, disposeCache: dispose };
    this.sessions.set(sessionId, created);
    return created;
  }

  async agent(request: TurnAgentRequest): Promise<{ agent: TurnAgent; contextWindow: number }> {
    const config = withChatEffort(request.modelId, this.config, request.effort);
    const model = resolveModel(request.modelId, config);
    const provider = await buildProviderOptions(request.modelId, config);
    if (!this.mcpConnected && this.config.mcpServers?.length) {
      this.mcpConnected = true;
      const { getMCPManager } = await import("../mcp/index.js");
      await getMCPManager().connectAll(this.config.mcpServers);
    }
    const resources = await this.resources(request.sessionId);
    const { context, cache } = resources;
    context.setContextWindow(provider.contextWindow);
    const instructions = buildInstructionPrompt(
      loadInstructions(this.workspace, this.config.instructionFiles),
    );
    // A coordinator turn reads its brief fresh, so edits from the API or a past turn show.
    const brief = request.coordinator ? new BriefStore(this.workspace, request.sessionId) : null;
    context.setProjectInstructions(
      [
        instructions,
        brief ? coordinatorInstructions(brief.read()) : "",
        brief ? scheduleInstructions(new ScheduleStore(this.workspace, request.sessionId)) : "",
        request.instructions ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    context.setBakeMode(request.mode);
    this.applyContextSettings(resources);
    // The provider's prompt cache dies after its idle lifetime; map diffs kept past it only cost
    // tokens, as in the terminal UI.
    context.maybeReseedExpiredCache(this.config.cache?.ttl === "1h" ? 3_540_000 : 270_000);
    const agent = createChatAgent({
      config,
      cwd: this.workspace,
      modelId: request.modelId,
      model,
      mode: request.mode,
      planExecution: request.planExecution,
      contextManager: context,
      providerOptions: provider.providerOptions,
      headers: provider.headers,
      sharedCacheRef: cache,
      callbacks: request.callbacks,
      onApproveOutsideCwd: request.onApproveOutsideCwd,
      onApproveDestructive: request.onApproveDestructive,
      drainSteering: request.drainSteering,
      sessionId: request.sessionId,
      ...(brief
        ? { extraTools: { ...request.tools, [BRIEF_TOOL]: briefTool(brief) } }
        : request.tools
          ? { extraTools: request.tools }
          : {}),
    });
    const turnAgent: TurnAgent = agent;
    return { agent: turnAgent, contextWindow: provider.contextWindow };
  }

  /** Applies the config's task router and Baked map settings, which the settings API may change. */
  private applyContextSettings(resources: SessionResources): void {
    const { context } = resources;
    const config = this.config;
    context.setTaskRouter(config.taskRouter);
    context.setRepoMapEnabled(config.repoMap !== false);
    const map = JSON.stringify([
      config.semanticSummaries,
      config.semanticSummaryLimit,
      config.semanticAutoRegen,
      config.repoMapTokenBudget,
    ]);
    if (resources.mapSettings === map) return;
    resources.mapSettings = map;
    if (config.semanticSummaries !== undefined)
      context.setSemanticSummaries(config.semanticSummaries).catch(() => {
        // Summaries are best effort; the map works without them.
      });
    context.setSemanticSummaryLimit(config.semanticSummaryLimit);
    context.setSemanticAutoRegen(config.semanticAutoRegen);
    context.setRepoMapTokenBudget(config.repoMapTokenBudget);
  }

  /**
   * Compacts a session as the terminal UI's `/compact` does: with the task router's `compact`
   * model, the configured strategy, and a context manager that forgets what the summary replaced.
   */
  async compact(request: CompactionRequest): Promise<CompactionResponse> {
    const modelId = resolveTaskModel("compact", this.config.taskRouter, request.modelId);
    const provider = await buildProviderOptions(modelId, this.config);
    const result = await compactConversation({
      core: request.messages,
      config: this.config.compaction,
      modelId,
      model: resolveModel(modelId),
      providerOptions: provider.providerOptions,
      ...(provider.headers ? { headers: provider.headers } : {}),
      abortSignal: request.abortSignal,
    });
    if (result.status !== "compacted") return { result };
    const { context } = await this.resources(request.sessionId);
    emitCacheReset();
    const tracked = context.getTrackedFiles();
    context.resetForCompaction();
    for (const file of tracked.edited) {
      try {
        context.onFileChanged(file);
      } catch {
        // The file may have been deleted since.
      }
    }
    for (const file of tracked.mentioned) context.trackMentionedFile(file);
    const systemChars = (await context.getContextBreakdown()).reduce((sum, s) => sum + s.chars, 0);
    const window = (await buildProviderOptions(request.modelId, this.config)).contextWindow;
    return { result, systemChars, contextWindow: window };
  }

  async expandInput(request: InputExpansionRequest): Promise<ExpandedChatInput> {
    const { context } = await this.resources(request.sessionId);
    const expanded = await expandChatInput(request.text, {
      cwd: this.workspace,
      mode: request.mode,
      ...(context.isRepoMapReady() ? { repoMap: context.getRepoMap() } : {}),
      onApproveDestructive: request.onApproveDestructive,
      tabId: request.sessionId,
      abortSignal: request.abortSignal,
    });
    for (const f of expanded.files) context.trackMentionedFile(f);
    return expanded;
  }

  async suggestMentions(query: string, limit?: number): Promise<MentionSuggestion[]> {
    const parent = await this.parentContext();
    return suggestMentions(query, {
      cwd: this.workspace,
      ...(parent.isRepoMapReady() ? { repoMap: parent.getRepoMap() } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  release(sessionId: string): void {
    const resources = this.sessions.get(sessionId);
    if (!resources) return;
    this.sessions.delete(sessionId);
    resources.disposeCache();
    void resources.context.dispose();
  }

  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.release(id);
    // The local API's /v1/mcp can connect servers before any chat does.
    const { disposeMCPManager } = await import("../mcp/index.js");
    await disposeMCPManager();
    if (this.ownsRoot) await this.root.dispose();
  }
}
