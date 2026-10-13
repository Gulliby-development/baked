import { join } from "node:path";
import type { Selection } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  applyConfigPatch,
  mergeConfigs,
  removeGlobalConfigKeys,
  removeProjectConfigKeys,
  saveGlobalConfig,
  saveProjectConfig,
  stripConfigKeys,
} from "../config/index.js";
import { setTerminalHandoff } from "../core/chat/external-editor.js";
import { openProjectPicker } from "../core/commands/projects.js";
import { handleCommand } from "../core/commands/registry.js";
import { ContextManager } from "../core/context/manager.js";
import { getWorkspaceCoordinator } from "../core/coordination/WorkspaceCoordinator.js";
import { providerIcon, UI_ICONS } from "../core/icons.js";
import { runIntelligenceHealthCheck } from "../core/intelligence/index.js";
import {
  fetchGroupedModels,
  fetchProviderModels,
  getShortModelLabel,
  PROVIDER_CONFIGS,
} from "../core/llm/models.js";
import { notifyProviderSwitch } from "../core/llm/provider.js";
import { soleReadyModel } from "../core/llm/ready-model.js";
import { disposeMCPManager, getMCPManager } from "../core/mcp/index.js";
import { projectSwitchArgs } from "../core/restart.js";
import { initForbidden } from "../core/security/forbidden.js";
import { SessionManager } from "../core/sessions/manager.js";
import { getMissingRequired } from "../core/setup/prerequisites.js";
import { useTheme } from "../core/theme/index.js";
import { restoreSessionImages } from "../core/tools/show-image.js";
import {
  artPalette,
  BUN_HEIGHT,
  brandChipCells,
  bunRows,
  LOCKUP_WIDTH,
  lockupRows,
  ovenMarkCells,
  SLAB_HEIGHT,
  SLAB_WIDTH,
  slabRows,
} from "../core/utils/bake-art.js";
import { setMotion } from "../core/utils/motion.js";
import { CURRENT_VERSION } from "../core/version.js";
import { getModeColor, getModeLabel } from "../hooks/useBakeMode.js";
import type { ChatInstance, WorkspaceSnapshot } from "../hooks/useChat.js";
import { useConfigSync } from "../hooks/useConfigSync.js";
import { coordinatorFor, stopCoordinators } from "../hooks/useCoordinator.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useGlobalKeyboard } from "../hooks/useGlobalKeyboard.js";
import { buildTabMeta } from "../hooks/useSessionBuilder.js";
import { useTabs } from "../hooks/useTabs.js";
import { useTerminalDimensions } from "../hooks/useTerminalEvents.js";
import { stopWorkflowSessions } from "../hooks/useWorkflow.js";
import { cleanupAndExit, hardRestart, restart, setExitSessionId } from "../index.js";
import { useCheckpointStore } from "../stores/checkpoints.js";
import { useDialogStore } from "../stores/dialog.js";
import { logBackgroundError } from "../stores/errors.js";
import { startMemoryPoll } from "../stores/statusbar.js";
import { useToolsStore } from "../stores/tools.js";
import { type ModalName, selectIsAnyModalOpen, useUIStore } from "../stores/ui.js";
import { useWatchStore } from "../stores/watch.js";
import type { AppConfig, ChatEffort, ChatMessage, TaskRouter } from "../types/index.js";
import { copyOsc52, copyToClipboard as nativeCopyToClipboard } from "../utils/clipboard.js";
import { artText } from "./brand/artText.js";
import { CoordinatorView } from "./coordinator/CoordinatorView.js";
import { ContextBar } from "./layout/ContextBar.js";
import { isCompactTerminal } from "./layout/compact.js";
import { Footer } from "./layout/Footer.js";
import { ProjectIndicator } from "./layout/ProjectIndicator.js";
import type { ConfigScope } from "./layout/shared.js";
import { TabBar } from "./layout/TabBar.js";
import { TabInstance } from "./layout/TabInstance.js";
import { TokenDisplay } from "./layout/TokenDisplay.js";
import { SimpleModalLayer } from "./ModalLayer.js";
import { CommandPalette } from "./modals/CommandPalette.js";
import { CommandPicker } from "./modals/CommandPicker.js";
import { DiagnosePopup } from "./modals/DiagnosePopup.js";
import { FirstRunWizard } from "./modals/FirstRunWizard.js";
import { GitCommitModal } from "./modals/GitCommitModal.js";
import { GitMenu } from "./modals/GitMenu.js";
import { InfoPopup } from "./modals/InfoPopup.js";
import { LlmSelector } from "./modals/LlmSelector.js";
import { SessionPicker } from "./modals/SessionPicker.js";
import { StatusDashboard } from "./modals/StatusDashboard.js";
import { TabNamePopup } from "./modals/TabNamePopup.js";
import { LspInstallSearch } from "./settings/LspInstallSearch.js";
import { MCPSettings } from "./settings/MCPSettings.js";
import { ModelEventsPopup } from "./settings/ModelEventsPopup.js";
import { ProviderSettings } from "./settings/ProviderSettings.js";
import { RepoMapStatusPopup } from "./settings/RepoMapStatusPopup.js";
import { RouterSettings } from "./settings/RouterSettings.js";
import { SkillSearch } from "./settings/SkillSearch.js";
import { ToolsPopup } from "./settings/ToolsPopup.js";
import { WorkflowIndicator } from "./workflow/WorkflowIndicator.js";
import { WorkflowPanel } from "./workflow/WorkflowPanel.js";

startMemoryPoll();

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

const ABORT_ON_LOADING = new Set([
  "/clear",
  "/compact",
  "/plan",
  "/session clear",
  "/session compact",
  "/session plan",
]);

const DEFAULT_TASK_ROUTER: TaskRouter = {
  spark: null,
  ember: null,
  webSearch: null,
  desloppify: null,
  verify: null,
  compact: null,
  semantic: null,
  default: null,
};

const SHUTDOWN_STEPS = [
  "Stopping active work",
  "Saving the session",
  "Closing the project",
  "See you next bake",
];

/** Exit screen: the BAKED slab over the bun falling asleep, then the saving steps. */
function ShutdownSplash({
  phase,
  sessionId,
  height,
}: {
  phase: number;
  sessionId: string | null;
  height: number;
}) {
  const shortId = sessionId?.slice(0, 8);
  const t = useTheme();
  const { width: termWidth } = useTerminalDimensions();
  const palette = artPalette(t);
  const roomy = (termWidth ?? 80) >= SLAB_WIDTH + 2 && height >= SLAB_HEIGHT + BUN_HEIGHT + 8;
  // The bun closes its eyes once the session is saved.
  const face = phase >= 1 ? "sleep" : "blink";

  return (
    <box flexDirection="column" height={height} justifyContent="center" alignItems="center">
      {roomy ? (
        <>
          <text
            wrapMode="none"
            content={artText(
              ((termWidth ?? 80) >= LOCKUP_WIDTH + 2 ? lockupRows : slabRows)(
                { letters: 5, pressed: false },
                palette,
              ),
            )}
          />
          <box height={1} />
          <text
            wrapMode="none"
            content={artText(bunRows({ bake: 1, rise: 1, face, steam: null }, palette))}
          />
        </>
      ) : (
        <text wrapMode="none" content={artText([ovenMarkCells(palette)])} />
      )}
      <box height={1} />
      <box
        flexDirection="column"
        gap={0}
        alignItems="flex-start"
        height={SHUTDOWN_STEPS.length + 3}
      >
        {SHUTDOWN_STEPS.map((label, i) => {
          if (i > phase) return null;
          const active = i === phase;
          return (
            <text key={label}>
              <span fg={active ? t.brand : t.textFaint}>{active ? "■" : "□"}</span>
              <span fg={active ? t.textPrimary : t.textFaint}> {label}</span>
            </text>
          );
        })}
        {shortId && phase >= 3 && (
          <>
            <box height={1} />
            <text>
              <span fg={t.textMuted}>resume </span>
              <span fg={t.brand}>baked --session {shortId}</span>
            </text>
          </>
        )}
      </box>
    </box>
  );
}

