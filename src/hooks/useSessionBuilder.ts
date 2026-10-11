import type { ModelMessage } from "ai";
import { projectIdOf } from "../core/projects/resolve.js";
import type { SessionMeta, TabMeta } from "../core/sessions/types.js";
import { useCheckpointStore } from "../stores/checkpoints.js";
import { useUIStore } from "../stores/ui.js";
import { useWorkflowStore } from "../stores/workflow.js";
import type { ChatMessage } from "../types/index.js";
import type { WorkspaceSnapshot } from "./useChat.js";

interface BuildParams {
  sessionId: string;
  title: string;
  customTitle?: string | null;
  cwd: string;
  snapshot: WorkspaceSnapshot;
  currentTabMessages: ChatMessage[];
  currentTabCoreMessages?: ModelMessage[];
}

export function buildSessionMeta({
  sessionId,
  title,
  customTitle,
  cwd,
  snapshot,
  currentTabMessages,
  currentTabCoreMessages,
}: BuildParams): {
  meta: SessionMeta;
  tabMessages: Map<string, ChatMessage[]>;
  tabCoreMessages: Map<string, ModelMessage[]>;
} {
  const tabMessages = new Map<string, ChatMessage[]>();
  const tabCoreMessages = new Map<string, ModelMessage[]>();
  const tabs: TabMeta[] = [];

  for (const tabState of snapshot.tabStates) {
    const isActiveTab = tabState.id === snapshot.activeTabId;
    const msgs = isActiveTab
      ? currentTabMessages
      : tabState.messages.filter((m) => m.role !== "system" || m.showInChat);
    tabMessages.set(tabState.id, msgs);

    const cores =
      isActiveTab && currentTabCoreMessages ? currentTabCoreMessages : tabState.coreMessages;
    tabCoreMessages.set(tabState.id, cores);

    // Extract checkpoint git tags for session persistence (include redo stack
    // so undo→save→restore→redo works)
    const cpStore = useCheckpointStore.getState();
    const checkpointTags = cpStore.snapshotTags(tabState.id);

    const uiSnapshot = useUIStore.getState();
    const verboseForTab = uiSnapshot.verboseByTab[tabState.id];

    tabs.push({
      workflowRunId: useWorkflowStore.getState().runsByTab[tabState.id],
      id: tabState.id,
      label: tabState.label,
      activeModel: tabState.activeModel,
      sessionId: tabState.sessionId,
      planMode: tabState.planMode,
      planRequest: tabState.planRequest,
      coAuthorCommits: tabState.coAuthorCommits,
      bakeMode: tabState.bakeMode,
      tokenUsage: tabState.tokenUsage,
      messageRange: { startLine: 0, endLine: msgs.length },
      ...(checkpointTags.length > 0 ? { checkpointTags } : {}),
      ...(verboseForTab !== undefined ? { verbose: verboseForTab } : {}),
    });
  }

  const allMsgs = [...tabMessages.values()].flat();
  const startedAt = allMsgs[0]?.timestamp ?? Date.now();

  const activeTabState = snapshot.tabStates.find((t) => t.id === snapshot.activeTabId);
  const meta: SessionMeta = {
    id: sessionId,
    title,
    ...(customTitle ? { customTitle } : {}),
    cwd,
    startedAt,
    updatedAt: Date.now(),
    activeTabId: snapshot.activeTabId,
    bakeMode: activeTabState?.bakeMode ?? "default",
    tabs,
  };
  const projectId = projectIdOf(cwd);
  if (projectId) meta.projectId = projectId;

  return { meta, tabMessages, tabCoreMessages };
}
/**
 * Build a single tab's TabMeta + slice — used by per-tab autosave paths so
 * concurrent tabs don't read each other's snapshot. Pair with
 * SessionManager.saveTab which preserves all other tabs' on-disk content.
 */
export function buildTabMeta(args: {
  tabId: string;
  tabLabel: string;
  activeModel: string;
  sessionId: string;
  planMode: boolean;
  planRequest: string | null;
  coAuthorCommits: boolean;
  bakeMode: import("../types/index.js").BakeMode;
  tokenUsage: TabMeta["tokenUsage"];
  messages: ChatMessage[];
  coreMessages?: ModelMessage[];
}): { tabMeta: TabMeta; messages: ChatMessage[]; coreMessages?: ModelMessage[] } {
  const msgs = args.messages.filter((m) => m.role !== "system" || m.showInChat);

  const checkpointTags = useCheckpointStore.getState().snapshotTags(args.tabId);

  const uiSnapshot = useUIStore.getState();
  const verboseForTab = uiSnapshot.verboseByTab[args.tabId];

  const tabMeta: TabMeta = {
    workflowRunId: useWorkflowStore.getState().runsByTab[args.tabId],
    id: args.tabId,
    label: args.tabLabel,
    activeModel: args.activeModel,
    sessionId: args.sessionId,
    planMode: args.planMode,
    planRequest: args.planRequest,
    coAuthorCommits: args.coAuthorCommits,
    bakeMode: args.bakeMode,
    tokenUsage: args.tokenUsage,
    messageRange: { startLine: 0, endLine: msgs.length },
    ...(checkpointTags.length > 0 ? { checkpointTags } : {}),
    ...(verboseForTab !== undefined ? { verbose: verboseForTab } : {}),
  };

  return { tabMeta, messages: msgs, coreMessages: args.coreMessages };
}
