import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { isCustomSlashInput } from "../../core/commands/registry.js";
import { ContextManager, type SharedContextResources } from "../../core/context/manager.js";
import { getWorkspaceCoordinator } from "../../core/coordination/WorkspaceCoordinator.js";
import { icon } from "../../core/icons.js";
import { buildInstructionPrompt, loadInstructions } from "../../core/instructions.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import { clearTabSessionPatterns } from "../../core/security/forbidden.js";
import type { SessionManager } from "../../core/sessions/manager.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { clearEditStacks } from "../../core/tools/edit-stack.js";
import { planFileName } from "../../core/tools/index.js";
import { disposeTaskScope, setActiveTaskTab } from "../../core/tools/task-list.js";
import { type ChatInstance, type TabState, useChat } from "../../hooks/useChat.js";
import { useLandingTransition } from "../../hooks/useLandingTransition.js";
import { useSessionDiffStats } from "../../hooks/useSessionDiffStats.js";
import type { TabActivity } from "../../hooks/useTabs.js";
import { useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { useWatchMode } from "../../hooks/useWatchMode.js";
import { useCheckpointStore } from "../../stores/checkpoints.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useUIStore } from "../../stores/ui.js";
import type { AppConfig, ChatMessage, ImageAttachment } from "../../types/index.js";
import { CheckpointRail } from "../chat/CheckpointRail.js";
import { FinalResponseLiveAutoView } from "../chat/FinalResponseView.js";
import { InputBox } from "../chat/InputBox.js";
import { CodeExpandedProvider, VerboseProvider } from "../chat/Markdown.js";
import {
  ExpandToggleProvider,
  RAIL_BORDER,
  ReasoningExpandedProvider,
  StaticMessage,
} from "../chat/MessageList.js";
import { StreamSegmentList } from "../chat/StreamSegmentList.js";
import { PlanProgress } from "../plan/PlanProgress.js";
import { PlanReviewPrompt } from "../plan/PlanReviewPrompt.js";
import { TaskProgress, useTaskList } from "../plan/TaskProgress.js";
import { QuestionPrompt } from "../QuestionPrompt.js";
import { chatScrollAccel } from "../ui/scroll.js";
import { AnimatedBorder } from "./AnimatedBorder.js";
import { ChangedFilesBar, ChangesPanel } from "./ChangedFiles.js";
import { LandingPage } from "./LandingPage.js";
import { LoadingStatus } from "./LoadingStatus.js";
import { SystemBanner } from "./SystemBanner.js";

interface TabInstanceProps {
  tabId: string;
  tabLabel: string;
  visible: boolean;
  onFocus?: () => void;
  effectiveConfig: AppConfig;
  sharedResources: SharedContextResources;
  sessionManager: SessionManager;
  cwd: string;
  onCommand: (input: string, chat: ChatInstance) => void;
  onModeChange?: (mode: import("../../types/index.js").BakeMode) => void;
  onModelChange?: (modelId: string) => void;
  onExit: () => void;
  registerChat: (id: string, chat: ChatInstance) => void;
  unregisterChat: (id: string) => void;
  setTabActivity: (id: string, activity: Partial<TabActivity>) => void;
  initialState?: TabState;
  anyModalOpen: boolean;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  onCycleTab?: (direction: 1 | -1) => void;
}

const MAX_RENDERED = 40;
const SCROLLBOX_STYLE = { contentOptions: { justifyContent: "flex-end" as const } };
const SCROLLBAR_HIDDEN = { visible: false } as const;
function getScrollbarVisible(tk: ThemeTokens) {
  return {
    visible: true as const,
    trackOptions: {
      foregroundColor: tk.textMuted,
      backgroundColor: tk.textSubtle,
    },
  };
}

export const TabInstance = memo(function TabInstance({
  tabId,
  tabLabel,
  visible,
  onFocus,
  effectiveConfig,
  sharedResources,
  sessionManager,
  cwd,
  onCommand,
  onModeChange,
  onModelChange,
  onExit,
  registerChat,
  unregisterChat,
  setTabActivity,
  initialState,
  anyModalOpen,
  bootProviders,
  bootPrereqs,
  onCycleTab,
}: TabInstanceProps) {
  const t = useTheme();
  const { width: termWidth } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Per-tab ContextManager sharing expensive resources
  const contextManager = useMemo(
    () => new ContextManager(cwd, sharedResources),
    [cwd, sharedResources],
  );

  const getRepoMap = useCallback(
    () => (contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined),
    [contextManager],
  );

  // Register tabId with contextManager for cross-tab awareness
  useEffect(() => {
    contextManager.setTabId(tabId);
    contextManager.setTabLabel(tabLabel);
  }, [tabId, tabLabel, contextManager]);

  // Set active task tab when this tab becomes visible
  useEffect(() => {
    if (visible) setActiveTaskTab(tabId);
  }, [tabId, visible]);

  // Dispose task scope only on unmount (tab close), not on hide
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup-only on unmount
  useEffect(() => () => disposeTaskScope(tabId), []);

  useEffect(() => {
    contextManager.setRepoMapEnabled(effectiveConfig.repoMap !== false);
  }, [effectiveConfig.repoMap, contextManager]);

  useEffect(() => {
    contextManager.setTaskRouter(effectiveConfig.taskRouter);
  }, [effectiveConfig.taskRouter, contextManager]);

  useEffect(() => {
    const loaded = loadInstructions(cwd, effectiveConfig.instructionFiles);
    contextManager.setProjectInstructions(buildInstructionPrompt(loaded));
  }, [effectiveConfig.instructionFiles, cwd, contextManager]);

  useEffect(() => {
    if (effectiveConfig.semanticSummaries !== undefined)
      contextManager.setSemanticSummaries(effectiveConfig.semanticSummaries);
    contextManager.setSemanticSummaryLimit(effectiveConfig.semanticSummaryLimit);
    contextManager.setSemanticAutoRegen(effectiveConfig.semanticAutoRegen);
    contextManager.setRepoMapTokenBudget(effectiveConfig.repoMapTokenBudget);
  }, [
    effectiveConfig.semanticSummaries,
    effectiveConfig.semanticSummaryLimit,
    effectiveConfig.semanticAutoRegen,
    effectiveConfig.repoMapTokenBudget,
    contextManager,
  ]);

  // Per-tab useChat instance
  const chat = useChat({
    effectiveConfig,
    contextManager,
    sessionManager,
    cwd,
    tabId,
    tabLabel,
    initialState,
    visible,
    onModelChange,
  });

  useWatchMode(tabId, cwd, effectiveConfig.watch, chat);

  // Sync coAuthorCommits from config
  useEffect(() => {
    if (effectiveConfig.coAuthorCommits !== undefined)
      chat.setCoAuthorCommits(effectiveConfig.coAuthorCommits);
  }, [effectiveConfig.coAuthorCommits, chat.setCoAuthorCommits]);

  // Seed active model for semantic summary generation
  useEffect(() => {
    contextManager.setActiveModel(chat.activeModel);
  }, [chat.activeModel, contextManager]);

  // Register/unregister chat instance with tab manager
  useEffect(() => {
    registerChat(tabId, chat);
    return () => unregisterChat(tabId);
  }, [tabId, chat, registerChat, unregisterChat]);

  // Sync Baked mode to header when it changes in the active tab
  useEffect(() => {
    if (visible && onModeChange) onModeChange(chat.bakeMode);
  }, [visible, chat.bakeMode, onModeChange]);

  // Sync status bar when this tab is active
  useEffect(() => {
    if (visible) {
      useStatusBarStore.getState().setTokenUsage(chat.tokenUsage, chat.activeModel);
    }
  }, [visible, chat.tokenUsage, chat.activeModel]);

  // Per-tab loading start timestamp — driven by useChat (set after Baked Map wait)
  const loadingStartedAtRef = useRef(0);
  if (chat.loadingStartedAt > 0) loadingStartedAtRef.current = chat.loadingStartedAt;

  // Report loading state to tab manager, sync coordinator idle/active, update claim count
  const prevLoading = useRef(chat.isLoading);
  useEffect(() => {
    const coordinator = getWorkspaceCoordinator();
    setTabActivity(tabId, { isLoading: chat.isLoading, isCompacting: chat.isCompacting });
    // Mark unread if loading finished while tab is in background
    if (prevLoading.current && !chat.isLoading && !visible) {
      setTabActivity(tabId, { hasUnread: true });
    }
    // Signal coordinator idle/active state
    if (!chat.isLoading && prevLoading.current) {
      coordinator.markIdle(tabId);
    } else if (chat.isLoading && !prevLoading.current) {
      coordinator.markActive(tabId);
    }
    prevLoading.current = chat.isLoading;
  }, [chat.isLoading, chat.isCompacting, tabId, setTabActivity, visible]);

  // Signal attention when tab is waiting for user input (plan review or question)
  useEffect(() => {
    const needs = !!(chat.pendingPlanReview || chat.pendingQuestion);
    setTabActivity(tabId, { needsAttention: needs });
  }, [chat.pendingPlanReview, chat.pendingQuestion, tabId, setTabActivity]);

  // Sync claim count to tab activity for tab bar indicator
  useEffect(() => {
    const coordinator = getWorkspaceCoordinator();
    let lastCount = coordinator.getClaimCount(tabId);
    const unsub = coordinator.on((event, eventTabId) => {
      if (eventTabId === tabId || event === "release") {
        const newCount = coordinator.getClaimCount(tabId);
        if (newCount !== lastCount) {
          lastCount = newCount;
          setTabActivity(tabId, { editedFileCount: newCount });
        }
      }
    });
    return unsub;
  }, [tabId, setTabActivity]);

  const diffStats = useSessionDiffStats(chat.messages, cwd, chat.isLoading, visible);

  // ── Checkpoint sync ──
  useEffect(() => {
    useCheckpointStore.getState().syncFromMessages(tabId, chat.messages, chat.isLoading);
  }, [tabId, chat.messages, chat.isLoading]);

  // Auto-tag checkpoints on completion (loading → false) — tag ALL untagged checkpoints with edits.
  // Its own ref: the activity effect above has already moved prevLoading to the new state.
  const wasLoading = useRef(chat.isLoading);
  useEffect(() => {
    const finished = wasLoading.current && !chat.isLoading;
    wasLoading.current = chat.isLoading;
    if (finished) void useCheckpointStore.getState().tagFinishedTurns(tabId, cwd);
  }, [chat.isLoading, tabId, cwd]);

  // Checkpoint browsing state
  const checkpoints = useCheckpointStore((s) => s.tabs[tabId]?.checkpoints ?? []);
  const checkpointViewing = useCheckpointStore((s) => s.tabs[tabId]?.viewing ?? null);

  // Scroll to the viewed checkpoint's user message (pinned to top of viewport).
  // Use a microtask so layout has settled after the state change.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    if (checkpointViewing === null) {
      sb.scrollTo(sb.scrollHeight);
      return;
    }
    queueMicrotask(() => {
      const cp = checkpoints.find((c) => c.index === checkpointViewing);
      if (!cp) return;
      const child = sb.content.findDescendantById(`msg-${cp.anchorMessageId}`);
      if (child) {
        // Offset slightly so the "You" header is fully visible, not clipped
        sb.scrollTop = Math.max(0, child.y - 1);
      } else {
        sb.scrollChildIntoView(`msg-${cp.anchorMessageId}`);
      }
    });
  }, [checkpointViewing, checkpoints]);

  // Override context bar estimate when viewing a past checkpoint
  useEffect(() => {
    if (!visible) return;
    if (checkpointViewing === null) return;
    const cp = checkpoints.find((c) => c.index === checkpointViewing);
    if (!cp) return;
    const store = useStatusBarStore.getState();
    const savedChars = store.chatChars;
    // Sum chars from live messages up to (and including) this checkpoint's anchor.
    const anchorIdx = chat.messages.findIndex((m) => m.id === cp.anchorMessageId);
    const slice = anchorIdx >= 0 ? chat.messages.slice(0, anchorIdx + 1) : chat.messages;
    let chars = 0;
    for (const m of slice) {
      if (typeof m.content === "string") chars += m.content.length;
    }
    store.setContext(0, chars);
    store.setBrowsingCheckpoint(true);
    return () => {
      const s = useStatusBarStore.getState();
      s.setContext(0, savedChars);
      s.setBrowsingCheckpoint(false);
    };
  }, [checkpointViewing, checkpoints, visible, chat.messages]);

  // Cleanup / dispose on unmount
  useEffect(() => {
    return () => {
      contextManager.dispose();
      clearTabSessionPatterns(tabId);
      clearEditStacks(tabId);
      // Close tab in coordinator — releases claims, clears agents, blocks ghost claims
      getWorkspaceCoordinator().closeTab(tabId);
      // Clean up checkpoint git tags (skip if session is being saved) and state
      if (!useCheckpointStore.getState().shouldSkipCleanup(tabId)) {
        useCheckpointStore.getState().cleanupGitTags(tabId, cwd);
      }
      useCheckpointStore.getState().clear(tabId);
      // Clean up any pending plan file on disk
      const p = join(cwd, ".baked", "plans", planFileName(chat.sessionId));
      unlink(p).catch(() => {});
    };
  }, [contextManager, tabId, cwd, chat.sessionId]);

  // Derived state
  const isStreaming = chat.streamSegments.length > 0 || chat.liveToolCalls.length > 0;

  // Compute which messages should be dimmed.
  // Two independent sources:
  // 1. Undone checkpoints (permanent, from /checkpoint undo) — shows separator
  // 2. Viewing a past checkpoint (temporary, from ^B/^F) — no separator, clears on ^F to live
  const { dimmedMessageIds, firstDimmedMessageId, dimmedReason } = useMemo(() => {
    const ids = new Set<string>();
    let firstId: string | null = null;
    let reason: "undone" | "viewing" | null = null;

    // --- Undone checkpoints (permanent) ---
    const undoneAnchors = new Set(
      checkpoints.filter((cp) => cp.undone).map((cp) => cp.anchorMessageId),
    );
    if (undoneAnchors.size > 0) {
      let inUndone = false;
      for (const msg of chat.messages) {
        const isUserNonSteering = msg.role === "user" && !msg.isSteering;
        if (isUserNonSteering && undoneAnchors.has(msg.id)) {
          inUndone = true;
          if (!firstId) {
            firstId = msg.id;
            reason = "undone";
          }
        } else if (isUserNonSteering && !undoneAnchors.has(msg.id)) {
          inUndone = false;
        }
        if (inUndone) ids.add(msg.id);
      }
    }

    // --- Viewing a past checkpoint (temporary) ---
    if (checkpointViewing !== null) {
      let cpCounter = 0;
      let pastViewed = false;
      for (const msg of chat.messages) {
        if (msg.role === "user" && !msg.isSteering) {
          cpCounter++;
          if (cpCounter > checkpointViewing) pastViewed = true;
        }
        if (pastViewed) {
          if (!ids.has(msg.id) && !firstId) {
            firstId = msg.id;
            reason = "viewing";
          }
          ids.add(msg.id);
        }
      }
    }

    return { dimmedMessageIds: ids, firstDimmedMessageId: firstId, dimmedReason: reason };
  }, [chat.messages, checkpoints, checkpointViewing]);

  const nonSystemCount = useMemo(() => {
    let count = 0;
    for (const m of chat.messages) {
      if (m.role !== "system" || m.showInChat) count++;
    }
    return count;
  }, [chat.messages]);

  const hasContent = nonSystemCount > 0 || isStreaming;
  const transition = useLandingTransition(hasContent);
  const showLanding = transition.phase !== "chat";
  const showChat = transition.phase !== "landing";

  // Show scrollbar as soon as we have content. The stickyScroll + stickyStart="bottom"
  // combo handles initial positioning correctly.
  const scrollbarReady = hasContent;

  const {
    codeExpandedMap,
    changesExpanded,
    chatStyle,
    showReasoning,
    reasoningExpandedMap,
    tabVerbose,
  } = useUIStore(
    useShallow((s) => ({
      codeExpandedMap: s.codeExpanded,
      changesExpanded: s.changesExpanded,
      chatStyle: s.chatStyle,
      showReasoning: s.showReasoning,
      reasoningExpandedMap: s.reasoningExpanded,
      tabVerbose: s.verboseByTab[tabId] ?? false,
    })),
  );
  const codeExpanded = !!codeExpandedMap[tabId];
  const reasoningExpanded = !!reasoningExpandedMap[tabId];
  const toggleAllExpandedForTab = useCallback(
    () => useUIStore.getState().toggleAllExpanded(tabId),
    [tabId],
  );

  const showPlanProgress = !!chat.activePlan;
  const tasks = useTaskList(tabId);

  const hasChangedFiles = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (msg?.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if ((tc.name === "edit_file" || tc.name === "multi_edit") && tc.result?.success)
          return true;
        if (tc.name === "dispatch" && tc.result?.filesEdited?.length) return true;
      }
    }
    return false;
  }, [chat.messages]);

  const visibleMessages = useMemo(() => {
    const msgs = chat.messages;
    const keep = (m: ChatMessage) => m.role !== "system" || m.showInChat;
    if (nonSystemCount <= MAX_RENDERED) return msgs.filter(keep);

    // When viewing a past checkpoint (not the latest), shift window to include it
    if (checkpointViewing !== null) {
      const isLatest = checkpoints.length > 0 && checkpointViewing >= checkpoints.length;
      if (!isLatest) {
        const cp = checkpoints.find((c) => c.index === checkpointViewing);
        if (cp) {
          // For checkpoint 1, start from the beginning so no "earlier messages" banner
          const startIdx =
            checkpointViewing === 1
              ? 0
              : Math.max(0, msgs.findIndex((m) => m.id === cp.anchorMessageId) - 4);
          const result: typeof msgs = [];
          for (let i = startIdx; i < msgs.length && result.length < MAX_RENDERED; i++) {
            if (keep(msgs[i] as ChatMessage)) result.push(msgs[i] as (typeof msgs)[0]);
          }
          return result;
        }
      }
    }

    const result: typeof msgs = [];
    for (let i = msgs.length - 1; i >= 0 && result.length < MAX_RENDERED; i--) {
      if (keep(msgs[i] as ChatMessage)) result.push(msgs[i] as (typeof msgs)[0]);
    }
    result.reverse();
    return result;
  }, [chat.messages, nonSystemCount, checkpointViewing, checkpoints]);
  const hiddenCount = nonSystemCount - visibleMessages.length;

  // Trim old tool results
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger
  useEffect(() => {
    const TRIM_THRESHOLD = 50;
    const KEEP_RECENT = 30;
    if (chat.messages.length < TRIM_THRESHOLD) return;
    const trimCount = chat.messages.length - KEEP_RECENT;
    let changed = false;
    const updated = chat.messages.map((msg, i) => {
      if (i >= trimCount || !msg.toolCalls) return msg;
      let tcChanged = false;
      const newToolCalls = msg.toolCalls.map((tc) => {
        if (tc.result && tc.result.output.length > 200) {
          tcChanged = true;
          return {
            ...tc,
            result: { ...tc.result, output: `${tc.result.output.slice(0, 100)}…[trimmed]` },
          };
        }
        return tc;
      });
      if (!tcChanged) return msg;
      changed = true;
      return { ...msg, toolCalls: newToolCalls };
    });
    if (changed) chat.setMessages(updated);
  }, [chat.messages.length]);

  const cleanupPlanFile = useCallback(() => {
    const p = join(cwd, ".baked", "plans", planFileName(chat.sessionId));
    unlink(p).catch(() => {});
  }, [cwd, chat.sessionId]);

  const onAcceptPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("execute");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const onClearAndImplementPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("clear_execute");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const onRevisePlan = useCallback(
    (feedback: string) => {
      chat.pendingPlanReview?.resolve(feedback);
    },
    [chat.pendingPlanReview],
  );

  const onCancelPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("cancel");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const branchingRef = useRef(false);
  const handleInputSubmit = useCallback(
    async (input: string, images?: ImageAttachment[]) => {
      if (input.startsWith("/") && !isCustomSlashInput(input, cwd)) {
        onCommand(input, chat);
        return;
      }
      // Branch-on-submit: if viewing a past checkpoint, undo to that point (reverts files + messages)
      const cpStore = useCheckpointStore.getState();
      const viewingIdx = cpStore.getViewing(tabId);
      let current = chat.messages;
      if (viewingIdx !== null) {
        if (branchingRef.current) return; // guard against double-submit during async undo
        branchingRef.current = true;
        try {
          const undoResult = await cpStore.undoToCheckpoint(tabId, viewingIdx, cwd, chat.messages);
          const msgs = undoResult?.messages;
          if (msgs) {
            current = msgs;
            chat.setMessages(msgs);
            try {
              const { rebuildCoreMessages } = await import("../../core/sessions/rebuild.js");
              chat.setCoreMessages(rebuildCoreMessages(msgs));
            } catch {
              chat.setCoreMessages([]);
            }
          }
          if (!undoResult) cpStore.setViewing(tabId, null);
        } finally {
          branchingRef.current = false;
        }
      }
      // The first turn of a tab snapshots the workspace, so forks can roll back to before it
      if (!chat.isLoading) await cpStore.ensureBaseTag(tabId, cwd, current);
      chat.handleSubmit(input, images);

      // Re-engage sticky scroll so new messages are visible
      const sb = scrollRef.current;
      if (sb) {
        sb.scrollTo(sb.scrollHeight);
      }
    },
    [chat, onCommand, tabId, cwd],
  );

  const isFocused = visible && !anyModalOpen;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box focuses a terminal pane; it is not an HTML element
    <box
      visible={visible}
      onMouseDown={onFocus}
      flexDirection="column"
      flexGrow={1}
      flexShrink={0}
      width="100%"
    >
      <SystemBanner messages={chat.messages} expanded={codeExpanded} />

      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row">
        {/* ── Landing page layer (fades out during transition) ── */}
        {showLanding && (
          <box
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            style={{ opacity: transition.landingOpacity }}
            position={showChat ? "absolute" : "relative"}
            width={showChat ? "100%" : undefined}
            height={showChat ? "100%" : undefined}
          >
            <LandingPage
              bootProviders={bootProviders}
              bootPrereqs={bootPrereqs}
              activeModel={chat.activeModel}
            />
          </box>
        )}

        {/* ── Chat content layer (fades in during transition) ── */}
        {showChat && (
          <box
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            flexDirection="row"
            style={{ opacity: transition.chatOpacity }}
          >
            <AnimatedBorder active={chat.isLoading || chat.isCompacting}>
              <scrollbox
                ref={scrollRef}
                stickyScroll={true}
                stickyStart="bottom"
                scrollAcceleration={chatScrollAccel}
                viewportCulling={true}
                focusable={false}
                flexGrow={1}
                flexShrink={1}
                minHeight={0}
                style={SCROLLBOX_STYLE}
                verticalScrollbarOptions={
                  scrollbarReady ? getScrollbarVisible(t) : SCROLLBAR_HIDDEN
                }
                horizontalScrollbarOptions={SCROLLBAR_HIDDEN}
              >
                <ExpandToggleProvider value={toggleAllExpandedForTab}>
                  <CodeExpandedProvider value={codeExpanded}>
                    <VerboseProvider value={effectiveConfig.verbose === true}>
                      <ReasoningExpandedProvider value={reasoningExpanded}>
                        {hiddenCount > 0 && (
                          <box paddingX={1} marginBottom={1}>
                            <text fg={t.textDim}>
                              ── {String(hiddenCount)} earlier message{hiddenCount > 1 ? "s" : ""}{" "}
                              ──
                            </text>
                          </box>
                        )}
                        {visibleMessages.map((msg) => (
                          <box
                            key={msg.id}
                            id={`msg-${msg.id}`}
                            flexDirection="column"
                            width="100%"
                          >
                            {msg.id === firstDimmedMessageId && (
                              <box marginTop={1} height={1} paddingX={1}>
                                <text fg={dimmedReason === "viewing" ? t.textMuted : t.warning}>
                                  {dimmedReason === "viewing"
                                    ? `${icon("rewind")} Viewing checkpoint #${String(checkpointViewing)}, send a message to rewind here.`
                                    : `${icon("rewind")} Rewound past this point.`}
                                </text>
                              </box>
                            )}
                            <StaticMessage
                              msg={msg}
                              chatStyle={chatStyle}
                              diffStyle={effectiveConfig.diffStyle}
                              collapseDiffs={effectiveConfig.collapseDiffs === true}
                              showReasoning={showReasoning}
                              reasoningExpanded={reasoningExpanded}
                              animate={false}
                              tabVerbose={tabVerbose}
                              dimmed={dimmedMessageIds.has(msg.id)}
                              verbose={effectiveConfig.verbose === true}
                            />
                          </box>
                        ))}
                        {isStreaming && (
                          <box paddingX={1} flexShrink={0} marginBottom={1}>
                            <box
                              flexDirection="column"
                              border={["left"]}
                              borderColor={t.brand}
                              customBorderChars={RAIL_BORDER}
                              paddingLeft={2}
                            >
                              <box>
                                <text fg={t.brand}>{icon("ai")} Baked</text>
                              </box>
                              {tabVerbose ? (
                                <StreamSegmentList
                                  segments={chat.streamSegments}
                                  toolCalls={chat.liveToolCalls}
                                  streaming={chat.isLoading}
                                  verbose={effectiveConfig.verbose === true}
                                  diffStyle={effectiveConfig.diffStyle}
                                  showReasoning={showReasoning}
                                  reasoningExpanded={reasoningExpanded}
                                />
                              ) : (
                                <FinalResponseLiveAutoView
                                  segments={chat.streamSegments}
                                  liveToolCalls={chat.liveToolCalls}
                                  loadingStartedAt={loadingStartedAtRef.current}
                                  messagesLength={chat.messages.length}
                                  finalResponseCalled={chat.finalResponseCalled}
                                  showReasoning={showReasoning}
                                  reasoningExpanded={reasoningExpanded}
                                />
                              )}
                            </box>
                          </box>
                        )}
                      </ReasoningExpandedProvider>
                    </VerboseProvider>
                  </CodeExpandedProvider>
                </ExpandToggleProvider>
                <LoadingStatus
                  isLoading={chat.isLoading}
                  isCompacting={chat.isCompacting}
                  loadingStartedAt={loadingStartedAtRef.current}
                  width={Math.max(
                    20,
                    (termWidth ?? 80) -
                      (changesExpanded ? Math.floor((termWidth ?? 80) * 0.2) : 0) -
                      4,
                  )}
                />
              </scrollbox>
            </AnimatedBorder>
            {checkpoints.length >= 1 && (
              <CheckpointRail
                checkpoints={checkpoints}
                viewing={checkpointViewing}
                isLoading={chat.isLoading}
              />
            )}
          </box>
        )}
        {changesExpanded && (
          <box flexDirection="column" width="20%">
            <ChangesPanel messages={chat.messages} cwd={cwd} stats={diffStats} />
          </box>
        )}
      </box>

      {chat.pendingPlanReview ? (
        <box flexShrink={0} paddingX={1}>
          <PlanReviewPrompt
            isActive={isFocused}
            plan={chat.pendingPlanReview.plan}
            planFile={chat.pendingPlanReview.planFile}
            onAccept={onAcceptPlan}
            onClearAndImplement={onClearAndImplementPlan}
            onRevise={onRevisePlan}
            onCancel={onCancelPlan}
          />
        </box>
      ) : chat.pendingQuestion ? (
        <>
          <box flexShrink={0} paddingX={1}>
            <QuestionPrompt question={chat.pendingQuestion} isActive={isFocused} />
          </box>
          {showPlanProgress && chat.activePlan && (
            <box flexShrink={0} paddingX={1}>
              <PlanProgress plan={chat.activePlan} tasks={tasks} />
            </box>
          )}
          {!showPlanProgress && tasks.length > 0 && (
            <box flexShrink={0} paddingX={1}>
              <TaskProgress tabId={tabId} />
            </box>
          )}
          {hasChangedFiles && (
            <box flexShrink={0} paddingX={1}>
              <ChangedFilesBar messages={chat.messages} stats={diffStats} />
            </box>
          )}
        </>
      ) : (
        <>
          {showPlanProgress && chat.activePlan && (
            <box flexShrink={0} paddingX={1}>
              <PlanProgress plan={chat.activePlan} tasks={tasks} />
            </box>
          )}
          {!showPlanProgress && tasks.length > 0 && (
            <box flexShrink={0} paddingX={1}>
              <TaskProgress tabId={tabId} />
            </box>
          )}
          {(hasChangedFiles || chat.messageQueue.length > 0) && (
            <box flexShrink={0} paddingX={1} flexDirection="row" gap={1} height={1}>
              {hasChangedFiles && <ChangedFilesBar messages={chat.messages} stats={diffStats} />}
              {chat.messageQueue.length > 0 &&
                (() => {
                  const last = chat.messageQueue[chat.messageQueue.length - 1];
                  const latest = last?.options?.display ?? last?.content ?? "";
                  const firstLine = latest.split("\n")[0] ?? "";
                  const extraLines = latest.split("\n").length - 1;
                  const prevCount = chat.messageQueue.length - 1;
                  return (
                    <text fg={t.warning} truncate>
                      │ Steering: {firstLine}
                      {extraLines > 0 && (
                        <span fg={t.textMuted}> (+{String(extraLines)} lines)</span>
                      )}
                      {prevCount > 0 && (
                        <span fg={t.textMuted}> (+{String(prevCount)} queued)</span>
                      )}
                    </text>
                  );
                })()}
            </box>
          )}
          <box
            flexShrink={0}
            zIndex={10}
            alignItems={transition.phase !== "chat" ? "center" : undefined}
          >
            <box
              width={
                transition.phase === "chat"
                  ? "100%"
                  : (`${String(Math.round(transition.inputWidthPct))}%` as `${number}%`)
              }
              flexShrink={0}
            >
              <InputBox
                tabId={tabId}
                onSubmit={handleInputSubmit}
                isLoading={chat.isLoading}
                isCompacting={chat.isCompacting}
                isFocused={isFocused}
                cwd={cwd}
                onExit={onExit}
                widthPct={transition.phase === "chat" ? undefined : transition.inputWidthPct}
                onQueue={(msg, images) =>
                  chat.setMessageQueue((prev) =>
                    prev.length >= 5
                      ? prev
                      : [...prev, { content: msg, queuedAt: Date.now(), images }],
                  )
                }
                onCycleTab={onCycleTab}
                viewingCheckpoint={checkpointViewing}
                getRepoMap={getRepoMap}
                onNotice={(content) =>
                  chat.setMessages((prev) => [
                    ...prev,
                    { id: crypto.randomUUID(), role: "system", content, timestamp: Date.now() },
                  ])
                }
              />
            </box>
          </box>
        </>
      )}
    </box>
  );
});
