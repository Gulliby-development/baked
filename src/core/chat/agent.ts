import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import type {
  AppConfig,
  BakeMode,
  ImageAttachment,
  InteractiveCallbacks,
} from "../../types/index.js";
import { normalizePath } from "../agents/agent-bus.js";
import { createBakeAgent } from "../agents/index.js";
import type { SharedCacheRef } from "../agents/subagent-tools.js";
import type { ContextManager } from "../context/manager.js";
import { logBackgroundError } from "../diagnostics/errors.js";
import { resolveModel } from "../llm/provider.js";
import { onFileEdited } from "../tools/file-events.js";

export type BakeAgent = ReturnType<typeof createBakeAgent>;

/**
 * A file cache shared by dispatch subagents and later turns of one conversation, so they see edits
 * made earlier in it. The returned function stops following file edits.
 */
export function createSharedCacheRef(cwd: string): { ref: SharedCacheRef; dispose: () => void } {
  const ref: SharedCacheRef = {
    current: undefined,
    updateFile(absPath: string, content: string) {
      if (!ref.current) return;
      const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
      const rel = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
      const key = normalizePath(rel);
      ref.current.files.set(key, content);
      for (const k of ref.current.toolResults.keys()) {
        if (k.includes(key)) ref.current.toolResults.delete(k);
      }
    },
  };
  const dispose = onFileEdited((absPath, content) => ref.updateFile(absPath, content));
  return { ref, dispose };
}

function tryResolve(id: string | undefined): LanguageModel | undefined {
  if (!id) return undefined;
  try {
    return resolveModel(id);
  } catch (err) {
    logBackgroundError(
      "chat:router-resolve",
      `model "${id}" failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export interface ChatAgentOptions {
  config: AppConfig;
  cwd: string;
  modelId: string;
  model: LanguageModel;
  mode: BakeMode;
  /** The turn carries out an accepted plan. */
  planExecution?: boolean;
  contextManager: ContextManager;
  providerOptions: ProviderOptions;
  headers: Record<string, string> | undefined;
  sharedCacheRef: SharedCacheRef;
  callbacks?: InteractiveCallbacks;
  onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
  onApproveDestructive?: (description: string) => Promise<boolean>;
  drainSteering?: () => { text: string; images?: ImageAttachment[] } | null;
  sessionId?: string;
}

/**
 * The main agent of a chat turn outside the terminal UI, with the subagent and web search models
 * of the task router. Without approval hooks, destructive commands and writes outside the
 * workspace are denied unless the mode is auto, which bypasses them in `createBakeAgent`.
 */
export function createChatAgent(options: ChatAgentOptions): BakeAgent {
  const { config, mode, callbacks } = options;
  const tr = config.taskRouter;
  const sparkModelId = tr?.spark ?? tr?.exploration ?? tr?.trivial ?? undefined;
  const emberModelId = tr?.ember ?? tr?.coding ?? undefined;
  const desloppifyModelId = tr?.desloppify ?? undefined;
  const verifyModelId = tr?.verify ?? undefined;
  const subagentModels =
    sparkModelId || emberModelId || desloppifyModelId || verifyModelId
      ? {
          spark: tryResolve(sparkModelId),
          ember: tryResolve(emberModelId),
          desloppify: tryResolve(desloppifyModelId),
          verify: tryResolve(verifyModelId),
        }
      : undefined;
  const webSearchEnabled = config.webSearch !== false;
  const webSearchModel = webSearchEnabled ? tryResolve(tr?.webSearch ?? undefined) : undefined;
  const deny = async (): Promise<boolean> => false;
  return createBakeAgent({
    model: options.model,
    fullModelId: options.modelId,
    contextManager: options.contextManager,
    bakeMode: mode,
    ...(options.planExecution ? { planExecution: true } : {}),
    interactive: callbacks,
    subagentModels,
    webSearchModel,
    onApproveWebSearch: webSearchEnabled ? callbacks?.onWebSearchApproval : undefined,
    onApproveFetchPage: callbacks?.onFetchPageApproval,
    onApproveOutsideCwd: options.onApproveOutsideCwd ?? (mode === "auto" ? undefined : deny),
    onApproveDestructive: options.onApproveDestructive ?? (mode === "auto" ? undefined : deny),
    providerOptions: options.providerOptions,
    headers: options.headers,
    agentFeatures: config.agentFeatures,
    sharedCacheRef: options.sharedCacheRef,
    cwd: options.cwd,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.drainSteering ? { drainSteering: options.drainSteering } : {}),
    disablePruning: !["subagents", "both"].includes(
      config.contextManagement?.pruningTarget ?? "none",
    ),
  });
}