import { getCwd } from "../core/cwd.js";
import {
  getCachedProviderStatuses,
  type ProviderStatus,
  subscribeProviderStatuses,
} from "../core/llm/provider.js";
import { IS_WIN } from "../core/platform/index.js";
import type { PrerequisiteStatus } from "../core/setup/prerequisites.js";
import { useCopySelection } from "../hooks/useCopySelection.js";
import { getAppSessionId, setAppSessionId } from "../stores/session.js";
import { MemoryBrowser } from "./modals/MemoryBrowser.js";
import { DialogHost } from "./ui/DialogHost.js";
import { Chip } from "./ui/KeyCap.js";

interface Props {
  config: AppConfig;
  projectConfig?: Partial<AppConfig> | null;
  resumeSessionId?: string;
  forceWizard?: boolean;
  /** Open the coordinator on start: a project opens on its coordinator. */
  startOnCoordinator?: boolean;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  preloadedContextManager?: ContextManager;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal protocol responses
const KITTY_PROTOCOL_RESPONSE_RE = /\x1b\[\?\d+u/g;

function CheckpointLegend({ tabId, fallbackSpacer }: { tabId: string; fallbackSpacer?: boolean }) {
  const t = useTheme();
  const count = useCheckpointStore((s) => s.tabs[tabId]?.checkpoints?.length ?? 0);
  if (count <= 1) return fallbackSpacer ? <box height={1} flexShrink={0} /> : null;
  return (
    <box
      flexShrink={0}
      height={1}
      paddingX={1}
      flexDirection="row"
      justifyContent="flex-end"
      flexGrow={1}
    >
      <text fg={t.textDim}>
        <span fg={t.brand}>◆</span> latest
        <span fg={t.textFaint}> │ </span>
        <span fg={t.warning}>●</span> viewing
        <span fg={t.textFaint}> │ </span>
        <span fg={t.textMuted}>●</span> edits
        <span fg={t.textFaint}> │ </span>
        <span fg={t.textFaint}>○</span> read
        <span fg={t.textFaint}> │ </span>
        <span fg={t.textMuted}>^B</span>/<span fg={t.textMuted}>^F</span> navigate
      </text>
    </box>
  );
}

export function App({
  config,
  projectConfig,
  resumeSessionId,
  forceWizard,
  startOnCoordinator,
  bootProviders,
  bootPrereqs,
  preloadedContextManager,
}: Props) {
  const renderer = useRenderer();
  const { height: termHeight, width: termWidth } = useTerminalDimensions();
  // `useTheme()` reads `state.tokens` — when `setTheme()` replaces the tokens
  // object zustand fires a subscriber update, so the App rerenders on theme
  // change without a second subscription to `state.name`.
  const t = useTheme();
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>(() => {
    return getCachedProviderStatuses() ?? bootProviders;
  });
  const [shutdownPhase, setShutdownPhase] = useState(-1);
  const savedSessionIdRef = useRef<string | null>(null);

  // Commands that open $EDITOR (such as `/instructions edit`) hand the terminal over through this.
  useEffect(
    () =>
      setTerminalHandoff({
        suspend: () => renderer.suspend(),
        resume: () => {
          renderer.resume();
          renderer.requestRender();
        },
      }),
    [renderer],
  );

  useEffect(() => {
    const stdin = process.stdin;
    const originalRead = stdin.read.bind(stdin);
    const patchedRead = (size?: number) => {
      const chunk = originalRead(size);
      if (chunk === null) return null;
      const str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");
      KITTY_PROTOCOL_RESPONSE_RE.lastIndex = 0;
      if (!KITTY_PROTOCOL_RESPONSE_RE.test(str)) return chunk;
      const cleaned = str.replace(KITTY_PROTOCOL_RESPONSE_RE, "");
      if (cleaned.length === 0) return null;
      if (typeof chunk === "string") return cleaned;
      return Buffer.from(cleaned, "utf-8");
    };
    stdin.read = patchedRead as typeof stdin.read;
    return () => {
      stdin.read = originalRead;
    };
  }, []);

  const copyToClipboard = useCallback(
    (text: string) => {
      // Emit OSC-52 (covers SSH / remote terminals) AND write natively
      // (pbcopy/xclip/wl-copy/clip). Doing both unconditionally — like
      // opencode — because OSC-52 is silently ignored by many terminals
      // even when capability detection claims support, so relying on the
      // OSC-52 return value to gate the native fallback loses the copy.
      // Renderer OSC-52 no-ops when capability detection missed osc52
      // support (common over SSH) — fall back to raw escape on stdout.
      if (!renderer.copyToClipboardOSC52(text)) copyOsc52(text);
      nativeCopyToClipboard(text);
    },
    [renderer],
  );

  useEffect(() => {
    setProviderStatuses(getCachedProviderStatuses() ?? bootProviders);
  }, [bootProviders]);

  useEffect(() => subscribeProviderStatuses(setProviderStatuses), []);

  useEffect(() => {
    if (IS_WIN) return;
    const onSelection = (sel: Selection) => {
      const text = sel.getSelectedText();
      if (text) copyToClipboard(text);
    };
    renderer.on("selection", onSelection);
    return () => {
      renderer.off("selection", onSelection);
    };
  }, [renderer, copyToClipboard]);

  const {
    copySelection,
    onMouseDown: onRootMouseDown,
    onMouseUp: onRootMouseUp,
  } = useCopySelection();

  useEffect(() => {}, []);

  const [globalConfig, setGlobalConfig] = useState<AppConfig>(config);
  const [projConfig, setProjConfig] = useState<Partial<AppConfig> | null>(projectConfig ?? null);
  const [routerScope, setRouterScope] = useState<ConfigScope>(() =>
    projectConfig && "taskRouter" in projectConfig ? "project" : "global",
  );
  const modelScope = useMemo(
    () =>
      projConfig && "defaultModel" in projConfig
        ? ("project" as ConfigScope)
        : ("global" as ConfigScope),
    [projConfig],
  );
  const effectiveConfig = useMemo(
    () => mergeConfigs(globalConfig, projConfig),
    [globalConfig, projConfig],
  );
  useEffect(() => setMotion(effectiveConfig.motion), [effectiveConfig.motion]);

  const tabMgr = useTabs((survivingIds) => {
    // A tab was closed — immediately drop it from the on-disk session so it
    // can't reappear on the next restore. Best-effort; failures are non-fatal.
    const sm = sessionManagerRef.current;
    const sid = getAppSessionId();
    if (sm && sid) sm.pruneTabsNotIn(sid, survivingIds).catch(() => {});
  });
  const tabMgrRef = useRef(tabMgr);
  tabMgrRef.current = tabMgr;
  // Ref so the closeTab callback (created above) can reach sessionManager,
  // which is declared later — avoids a TDZ on the const binding.
  const sessionManagerRef = useRef<SessionManager | null>(null);

  // Mirror the active tab + activity into the terminal window title.
  // Truncates long labels so OS title bars stay readable.
  useEffect(() => {
    const activity = tabMgr.getTabActivity(tabMgr.activeTabId);
    const label = tabMgr.activeTab.label;
    const truncated = label.length > 40 ? `${label.slice(0, 37)}…` : label;
    const marker = activity.isLoading || activity.isCompacting ? "● " : "";
    try {
      renderer.setTerminalTitle(`${marker}baked · ${truncated}`);
    } catch {}
  }, [renderer, tabMgr.activeTabId, tabMgr.activeTab.label, tabMgr]);

  // Kick the renderer after layout-affecting transitions to prevent stale paints.
  // requestRender() is a no-op if nothing is dirty — safe to call.
  const reasoningExpanded = useUIStore((s) => s.reasoningExpanded);
  const codeExpanded = useUIStore((s) => s.codeExpanded);
  const hasTabBar = tabMgr.tabCount > 1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on layout transitions, not just renderer change
  useEffect(() => {
    renderer.requestRender();
  }, [reasoningExpanded, codeExpanded, hasTabBar, renderer]);

  const { routerSlotPicking, commandPickerConfig, infoPopupConfig } = useUIStore(
    useShallow((s) => ({
      routerSlotPicking: s.routerSlotPicking,
      commandPickerConfig: s.commandPickerConfig,
      infoPopupConfig: s.infoPopupConfig,
    })),
  );

  const modalLlmSelector = useUIStore((s) => s.modals.llmSelector);
  const modalGitCommit = useUIStore((s) => s.modals.gitCommit);
  const modalGitMenu = useUIStore((s) => s.modals.gitMenu);
  const modalSessionPicker = useUIStore((s) => s.modals.sessionPicker);
  const modalSkillSearch = useUIStore((s) => s.modals.skillSearch);
  const modalLspInstall = useUIStore((s) => s.modals.lspInstall);
  const modalProviderSettings = useUIStore((s) => s.modals.providerSettings);
  const modalRouterSettings = useUIStore((s) => s.modals.routerSettings);
  const modalCommandPicker = useUIStore((s) => s.modals.commandPicker);
  const modalCommandPalette = useUIStore((s) => s.modals.commandPalette);
  const modalInfoPopup = useUIStore((s) => s.modals.infoPopup);
  const modalWorkflow = useUIStore((s) => s.modals.workflow);
  const modalDiagnose = useUIStore((s) => s.modals.diagnosePopup);
  const modalStatusDashboard = useUIStore((s) => s.modals.statusDashboard);
  const modalModelEvents = useUIStore((s) => s.modals.modelEvents);
  const modalToolsPopup = useUIStore((s) => s.modals.toolsPopup);
  const modalMCPSettings = useUIStore((s) => s.modals.mcpSettings);
  const modalFirstRunWizard = useUIStore((s) => s.modals.firstRunWizard);
  const modalTabNamePopup = useUIStore((s) => s.modals.tabNamePopup);
  const modalCoordinator = useUIStore((s) => s.modals.coordinator);
  const modalMemoryBrowser = useUIStore((s) => s.modals.memoryBrowser);
  const toolsState = useToolsStore();

  // Init tools store from config and persist changes
  useEffect(() => {
    toolsState.initFromConfig(effectiveConfig.disabledTools);
  }, [effectiveConfig.disabledTools, toolsState.initFromConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveGlobalConfig({ disabledTools: [...toolsState.disabledTools] });
  }, [toolsState.disabledTools]);
  const statusDashboardTab = useUIStore((s) => s.statusDashboardTab);
  const modalRepoMapStatus = useUIStore((s) => s.modals.repoMapStatus);
  const isModalOpen = useUIStore(selectIsAnyModalOpen);

  const wizardOpenedLlm = useRef(false);
  const closerCache = useRef<Partial<Record<ModalName, () => void>>>({});
  const getCloser = (name: ModalName) =>
    (closerCache.current[name] ??= () => useUIStore.getState().closeModal(name));

  useEffect(() => {
    if (getMissingRequired().length > 0) {
      useUIStore.getState().openModal("setup");
    } else if (forceWizard || (!config.onboardingComplete && !resumeSessionId)) {
      useUIStore.getState().openModal("firstRunWizard");
    } else if (startOnCoordinator) {
      useUIStore.getState().openModal("coordinator");
    }
  }, [config.onboardingComplete, forceWizard, resumeSessionId, startOnCoordinator]);

  const cwd = getCwd();

  const saveToScope = useCallback(
    (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => {
      if (toScope === "global") {
        saveGlobalConfig(patch);
        setGlobalConfig((prev) => applyConfigPatch(prev, patch));
      } else if (toScope === "project") {
        saveProjectConfig(cwd, patch);
        setProjConfig((prev) => applyConfigPatch(prev ?? {}, patch));
      }

      if (fromScope && fromScope !== toScope) {
        const keys = Object.keys(patch);
        if (fromScope === "global") {
          removeGlobalConfigKeys(keys);
          setGlobalConfig((prev) => stripConfigKeys(prev, keys));
        }
        if (fromScope === "project") {
          removeProjectConfigKeys(cwd, keys);
          setProjConfig((prev) => (prev ? stripConfigKeys(prev, keys) : prev));
        }
      }
    },
    [cwd],
  );

  const detectScope = useCallback(
    (key: string): ConfigScope => {
      if (projConfig && key in projConfig) return "project";
      return "global";
    },
    [projConfig],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init
  useEffect(() => {
    initForbidden(cwd);
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.grouped) fetchGroupedModels(cfg.id).catch(() => {});
      else fetchProviderModels(cfg.id).catch(() => {});
    }
  }, []);

  const contextManager = useMemo(
    () => preloadedContextManager ?? new ContextManager(cwd),
    [cwd, preloadedContextManager],
  );
  const sessionManager = useMemo(() => new SessionManager(cwd), [cwd]);
  sessionManagerRef.current = sessionManager;

  const mcpManager = useMemo(() => getMCPManager(), []);

  // MCP lifecycle: connectAll is idempotent and serialized — safe to call on every config change.
  // It handles connect, disconnect, enable, disable, edit, and removal.
  useEffect(() => {
    mcpManager.connectAll(effectiveConfig.mcpServers ?? []);
  }, [mcpManager, effectiveConfig.mcpServers]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      disposeMCPManager();
    };
  }, []);

