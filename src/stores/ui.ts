import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { CommandPickerConfig } from "../components/modals/CommandPicker.js";
import type { InfoPopupConfig } from "../components/modals/InfoPopup.js";
import type { ChatStyle, TaskRouter } from "../types/index.js";

export type ModalName =
  | "workflow"
  | "llmSelector"
  | "skillSearch"
  | "gitCommit"
  | "sessionPicker"
  | "helpPopup"
  | "errorLog"
  | "gitMenu"
  | "routerSettings"
  | "providerSettings"
  | "commandPicker"
  | "commandPalette"
  | "infoPopup"
  | "repoMapStatus"
  | "setup"
  | "webSearchSettings"
  | "apiKeySettings"
  | "lspStatus"
  | "lspInstall"
  | "compactionLog"
  | "diagnosePopup"
  | "statusDashboard"
  | "toolsPopup"
  | "firstRunWizard"
  | "mcpSettings"
  | "tabNamePopup"
  | "memoryBrowser"
  | "modelEvents";

type Modals = Record<ModalName, boolean>;

const INITIAL_MODALS: Modals = {
  workflow: false,
  llmSelector: false,
  skillSearch: false,
  gitCommit: false,
  sessionPicker: false,
  helpPopup: false,
  errorLog: false,
  gitMenu: false,
  routerSettings: false,
  providerSettings: false,
  commandPicker: false,
  commandPalette: false,
  infoPopup: false,
  repoMapStatus: false,
  setup: false,
  webSearchSettings: false,
  apiKeySettings: false,
  lspStatus: false,
  lspInstall: false,
  compactionLog: false,
  diagnosePopup: false,
  statusDashboard: false,
  toolsPopup: false,
  firstRunWizard: false,
  mcpSettings: false,
  tabNamePopup: false,
  memoryBrowser: false,
  modelEvents: false,
};

interface UIState {
  modals: Modals;
  routerSlotPicking: keyof TaskRouter | null;
  /** Model ID we're currently adding a fallback to (null = not picking) */
  fallbackForModel: string | null;
  commandPickerConfig: CommandPickerConfig | null;
  infoPopupConfig: InfoPopupConfig | null;
  statusDashboardTab: "Context" | "System" | "Dispatch";

  codeExpanded: Record<string, boolean>;
  changesExpanded: boolean;
  chatStyle: ChatStyle;
  showReasoning: boolean;
  reasoningExpanded: Record<string, boolean>;
  /** Per-tab verbose render. false (default) = rail layout, true = raw stream of everything. */
  verboseByTab: Record<string, boolean>;
  /** Per-message, per-tool expand state. */
  messageToolExpanded: Record<string, Record<string, boolean>>;

  openModal: (name: ModalName) => void;
  closeModal: (name: ModalName) => void;
  toggleModal: (name: ModalName) => void;

  setRouterSlotPicking: (slot: keyof TaskRouter | null) => void;
  setFallbackForModel: (modelId: string | null) => void;

  openCommandPicker: (config: CommandPickerConfig) => void;
  updatePickerOptions: (options: CommandPickerConfig["options"], currentValue?: string) => void;
  openInfoPopup: (config: InfoPopupConfig) => void;
  closeInfoPopup: () => void;

