import type { ConfigScope } from "../../components/layout/shared.js";
import type { CommandPickerConfig } from "../../components/modals/CommandPicker.js";
import type { InfoPopupConfig } from "../../components/modals/InfoPopup.js";
import type { ChatInstance } from "../../hooks/useChat.js";
import type { UseTabsReturn } from "../../hooks/useTabs.js";
import type {
  AgentFeatures,
  AppConfig,
  BakeMode,
  ChatEffort,
  ChatStyle,
  PermissionMode,
} from "../../types/index.js";
import type { CompactionStrategy } from "../compaction/types.js";
import type { ContextManager } from "../context/manager.js";

export interface CommandContext {
  chat: ChatInstance;
  tabMgr: UseTabsReturn;
  exit: () => void;
  openSkills: () => void;
  openGitCommit: () => void;
  openSessions: () => void;
  /** Saves the open session, then loads `sessionId` of this folder. */
  resumeSession: (sessionId: string) => Promise<void>;
  /** Saves the session and runs BAKED again in `folder`, resuming `sessionId` when given. */
  switchProject: (folder: string, sessionId?: string) => void;
  newSession: () => void;
  openHelp: () => void;
  openErrorLog: () => void;
  openCompactionLog: () => void;
  cwd: string;
  refreshGit: () => void;
  setBakeMode: (mode: BakeMode) => void;
  /** Sets the active tab's reasoning effort and the header chip. */
  setEffort: (effort: ChatEffort) => void;
  /** Sets the active tab's permission mode (manual, auto, full) and the header chip. */
  setPermissionMode: (mode: PermissionMode) => void;
  currentPermissionMode: PermissionMode;
  currentMode: BakeMode;
  currentModeLabel: string;
  contextManager: ContextManager;
  chatStyle: ChatStyle;
  setChatStyle: (style: ChatStyle) => void;
  openGitMenu: () => void;
  verbose: boolean;
  /** Per-tab verbose render flag. false = rail layout, true = raw stream. */
  tabVerbose: boolean;
  setTabVerbose: (v: boolean) => void;
  diffStyle: "default" | "sidebyside" | "compact";
  collapseDiffs: boolean;
  compactionStrategy: CompactionStrategy;
  showReasoning: boolean;
  setShowReasoning: (v: boolean) => void;
  watchdog: boolean;
  openSetup: () => void;
  openRouterSettings: () => void;
  openProviderSettings: () => void;
  openWebSearchSettings: () => void;
  openApiKeySettings: () => void;
  openLspStatus: () => void;
  openLspInstall: () => void;
  openCommandPicker: (config: CommandPickerConfig) => void;
  openInfoPopup: (config: InfoPopupConfig) => void;
  openMemoryBrowser: () => void;
  toggleChanges: () => void;
  saveToScope: (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  detectScope: (key: string) => ConfigScope;
  agentFeatures: AgentFeatures | undefined;
  instructionFiles: string[] | undefined;
  /** Sync model change to both the active chat and the header UI */
  syncActiveModel: (modelId: string) => void;
}

export type CommandHandler = (input: string, ctx: CommandContext) => void | Promise<void>;