  const git = useGitStatus(cwd);
  const [bakeMode, setBakeModeHeader] = useState<import("../types/index.js").BakeMode>("default");
  const modeLabel = getModeLabel(bakeMode);
  const modeColor = getModeColor(bakeMode);
  const watching = useWatchStore((s) => s.tabId !== null);

  useConfigSync({
    effectiveConfig,
    contextManager,
    cwd,
  });

  const sharedResources = useMemo(
    () => ({
      ...contextManager.getSharedResources(),
      workspaceCoordinator: getWorkspaceCoordinator(),
    }),
    [contextManager],
  );

  const workspaceSnapshotRef = useRef<(() => WorkspaceSnapshot) | null>(null);
  workspaceSnapshotRef.current = () => ({
    tabStates: tabMgr.getAllTabStates(),
    activeTabId: tabMgr.activeTabId,
  });

  const addSystemMessage = useCallback((msg: string) => {
    const activeChat = tabMgrRef.current?.getActiveChat();
    activeChat?.setMessages((prev: ChatMessage[]) => [
      ...prev,
      { id: crypto.randomUUID(), role: "system" as const, content: msg, timestamp: Date.now() },
    ]);
  }, []);

  const refreshGit = useCallback(() => {
    git.refresh();
  }, [git]);

  const shutdownPhaseRef = useRef(shutdownPhase);
  shutdownPhaseRef.current = shutdownPhase;
  const exitTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const handleCycleTab = useCallback(
    (direction: 1 | -1) => {
      if (tabMgr.tabCount <= 1) return;
      if (direction === 1) tabMgr.nextTab();
      else tabMgr.prevTab();
    },
    [tabMgr.tabCount, tabMgr.nextTab, tabMgr.prevTab],
  );

