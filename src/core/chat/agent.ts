import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import type {
  AppConfig,
  BakeMode,
  ImageAttachment,
  InteractiveCallbacks,
  PermissionMode,
} from "../../types/index.js";
import { normalizePath } from "../agents/agent-bus.js";
import { createBakeAgent } from "../agents/index.js";
import type { SharedCacheRef } from "../agents/subagent-tools.js";
import type { ContextManager } from "../context/manager.js";
import { logBackgroundError } from "../diagnostics/errors.js";
import { resolveModel } from "../llm/provider.js";
import { DEFAULT_DISABLED_TOOLS } from "../settings/schema.js";
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
  /** How much runs without asking; `auto` when left out. */
  permissions?: PermissionMode;
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
  /** Tools of the session kind, such as the coordinator's brief tool. */
  extraTools?: Record<string, unknown>;
}

/**
 * The main agent of a chat turn outside the terminal UI, with the subagent and web search models
 * of the task router. Without approval hooks, destructive commands and writes outside the
 * workspace are denied unless the session has full access, which bypasses them in
 * `createBakeAgent`; in manual mode every gated call is denied.
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
  const fullAccess = mode === "auto" || options.permissions === "full";
  const disabledTools = new Set(config.disabledTools ?? DEFAULT_DISABLED_TOOLS);
  return createBakeAgent({
    model: options.model,
    fullModelId: options.modelId,
    contextManager: options.contextManager,
    bakeMode: mode,
    ...(options.permissions ? { permissionMode: options.permissions } : {}),
    ...(options.planExecution ? { planExecution: true } : {}),
    interactive: callbacks,
    subagentModels,
    webSearchModel,
    onApproveWebSearch: webSearchEnabled ? callbacks?.onWebSearchApproval : undefined,
    onApproveFetchPage: callbacks?.onFetchPageApproval,
    onApproveOutsideCwd: options.onApproveOutsideCwd ?? (fullAccess ? undefined : deny),
    onApproveDestructive: options.onApproveDestructive ?? (fullAccess ? undefined : deny),
    providerOptions: options.providerOptions,
    headers: options.headers,
    codeExecution: config.codeExecution,
    computerUse: config.computerUse,
    anthropicTextEditor: config.anthropicTextEditor,
    agentFeatures: {
      ...config.agentFeatures,
      onDemandTools: !disabledTools.has("request_tools"),
    },
    disabledTools,
    sharedCacheRef: options.sharedCacheRef,
    cwd: options.cwd,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.drainSteering ? { drainSteering: options.drainSteering } : {}),
    ...(options.extraTools ? { extraTools: options.extraTools } : {}),
    disablePruning: !["subagents", "both"].includes(
      config.contextManagement?.pruningTarget ?? "none",
    ),
  });
}