  toggleCodeExpanded: (tabId: string) => void;
  setCodeExpanded: (tabId: string, v: boolean) => void;
  toggleChangesExpanded: () => void;
  setChangesExpanded: (v: boolean) => void;
  setChatStyle: (style: ChatStyle) => void;
  setShowReasoning: (v: boolean) => void;
  toggleShowReasoning: () => void;
  toggleReasoningExpanded: (tabId: string) => void;
  toggleAllExpanded: (tabId: string) => void;
  setTabVerbose: (tabId: string, v: boolean) => void;
  toggleTabVerbose: (tabId: string) => void;
  ensureTabVerboseDefault: (tabId: string, def?: boolean) => void;
  pruneTabVerbose: (tabId: string) => void;
  toggleMessageTool: (msgId: string, toolId: string) => void;
  pruneMessageTools: (msgIds: string[]) => void;
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set) => ({
    modals: { ...INITIAL_MODALS },
    routerSlotPicking: null,
    fallbackForModel: null,
    commandPickerConfig: null,
    infoPopupConfig: null,
    statusDashboardTab: "Context" as const as "Context" | "System" | "Dispatch",

    codeExpanded: {},
    changesExpanded: false,
    chatStyle: "accent",
    showReasoning: true,
    reasoningExpanded: {},
    verboseByTab: {} as Record<string, boolean>,
    messageToolExpanded: {} as Record<string, Record<string, boolean>>,

    openModal: (name) => set(() => ({ modals: { ...INITIAL_MODALS, [name]: true } })),
    closeModal: (name) => set((s) => ({ modals: { ...s.modals, [name]: false } })),
    toggleModal: (name) =>
      set((s) => ({
        modals: s.modals[name]
          ? { ...s.modals, [name]: false }
          : { ...INITIAL_MODALS, [name]: true },
      })),

    setRouterSlotPicking: (slot) => set({ routerSlotPicking: slot }),
    setFallbackForModel: (modelId) => set({ fallbackForModel: modelId }),

    openCommandPicker: (config) =>
      set(() => ({
        commandPickerConfig: config,
        modals: { ...INITIAL_MODALS, commandPicker: true },
      })),
    updatePickerOptions: (options, currentValue) =>
      set((s) => ({
        commandPickerConfig: s.commandPickerConfig
          ? {
              ...s.commandPickerConfig,
              options,
              ...(currentValue !== undefined && { currentValue }),
            }
          : null,
      })),
    openInfoPopup: (config) =>
      set((s) => ({
        infoPopupConfig: config,
        modals: { ...s.modals, infoPopup: true },
      })),
    closeInfoPopup: () =>
      set((s) => ({
        infoPopupConfig: null,
        modals: { ...s.modals, infoPopup: false },
      })),

    toggleCodeExpanded: (tabId) =>
      set((s) => ({ codeExpanded: { ...s.codeExpanded, [tabId]: !s.codeExpanded[tabId] } })),
    setCodeExpanded: (tabId, v) =>
      set((s) => ({ codeExpanded: { ...s.codeExpanded, [tabId]: v } })),
    toggleChangesExpanded: () => set((s) => ({ changesExpanded: !s.changesExpanded })),
    setChangesExpanded: (v) => set({ changesExpanded: v }),
    setChatStyle: (style) => set({ chatStyle: style }),
    setShowReasoning: (v) => set({ showReasoning: v }),
    toggleShowReasoning: () => set((s) => ({ showReasoning: !s.showReasoning })),
    toggleReasoningExpanded: (tabId) =>
      set((s) => ({
        reasoningExpanded: { ...s.reasoningExpanded, [tabId]: !s.reasoningExpanded[tabId] },
      })),
    toggleAllExpanded: (tabId) =>
      set((s) => {
        const anyExpanded = !!s.codeExpanded[tabId] || !!s.reasoningExpanded[tabId];
        return {
          codeExpanded: { ...s.codeExpanded, [tabId]: !anyExpanded },
          reasoningExpanded: { ...s.reasoningExpanded, [tabId]: !anyExpanded },
        };
      }),
    setTabVerbose: (tabId, v) => set((s) => ({ verboseByTab: { ...s.verboseByTab, [tabId]: v } })),
    toggleTabVerbose: (tabId) =>
      set((s) => ({ verboseByTab: { ...s.verboseByTab, [tabId]: !s.verboseByTab[tabId] } })),
    ensureTabVerboseDefault: (tabId, def) =>
      set((s) => {
        if (s.verboseByTab[tabId] !== undefined) return {};
        return { verboseByTab: { ...s.verboseByTab, [tabId]: def ?? false } };
      }),
    pruneTabVerbose: (tabId) =>
      set((s) => {
        const { [tabId]: _v, ...verboseByTab } = s.verboseByTab;
        return { verboseByTab };
      }),
    toggleMessageTool: (msgId, toolId) =>
      set((s) => {
        const cur = s.messageToolExpanded[msgId] ?? {};
        return {
          messageToolExpanded: {
            ...s.messageToolExpanded,
            [msgId]: { ...cur, [toolId]: !cur[toolId] },
          },
        };
      }),
    pruneMessageTools: (msgIds) =>
      set((s) => {
        if (msgIds.length === 0) return {};
        const next = { ...s.messageToolExpanded };
        let changed = false;
        for (const id of msgIds) {
          if (id in next) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? { messageToolExpanded: next } : {};
      }),
  })),
);

export const selectIsAnyModalOpen = (s: UIState): boolean => Object.values(s.modals).some(Boolean);

export function resetUIStore(): void {
  useUIStore.setState({
    modals: { ...INITIAL_MODALS },
    routerSlotPicking: null,
    commandPickerConfig: null,
    infoPopupConfig: null,
    statusDashboardTab: "Context",
    codeExpanded: {},
    changesExpanded: false,
    chatStyle: "accent",
    showReasoning: true,
    reasoningExpanded: {},
    verboseByTab: {},
    messageToolExpanded: {},
  });
}