  /** Arguments to run BAKED again with after the shutdown saved the session; null exits. */
  const relaunchArgsRef = useRef<string[] | null>(null);

  const handleExit = useCallback(() => {
    if (shutdownPhaseRef.current >= 0) return;
    setShutdownPhase(0);

    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      exitTimersRef.current.push(t);
      return t;
    };

    schedule(() => {
      for (const tab of tabMgrRef.current.tabs) {
        tabMgrRef.current.getChat(tab.id)?.abort();
      }
      setShutdownPhase(1);

      schedule(async () => {
        try {
          await stopCoordinators();
          await stopWorkflowSessions();
          const sid = getAppSessionId();
          const liveTabs = tabMgrRef.current.tabs;
          const activeChat = tabMgrRef.current.getActiveChat();
          const activeTabId = tabMgrRef.current.activeTabId;
          const anyContent = liveTabs.some((t) => {
            const c = tabMgrRef.current.getChat(t.id);
            return c?.messages.some(
              (m: ChatMessage) => m.role === "user" || m.role === "assistant",
            );
          });
          if (anyContent) {
            // Per-tab save: each registered chat writes its own slice via
            // saveTab, which splice-merges into the shared session dir
            // without clobbering siblings. Saves are serialized per-session
            // inside saveTab so the loop is safe.
            const liveIds = new Set(liveTabs.map((t) => t.id));
            const fallbackTitle =
              activeChat?.customTitle ?? SessionManager.deriveTitle(activeChat?.messages ?? []);
            for (const tab of liveTabs) {
              const chat = tabMgrRef.current.getChat(tab.id);
              if (!chat) continue;
              const filtered = chat.messages.filter(
                (m: ChatMessage) => m.role !== "system" || m.showInChat,
              );
              const { tabMeta } = buildTabMeta({
                tabId: tab.id,
                tabLabel: tab.label,
                activeModel: chat.activeModel,
                sessionId: sid,
                planMode: chat.planMode,
                planRequest: chat.planRequest,
                coAuthorCommits: chat.coAuthorCommits,
                bakeMode: chat.bakeMode,
                effort: chat.effort,
                tokenUsage: chat.tokenUsage,
                messages: filtered,
                coreMessages: chat.coreMessages,
              });
              await sessionManager.saveTab(sid, tabMeta, filtered, chat.coreMessages, {
                title: fallbackTitle,
                customTitle: activeChat?.customTitle ?? null,
                cwd,
                bakeMode: activeChat?.bakeMode ?? "default",
                activeTabId,
              });
            }
            // Prune any on-disk tabs not in the live set (e.g. tabs closed
            // this session). Best-effort — failures are non-fatal.
            try {
              await sessionManager.pruneTabsNotIn(sid, liveIds);
            } catch {}
            setExitSessionId(sid);
            savedSessionIdRef.current = sid;
          }
        } catch (err) {
          logBackgroundError(
            "shutdown",
            `session save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setShutdownPhase(2);

        schedule(() => {
          setShutdownPhase(3);
          schedule(() => {
            renderer.destroy();
            try {
              contextManager.dispose();
              getWorkspaceCoordinator().releaseAllGlobal();
            } catch (err) {
              logBackgroundError(
                "shutdown",
                `dispose failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            const relaunchArgs = relaunchArgsRef.current;
            if (relaunchArgs) hardRestart(relaunchArgs);
            else cleanupAndExit(0);
          }, 1000);
        }, 350);
      }, 300);
    }, 250);
  }, [cwd, sessionManager, contextManager, renderer]);

  const hasRestoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time restore on mount
  useEffect(() => {
    if (hasRestoredRef.current || !resumeSessionId) return;
    hasRestoredRef.current = true;

    const fullId = sessionManager.findByPrefix(resumeSessionId);
    if (!fullId) {
      addSystemMessage(`Session not found: ${resumeSessionId}`);
      return;
    }

    const data = sessionManager.loadSession(fullId);
    if (data) {
      // Adopt loaded session id BEFORE restoreFromMeta so freshly mounted
      // TabInstances see the right app session id on first render.
      setAppSessionId(data.meta.id);
      tabMgr.restoreFromMeta(
        data.meta.tabs,
        data.meta.activeTabId,
        data.tabMessages,
        data.tabCoreMessages,
      );
      setBakeModeHeader(data.meta.bakeMode);
      setExitSessionId(data.meta.id);
      // Restore checkpoint git tags from saved session (synchronous — must run
      // before React renders TabInstance, which triggers syncFromMessages)
      for (const tab of data.meta.tabs) {
        if (tab.checkpointTags?.length || tab.redoTurns?.length) {
          useCheckpointStore
            .getState()
            .restoreTagsFromMeta(tab.id, tab.checkpointTags ?? [], tab.redoTurns);
        }
      }
      // Restore custom title if user renamed this session
      setTimeout(() => {
        if (data.meta.customTitle) {
          tabMgr.getChat(data.meta.activeTabId)?.setCustomTitle(data.meta.customTitle);
        }
        const allMessages = [...data.tabMessages.values()].flat();
        restoreSessionImages(allMessages, cwd)
          .then((restored) => {
            if (restored > 0) {
              // Force React re-render — the objects were mutated in-place
              for (const tab of data.meta.tabs) {
                tabMgr.getChat(tab.id)?.setMessages((prev) => [...prev]);
              }
            }
          })
          .catch(() => {});
      }, 100);
    }
  }, []);

  const [activeModelForHeader, setActiveModelForHeader] = useState(effectiveConfig.defaultModel);
  const [effortHeader, setEffortHeader] = useState<ChatEffort>("default");
  const activeChatRef = useRef<ChatInstance | null>(null);
  // The coordinator's new runs use the model the current tab uses.
  const coordinatorModelRef = useRef(activeModelForHeader);
  coordinatorModelRef.current = activeModelForHeader;
  const openCoordinator = useCallback(
    () => coordinatorFor(cwd, () => coordinatorModelRef.current),
    [cwd],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from activeTabId — stable trigger
  useEffect(() => {
    const chat = tabMgr.getActiveChat();
    activeChatRef.current = chat;
    if (chat) {
      setActiveModelForHeader(chat.activeModel);
      setBakeModeHeader(chat.bakeMode);
      setEffortHeader(chat.effort);
      const hasContent = chat.messages.some(
        (m: ChatMessage) => m.role === "user" || m.role === "assistant",
      );
      // Use the app-level session id — every tab persists into the same dir
      // so the exit banner always points at the right session regardless of
      // which tab is active.
      setExitSessionId(hasContent ? getAppSessionId() : null);
    }
  }, [tabMgr.activeTabId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run on tab count/active changes
  useEffect(() => {
    if (tabMgr.tabCount <= 1) return;
    (async () => {
      try {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const dir = join(cwd, ".baked");
        await mkdir(dir, { recursive: true });
        const activeChat = tabMgr.getActiveChat();
        const layout = tabMgr.tabs.map((t) => ({
          id: t.id,
          label: t.label,
          activeModel: t.id === tabMgr.activeTabId ? activeChat?.activeModel : undefined,
        }));
        await writeFile(join(dir, "tabs.json"), JSON.stringify(layout, null, 2));
      } catch {}
    })();
  }, [tabMgr.tabCount, tabMgr.activeTabId]);

  const { displayProvider, displayModel } = useMemo(() => {
    const model = activeModelForHeader;
    if (model === "none") {
      return {
        displayProvider: "none",
        displayModel: "Ctrl+L to select",
      };
    }
    const idx = model.indexOf("/");
    return {
      displayProvider: idx >= 0 ? model.slice(0, idx) : "unknown",
      displayModel: idx >= 0 ? model.slice(idx + 1) : model,
    };
  }, [activeModelForHeader]);

  // Surface a one-time notice when a legacy memory DB was rotated aside on
  // first open (Phase 1 schema migration). Skipped after the first tick so
  // re-mounts inside the same process don't re-toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    const memMgr = contextManager.getMemoryManager();
    const { project, global } = memMgr.getLegacyBackupPaths();
    const parts: string[] = [];
    if (project) parts.push(`project: ${project}`);
    if (global) parts.push(`global: ${global}`);
    if (parts.length > 0) {
      addSystemMessage(
        `Legacy memory schema detected — your old DB was preserved at ${parts.join(
          ", ",
        )}. Phase 1 schema is now active in .baked/memory.db.`,
      );
    }
  }, []);

  const restoreSession = useCallback(
    async (sessionId: string) => {
      // 1. Snapshot the current session before swapping so we don't lose
      //    the user's in-progress work. Use per-tab saveTab so each tab's
      //    latest messages land in the right dir.
      try {
        const prevSid = getAppSessionId();
        if (prevSid !== sessionId) {
          const liveTabs = tabMgrRef.current?.tabs ?? [];
          const activeTabId = tabMgrRef.current?.activeTabId ?? "";
          const activeChat = tabMgrRef.current?.getActiveChat();
          const fallbackTitle =
            activeChat?.customTitle ?? SessionManager.deriveTitle(activeChat?.messages ?? []);
          const liveIds = new Set(liveTabs.map((t) => t.id));
          let savedAny = false;
          for (const tab of liveTabs) {
            const chat = tabMgrRef.current?.getChat(tab.id);
            if (!chat) continue;
            const filtered = chat.messages.filter(
              (m: ChatMessage) => m.role !== "system" || m.showInChat,
            );
            const hasContent = filtered.some((m) => m.role === "user" || m.role === "assistant");
            if (!hasContent) continue;
            savedAny = true;
            const { tabMeta } = buildTabMeta({
              tabId: tab.id,
              tabLabel: tab.label,
              activeModel: chat.activeModel,
              sessionId: prevSid,
              planMode: chat.planMode,
              planRequest: chat.planRequest,
              coAuthorCommits: chat.coAuthorCommits,
              bakeMode: chat.bakeMode,
              effort: chat.effort,
              tokenUsage: chat.tokenUsage,
              messages: filtered,
              coreMessages: chat.coreMessages,
            });
            await sessionManager.saveTab(prevSid, tabMeta, filtered, chat.coreMessages, {
              title: fallbackTitle,
              customTitle: activeChat?.customTitle ?? null,
              cwd,
              bakeMode: activeChat?.bakeMode ?? "default",
              activeTabId,
            });
          }
          if (savedAny) {
            try {
              await sessionManager.pruneTabsNotIn(prevSid, liveIds);
            } catch {}
          }
        }
      } catch (err) {
        logBackgroundError(
          "session-switch",
          `pre-switch save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const data = sessionManager.loadSession(sessionId);
      if (data) {
        // 2. Adopt the loaded session id BEFORE restoreFromMeta so freshly
        //    mounted TabInstances see the right app session id on first
        //    render. Avoids the multi-tab loop where each tab tries to
        //    claim its own initialState.sessionId during mount.
        setAppSessionId(data.meta.id);
        tabMgr.restoreFromMeta(
          data.meta.tabs,
          data.meta.activeTabId,
          data.tabMessages,
          data.tabCoreMessages,
        );
        setBakeModeHeader(data.meta.bakeMode);
        setExitSessionId(data.meta.id);
        // Restore checkpoint git tags from saved session (stashed as _pendingTags
        // so syncFromMessages picks them up when it rebuilds checkpoints)
        for (const tab of data.meta.tabs) {
          if (tab.checkpointTags?.length || tab.redoTurns?.length) {
            useCheckpointStore
              .getState()
              .restoreTagsFromMeta(tab.id, tab.checkpointTags ?? [], tab.redoTurns);
          }
        }
        // Restore custom title if user renamed this session
        if (data.meta.customTitle) {
          setTimeout(() => {
            tabMgr.getChat(data.meta.activeTabId)?.setCustomTitle(data.meta.customTitle ?? null);
          }, 0);
        }
        // Defer image restore so chat UI renders first
        setTimeout(() => {
          const allMessages = [...data.tabMessages.values()].flat();
          restoreSessionImages(allMessages, cwd)
            .then((restored) => {
              if (restored > 0) {
                for (const tab of data.meta.tabs) {
                  tabMgr.getChat(tab.id)?.setMessages((prev) => [...prev]);
                }
              }
            })
            .catch(() => {});
        }, 100);
      }
    },
    [cwd, sessionManager, tabMgr],
  );

  // One process works in one folder: switching saves this session like an exit, then runs BAKED
  // again in the other folder.
  const switchProject = useCallback(
    (folder: string, sessionId?: string) => {
      relaunchArgsRef.current = projectSwitchArgs(process.argv.slice(2), folder, sessionId);
      handleExit();
    },
    [handleExit],
  );

  const openProjects = useCallback(() => {
    if (useDialogStore.getState().stack.length) return;
    void openProjectPicker({ cwd, notify: addSystemMessage, switchProject });
  }, [cwd, addSystemMessage, switchProject]);

  const handleNewSession = useCallback(async () => {
    const activeChat = tabMgrRef.current?.getActiveChat();
    const hasContent = activeChat?.messages.some(
      (m: ChatMessage) => m.role === "user" || m.role === "assistant",
    );
    if (hasContent && activeChat) {
      try {
        const sid = getAppSessionId();
        const liveTabs = tabMgrRef.current?.tabs ?? [];
        const activeTabId = tabMgrRef.current?.activeTabId ?? "";
        const liveIds = new Set(liveTabs.map((t) => t.id));
        const fallbackTitle =
          activeChat.customTitle ?? SessionManager.deriveTitle(activeChat.messages);
        for (const tab of liveTabs) {
          const chat = tabMgrRef.current?.getChat(tab.id);
          if (!chat) continue;
          const filtered = chat.messages.filter(
            (m: ChatMessage) => m.role !== "system" || m.showInChat,
          );
          const { tabMeta } = buildTabMeta({
            tabId: tab.id,
            tabLabel: tab.label,
            activeModel: chat.activeModel,
            sessionId: sid,
            planMode: chat.planMode,
            planRequest: chat.planRequest,
            coAuthorCommits: chat.coAuthorCommits,
            bakeMode: chat.bakeMode,
            effort: chat.effort,
            tokenUsage: chat.tokenUsage,
            messages: filtered,
            coreMessages: chat.coreMessages,
          });
          await sessionManager.saveTab(sid, tabMeta, filtered, chat.coreMessages, {
            title: fallbackTitle,
            customTitle: activeChat.customTitle ?? null,
            cwd,
            bakeMode: activeChat.bakeMode,
            activeTabId,
          });
        }
        try {
          await sessionManager.pruneTabsNotIn(sid, liveIds);
        } catch {}
      } catch (err) {
        logBackgroundError(
          "new-session",
          `session save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    restart();
  }, [cwd, sessionManager]);

  const handleTabCommand = useCallback(
    (input: string, chat: ChatInstance) => {
      const cmd = input.trim().toLowerCase().split(/\s+/)[0] ?? "";
      const twoWord = input.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
      if (chat.isLoading && (ABORT_ON_LOADING.has(cmd) || ABORT_ON_LOADING.has(twoWord))) {
        chat.abort();
        chat.setMessageQueue([]);
      }

      if (cmd === "/continue" || twoWord === "/session continue") {
        chat.handleSubmit("Continue from where you left off. Complete any remaining work.");
        return;
      }
      if (
        cmd === "/plan" ||
        input.trim().toLowerCase().startsWith("/plan ") ||
        twoWord === "/session plan" ||
        input.trim().toLowerCase().startsWith("/session plan ")
      ) {
        const desc = input
          .trim()
          .replace(/^\/(session\s+)?plan\s*/i, "")
          .trim();
        if (chat.planMode) {
          chat.setPlanMode(false);
          chat.setPlanRequest(null);
          chat.setBakeMode("default");
          setBakeModeHeader("default");
          chat.setPendingPlanReview(null);
          chat.setMessages((prev: ChatMessage[]) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: "Plan mode OFF",
              timestamp: Date.now(),
            },
          ]);
        } else {
          chat.setPlanMode(true);
          chat.setPlanRequest(desc || null);
          chat.setBakeMode("plan");
          setBakeModeHeader("plan");
          chat.setMessages((prev: ChatMessage[]) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: "Plan mode ON — Baked will research and plan without making changes.",
              timestamp: Date.now(),
            },
          ]);
          if (desc) {
            setTimeout(() => chat.handleSubmit(desc), 0);
          }
        }
        return;
      }
      const uiState = useUIStore.getState();
      handleCommand(input, {
        chat,
        tabMgr,
        exit: handleExit,
        openSkills: () => uiState.openModal("skillSearch"),
        openLspInstall: () => uiState.openModal("lspInstall"),
        openGitCommit: () => uiState.openModal("gitCommit"),
        openSessions: () => uiState.openModal("sessionPicker"),
        resumeSession: restoreSession,
        switchProject,
        newSession: () => handleNewSession(),
        openHelp: () => uiState.openModal("helpPopup"),
        openErrorLog: () => uiState.openModal("errorLog"),
        cwd,
        refreshGit: () => {
          git.refresh();
        },
        setBakeMode: (mode: import("../types/index.js").BakeMode) => {
          chat.setBakeMode(mode);
          setBakeModeHeader(mode);
        },
        setEffort: (effort: ChatEffort) => {
          chat.setEffort(effort);
          setEffortHeader(effort);
        },
        currentMode: chat.bakeMode,
        currentModeLabel: getModeLabel(chat.bakeMode),
        contextManager,
        chatStyle: uiState.chatStyle,
        setChatStyle: uiState.setChatStyle,
        openGitMenu: () => uiState.openModal("gitMenu"),
        verbose: effectiveConfig.verbose === true,
        diffStyle: effectiveConfig.diffStyle ?? "default",
        collapseDiffs: effectiveConfig.collapseDiffs === true,
        compactionStrategy: effectiveConfig.compaction?.strategy ?? "v2",
        showReasoning: uiState.showReasoning,
        setShowReasoning: uiState.setShowReasoning,
        tabVerbose: uiState.verboseByTab[tabMgr.activeTabId] ?? false,
        setTabVerbose: (v) => uiState.setTabVerbose(tabMgr.activeTabId, v),
        watchdog: effectiveConfig.watchdog === true,
        openSetup: () => uiState.openModal("setup"),
        openRouterSettings: () => {
          setRouterScope(detectScope("taskRouter"));
          uiState.openModal("routerSettings");
        },
        openProviderSettings: () => uiState.openModal("providerSettings"),
        openWebSearchSettings: () => uiState.openModal("webSearchSettings"),
        openApiKeySettings: () => uiState.openModal("apiKeySettings"),
        openLspStatus: () => uiState.openModal("lspStatus"),
        openCompactionLog: () => uiState.openModal("compactionLog"),
        openCommandPicker: (pickerConfig) => uiState.openCommandPicker(pickerConfig),
        openInfoPopup: (popupConfig) => uiState.openInfoPopup(popupConfig),
        openMemoryBrowser: () => uiState.openModal("memoryBrowser"),
        toggleChanges: () => uiState.toggleChangesExpanded(),
        saveToScope,
        detectScope,
        agentFeatures: effectiveConfig.agentFeatures,
        instructionFiles: effectiveConfig.instructionFiles,
        syncActiveModel: (modelId: string) => {
          chat.setActiveModel(modelId);
          setActiveModelForHeader(modelId);
        },
      });
    },
    [
      tabMgr,
      handleExit,
      cwd,
      git,
      contextManager,
      effectiveConfig.verbose,
      effectiveConfig.diffStyle,
      effectiveConfig.collapseDiffs,
      effectiveConfig.compaction?.strategy,
      saveToScope,
      detectScope,
      effectiveConfig.agentFeatures,
      effectiveConfig.instructionFiles,
      handleNewSession,
      effectiveConfig.watchdog,
      restoreSession,
      switchProject,
    ],
  );

  const closeLlmSelector = useCallback(() => {
    const wasPickingSlot = useUIStore.getState().routerSlotPicking != null;
    const wasFallbackForModel = useUIStore.getState().fallbackForModel != null;
    const wasFromWizard = wizardOpenedLlm.current;
    useUIStore.getState().closeModal("llmSelector");
    useUIStore.getState().setRouterSlotPicking(null);
    useUIStore.getState().setFallbackForModel(null);
    wizardOpenedLlm.current = false;
    if (wasPickingSlot || wasFallbackForModel) {
      useUIStore.getState().openModal("routerSettings");
    } else if (wasFromWizard) {
      useUIStore.getState().openModal("firstRunWizard");
    }
  }, []);

  const closeInfoPopup = useCallback(() => {
    const cfg = useUIStore.getState().infoPopupConfig;
    useUIStore.getState().closeInfoPopup();
    cfg?.onClose?.();
  }, []);

  const onGitMenuCommit = useCallback(() => {
    useUIStore.getState().closeModal("gitMenu");
    useUIStore.getState().openModal("gitCommit");
  }, []);

  useGlobalKeyboard({
    shutdownPhase,
    handleExit,
    newSession: handleNewSession,
    openProjects,
    renderer,
    copySelection,
    activeChatRef,
    cycleMode: useCallback(() => {
      const chat = tabMgrRef.current?.getActiveChat();
      if (chat) {
        const next = chat.cycleMode();
        setBakeModeHeader(next);
      }
    }, []),
    tabMgr,
  });

  if (shutdownPhase >= 0) {
    return (
      <ShutdownSplash
        phase={shutdownPhase}
        sessionId={savedSessionIdRef.current}
        height={termHeight}
      />
    );
  }

  const anyModalOpen = shutdownPhase >= 0 || isModalOpen;
  const compactLayout = isCompactTerminal(termWidth, termHeight);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: opentui box is the interactive primitive in TUI; a11y rule targets DOM
    <box
      flexDirection="column"
      height={termHeight}
      backgroundColor={t.bgApp}
      onMouseDown={onRootMouseDown}
      onMouseUp={onRootMouseUp}
    >
      <box
        flexShrink={0}
        width="100%"
        paddingX={1}
        justifyContent="space-between"
        height={1}
        flexDirection="row"
      >
        <box flexShrink={0} flexDirection="row" gap={0}>
          <text wrapMode="none" content={artText([brandChipCells(artPalette(t))])} />
          {!compactLayout && <text fg={t.textFaint}> v{CURRENT_VERSION}</text>}
        </box>
        <box gap={1} flexShrink={1} flexDirection="row" justifyContent="center" overflow="hidden">
          <text truncate>
            <span fg={t.textMuted}>{providerIcon(displayProvider)} </span>
            {displayProvider !== displayModel && (
              <>
                <span fg={t.textMuted}>{displayProvider}</span>
                <span fg={t.textDim}>›</span>
              </>
            )}
            <span fg={t.textSecondary}>{truncate(displayModel, compactLayout ? 16 : 28)}</span>
            {effortHeader !== "default" && <span fg={t.textMuted}> · {effortHeader}</span>}
          </text>
          {!compactLayout && <ProjectIndicator cwd={cwd} compact={termWidth < 120} />}
          {git.isRepo && !compactLayout && (
            <>
              <text fg={t.textFaint}>│</text>
              <text fg={git.isDirty ? t.amber : t.success} truncate>
                {UI_ICONS.git} {truncate(git.branch ?? "HEAD", termWidth >= 120 ? 30 : 15)}
                {git.isDirty ? "*" : ""}
              </text>
            </>
          )}
          <text wrapMode="none" flexShrink={0}>
            <Chip label={modeLabel.toUpperCase()} fill={modeColor} />
          </text>
          {watching && (
            <text wrapMode="none" flexShrink={0}>
              <Chip label="WATCHING" fill={t.info} />
            </text>
          )}
          <ContextBar
            contextManager={contextManager}
            modelId={activeModelForHeader}
            suppressCompacting={tabMgr.tabCount > 1}
          />
          {!compactLayout && (
            <>
              <text fg={t.textFaint}>│</text>
              <TokenDisplay />
            </>
          )}
        </box>
      </box>

      {tabMgr.tabCount > 1 ? (
        <box
          key="tab-bar"
          flexShrink={0}
          marginTop={compactLayout ? 0 : 1}
          flexDirection="row"
          flexWrap="wrap"
        >
          <TabBar
            tabs={tabMgr.tabs}
            activeTabId={tabMgr.activeTabId}
            onSwitch={tabMgr.switchTab}
            getActivity={tabMgr.getTabActivity}
            getMode={(id) =>
              id === tabMgr.activeTabId ? bakeMode : (tabMgr.getChat(id)?.bakeMode ?? "default")
            }
            getModelLabel={(id) => {
              const model =
                id === tabMgr.activeTabId
                  ? activeModelForHeader
                  : (tabMgr.getChat(id)?.activeModel ?? null);
              if (!model || model === "none" || model === effectiveConfig.defaultModel) return null;
              return getShortModelLabel(model);
            }}
          />
          {!compactLayout && <CheckpointLegend tabId={tabMgr.activeTabId} />}
        </box>
      ) : compactLayout ? null : (
        <CheckpointLegend tabId={tabMgr.activeTabId} fallbackSpacer />
      )}

      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
        {tabMgr.tabs.map((tab) => (
          <TabInstance
            key={tab.id}
            tabId={tab.id}
            tabLabel={tab.label}
            visible={tab.id === tabMgr.activeTabId}
            effectiveConfig={effectiveConfig}
            sharedResources={sharedResources}
            sessionManager={sessionManager}
            cwd={cwd}
            onCommand={handleTabCommand}
            onModeChange={setBakeModeHeader}
            onModelChange={(modelId) => {
              setActiveModelForHeader(modelId);
            }}
            onExit={handleExit}
            registerChat={tabMgr.registerChat}
            unregisterChat={tabMgr.unregisterChat}
            setTabActivity={tabMgr.setTabActivity}
            initialState={tabMgr.initialStates.current.get(tab.id)}
            anyModalOpen={anyModalOpen}
            bootProviders={providerStatuses}
            bootPrereqs={bootPrereqs}
            onCycleTab={handleCycleTab}
          />
        ))}
      </box>

      <box flexShrink={0} width="100%" flexDirection="column">
        <WorkflowIndicator workspace={getCwd()} panelOpen={modalWorkflow} />
        <Footer />
      </box>

      <LlmSelector
        visible={modalLlmSelector}
        activeModel={(() => {
          const slot = routerSlotPicking;
          const fb = useUIStore.getState().fallbackForModel;
          if (slot) {
            const v = effectiveConfig.taskRouter?.[slot];
            if (typeof v === "string" && v.trim()) return v;
          }
          if (fb) return fb;
          return activeModelForHeader;
        })()}
        onSelect={(modelId) => {
          const slot = useUIStore.getState().routerSlotPicking;
          const fallbackForModel = useUIStore.getState().fallbackForModel;
          if (fallbackForModel) {
            const current = { ...(effectiveConfig.modelFallback ?? {}) };
            const fallbacks = [...(current[fallbackForModel] ?? [])];
            fallbacks.push(modelId);
            current[fallbackForModel] = fallbacks;
            saveToScope({ modelFallback: current }, modelScope);
            closeLlmSelector();
            return;
          }
          if (slot) {
            const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
            const updated = { ...current, [slot]: modelId };
            saveToScope({ taskRouter: updated }, routerScope);
            closeLlmSelector();
          } else {
            activeChatRef.current?.setActiveModel(modelId);
            notifyProviderSwitch(modelId);
            setActiveModelForHeader(modelId);
            saveToScope({ defaultModel: modelId }, modelScope);
            closeLlmSelector();
          }
        }}
        onClose={closeLlmSelector}
      />

      <GitCommitModal
        visible={modalGitCommit}
        cwd={cwd}
        coAuthor={activeChatRef.current?.coAuthorCommits ?? true}
        onClose={getCloser("gitCommit")}
        onCommitted={(msg) => addSystemMessage(`Committed: ${msg}`)}
        onRefresh={refreshGit}
      />

      <GitMenu
        visible={modalGitMenu}
        cwd={cwd}
        onClose={getCloser("gitMenu")}
        onCommit={onGitMenuCommit}
        onSystemMessage={addSystemMessage}
        onRefresh={refreshGit}
      />

      <SessionPicker
        visible={modalSessionPicker}
        cwd={cwd}
        onClose={getCloser("sessionPicker")}
        onRestore={restoreSession}
        onSystemMessage={addSystemMessage}
      />

      <SkillSearch
        visible={modalSkillSearch}
        contextManager={tabMgr.getActiveChat()?.contextManager ?? contextManager}
        onClose={getCloser("skillSearch")}
        onSystemMessage={addSystemMessage}
      />

      <MemoryBrowser
        visible={modalMemoryBrowser}
        contextManager={tabMgr.getActiveChat()?.contextManager ?? contextManager}
        cwd={cwd}
        onClose={getCloser("memoryBrowser")}
        onSystemMessage={addSystemMessage}
      />

      <LspInstallSearch
        visible={modalLspInstall}
        cwd={cwd}
        onClose={getCloser("lspInstall")}
        onSystemMessage={addSystemMessage}
        saveToScope={saveToScope}
        detectScope={detectScope}
        disabledServers={effectiveConfig.disabledLspServers ?? []}
      />

      <ProviderSettings
        visible={modalProviderSettings}
        globalConfig={globalConfig}
        projectConfig={projConfig}
        onUpdate={(patch, toScope, fromScope) => saveToScope(patch, toScope, fromScope)}
        onClose={getCloser("providerSettings")}
      />

      <ToolsPopup
        visible={modalToolsPopup}
        disabledTools={toolsState.disabledTools}
        onToggleTool={toolsState.toggleTool}
        onClose={getCloser("toolsPopup")}
      />

      <MCPSettings
        visible={modalMCPSettings}
        mcpManager={mcpManager}
        globalServers={globalConfig.mcpServers ?? []}
        projectServers={projConfig?.mcpServers ?? []}
        onSave={(servers, scope) => saveToScope({ mcpServers: servers }, scope)}
        onClose={getCloser("mcpSettings")}
      />

      <RouterSettings
        visible={modalRouterSettings && !routerSlotPicking}
        router={effectiveConfig.taskRouter}
        defaultModel={effectiveConfig.defaultModel}
        modelFallback={effectiveConfig.modelFallback}
        activeModel={activeModelForHeader}
        scope={routerScope}
        onScopeChange={(toScope, fromScope) => {
          setRouterScope(toScope);
          if (effectiveConfig.taskRouter) {
            saveToScope({ taskRouter: effectiveConfig.taskRouter }, toScope, fromScope);
          }
        }}
        onPickSlot={(slot) => {
          useUIStore.getState().setRouterSlotPicking(slot);
          useUIStore.getState().openModal("llmSelector");
        }}
        onClearSlot={(slot) => {
          const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
          const updated = { ...current, [slot]: null };
          saveToScope({ taskRouter: updated }, routerScope);
        }}
        onPickerChange={(key, value) => {
          const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
          const updated = { ...current, [key]: value };
          saveToScope({ taskRouter: updated }, routerScope);
        }}
        onAddFallback={(modelId) => {
          useUIStore.getState().setFallbackForModel(modelId);
          useUIStore.getState().openModal("llmSelector");
        }}
        onClearFallbacks={(modelId) => {
          const current = { ...(effectiveConfig.modelFallback ?? {}) };
          delete current[modelId];
          saveToScope({ modelFallback: current }, modelScope);
        }}
        onClose={getCloser("routerSettings")}
      />

      <CommandPalette
        visible={modalCommandPalette}
        onClose={getCloser("commandPalette")}
        onExecute={(cmd) => {
          const chat = activeChatRef.current;
          if (chat) handleTabCommand(cmd, chat);
        }}
      />

      <CommandPicker
        visible={modalCommandPicker}
        config={commandPickerConfig}
        onClose={getCloser("commandPicker")}
      />

      <InfoPopup visible={modalInfoPopup} config={infoPopupConfig} onClose={closeInfoPopup} />
      <WorkflowPanel
        visible={modalWorkflow}
        workspace={getCwd()}
        onClose={getCloser("workflow")}
        activeModel={activeModelForHeader}
        activeTabId={tabMgr.activeTabId}
      />

      <StatusDashboard
        visible={modalStatusDashboard}
        initialTab={statusDashboardTab}
        onClose={getCloser("statusDashboard")}
        activeModel={activeModelForHeader}
        contextManager={contextManager}
        tabMgr={tabMgr}
        currentMode={activeChatRef.current?.bakeMode ?? "default"}
        currentModeLabel={getModeLabel(activeChatRef.current?.bakeMode ?? "default")}
      />

      <DiagnosePopup
        visible={modalDiagnose}
        onClose={getCloser("diagnosePopup")}
        runHealthCheck={runIntelligenceHealthCheck}
      />

      <ModelEventsPopup visible={modalModelEvents} onClose={getCloser("modelEvents")} />

      <RepoMapStatusPopup
        visible={modalRepoMapStatus}
        onClose={getCloser("repoMapStatus")}
        enabled={effectiveConfig.repoMap !== false}
        currentMode={
          effectiveConfig.semanticSummaries === true
            ? "synthetic"
            : effectiveConfig.semanticSummaries === false
              ? "off"
              : effectiveConfig.semanticSummaries === "on"
                ? "full"
                : (effectiveConfig.semanticSummaries ?? "synthetic")
        }
        currentLimit={effectiveConfig.semanticSummaryLimit ?? 500}
        currentAutoRegen={effectiveConfig.semanticAutoRegen ?? false}
        currentTokenBudget={effectiveConfig.repoMapTokenBudget}
        currentScope={detectScope("semanticSummaries")}
        onToggle={(enabled, scope) => {
          contextManager.setRepoMapEnabled(enabled);
          saveToScope({ repoMap: enabled }, scope);
        }}
        onRefresh={() => contextManager.refreshRepoMap().catch(() => {})}
        onClear={(scope) => {
          if (contextManager.isSemanticEnabled()) {
            contextManager.setSemanticSummaries("off");
            saveToScope({ semanticSummaries: "off" }, scope);
          }
          contextManager.clearRepoMap();
        }}
        onRegenerate={() => {
          contextManager.setActiveModel(activeModelForHeader);
          contextManager.clearFreeSummaries();
          const mode = contextManager.getSemanticMode();
          contextManager
            .setSemanticSummaries(mode === "off" ? "synthetic" : mode)
            .then(() =>
              contextManager.generateSemanticSummaries(
                contextManager.getSemanticModelId(activeModelForHeader),
              ),
            )
            .catch(() => {});
        }}
        onClearSummaries={() => {
          contextManager.clearFreeSummaries();
        }}
        onLspEnrich={() => {
          contextManager.enrichWithLsp().catch(() => {});
        }}
        onApply={(mode, limit, autoRegen, scope, tokenBudget) => {
          const typedMode = mode as "off" | "ast" | "synthetic" | "llm" | "full";
          contextManager.setActiveModel(activeModelForHeader);
          saveToScope(
            {
              semanticSummaries: typedMode,
              semanticSummaryLimit: limit,
              semanticAutoRegen: autoRegen,
              repoMapTokenBudget: tokenBudget,
            },
            scope,
          );
          contextManager.setSemanticSummaryLimit(limit);
          contextManager.setSemanticAutoRegen(autoRegen);
          contextManager.setRepoMapTokenBudget(tokenBudget);
          contextManager
            .setSemanticSummaries(typedMode)
            .then(() =>
              typedMode === "llm" || typedMode === "full"
                ? contextManager.generateSemanticSummaries(
                    contextManager.getSemanticModelId(activeModelForHeader),
                  )
                : undefined,
            )
            .catch(() => {});
        }}
      />

      <FirstRunWizard
        visible={modalFirstRunWizard}
        hasModel={activeModelForHeader !== "none"}
        activeModel={activeModelForHeader}
        onSelectModel={(modelId?: string) => {
          if (modelId) {
            notifyProviderSwitch(modelId);
            setActiveModelForHeader(modelId);
            saveToScope({ defaultModel: modelId }, modelScope);
          } else {
            wizardOpenedLlm.current = true;
            useUIStore.getState().closeModal("firstRunWizard");
            useUIStore.getState().openModal("llmSelector");
          }
        }}
        onClose={() => {
          useUIStore.getState().closeModal("firstRunWizard");
          saveToScope({ onboardingComplete: true }, "global");
          // No model picked: use the only provider that is ready, such as a signed-in Codex.
          if (activeModelForHeader === "none")
            void soleReadyModel().then((modelId) => {
              if (!modelId) return;
              notifyProviderSwitch(modelId);
              setActiveModelForHeader(modelId);
              saveToScope({ defaultModel: modelId }, modelScope);
              addSystemMessage(`Model set to ${modelId}, the only provider ready to use.`);
            });
        }}
      />

      <TabNamePopup
        visible={modalTabNamePopup}
        placeholder={`TAB-${String(tabMgr.tabCount + 1)}`}
        onSubmit={(name) => {
          useUIStore.getState().closeModal("tabNamePopup");
          tabMgr.createTab(name || undefined);
        }}
        onClose={getCloser("tabNamePopup")}
      />

      <CoordinatorView
        visible={modalCoordinator}
        open={openCoordinator}
        onClose={getCloser("coordinator")}
      />

      <SimpleModalLayer
        messages={activeChatRef.current?.messages ?? []}
        onSystemMessage={addSystemMessage}
      />

      <DialogHost />
    </box>
  );
}
