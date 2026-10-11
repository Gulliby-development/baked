import type { AppConfig } from "../../types/index.js";
import type { SharedCacheRef } from "../agents/subagent-tools.js";
import { ContextManager } from "../context/manager.js";
import { SharedRootContext } from "../context/shared-root.js";
import { buildInstructionPrompt, loadInstructions } from "../instructions.js";
import { resolveModel } from "../llm/provider.js";
import { buildProviderOptions } from "../llm/provider-options.js";
import { createChatAgent, createSharedCacheRef } from "./agent.js";
import { type ExpandedChatInput, expandChatInput } from "./input-expansion.js";
import { type MentionSuggestion, suggestMentions } from "./mention-suggest.js";
import type {
  ChatAgentHost,
  InputExpansionRequest,
  TurnAgent,
  TurnAgentRequest,
} from "./sessions.js";

interface SessionResources {
  context: ContextManager;
  cache: SharedCacheRef;
  disposeCache: () => void;
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
    const model = resolveModel(request.modelId);
    const provider = await buildProviderOptions(request.modelId, this.config);
    if (!this.mcpConnected && this.config.mcpServers?.length) {
      this.mcpConnected = true;
      const { getMCPManager } = await import("../mcp/index.js");
      await getMCPManager().connectAll(this.config.mcpServers);
    }
    const { context, cache } = await this.resources(request.sessionId);
    context.setContextWindow(provider.contextWindow);
    context.setProjectInstructions(
      buildInstructionPrompt(loadInstructions(this.workspace, this.config.instructionFiles)),
    );
    context.setBakeMode(request.mode);
    const agent = createChatAgent({
      config: this.config,
      cwd: this.workspace,
      modelId: request.modelId,
      model,
      mode: request.mode,
      contextManager: context,
      providerOptions: provider.providerOptions,
      headers: provider.headers,
      sharedCacheRef: cache,
      callbacks: request.callbacks,
      onApproveOutsideCwd: request.onApproveOutsideCwd,
      onApproveDestructive: request.onApproveDestructive,
      drainSteering: request.drainSteering,
      sessionId: request.sessionId,
    });
    const turnAgent: TurnAgent = agent;
    return { agent: turnAgent, contextWindow: provider.contextWindow };
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
    if (this.mcpConnected) {
      const { disposeMCPManager } = await import("../mcp/index.js");
      await disposeMCPManager();
    }
    if (this.ownsRoot) await this.root.dispose();
  }
}
