import type { AppConfig } from "../../types/index.js";
import type { SharedCacheRef } from "../agents/subagent-tools.js";
import { ContextManager } from "../context/manager.js";
import { buildInstructionPrompt, loadInstructions } from "../instructions.js";
import { resolveModel } from "../llm/provider.js";
import { buildProviderOptions } from "../llm/provider-options.js";
import { createChatAgent, createSharedCacheRef } from "./agent.js";
import type { ChatAgentHost, TurnAgent, TurnAgentRequest } from "./sessions.js";

interface SessionResources {
  context: ContextManager;
  cache: SharedCacheRef;
  disposeCache: () => void;
}

/**
 * Builds chat turns with the same agent as the terminal UI. The repository map, memory and MCP
 * servers are started once, on the first turn, and shared by every session; each session gets its
 * own context manager and file cache.
 */
export class ForgeChatHost implements ChatAgentHost {
  private parent: Promise<ContextManager> | undefined;
  private readonly sessions = new Map<string, SessionResources>();
  private mcpConnected = false;

  constructor(
    private readonly workspace: string,
    private readonly config: AppConfig,
  ) {}

  private parentContext(): Promise<ContextManager> {
    this.parent ??= ContextManager.createAsync(this.workspace, undefined, {
      repoMapEnabled: this.config.repoMap !== false && process.env.BAKED_NO_REPOMAP !== "1",
    });
    return this.parent;
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
    context.setForgeMode(request.mode);
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
    const parent = this.parent;
    this.parent = undefined;
    if (parent) await (await parent).dispose();
  }
}
