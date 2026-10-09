import type { Selection } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { MutableRefObject } from "react";
import { useCheckpointStore } from "../stores/checkpoints.js";
import { selectIsAnyModalOpen, useUIStore } from "../stores/ui.js";
import type { ChatInstance } from "./useChat.js";
import type { UseTabsReturn } from "./useTabs.js";

interface GlobalKeyboardParams {
  shutdownPhase: number;
  handleExit: () => void;
  newSession: () => void;
  renderer: { getSelection: () => Selection | null; clearSelection: () => void };
  copySelection: () => boolean;
  activeChatRef: MutableRefObject<ChatInstance | null>;
  cycleMode: () => void;
  tabMgr: UseTabsReturn;
}

export function useGlobalKeyboard({
  shutdownPhase,
  handleExit,
  newSession,
  renderer,
  copySelection,
  activeChatRef,
  cycleMode,
  tabMgr,
}: GlobalKeyboardParams): void {
  useKeyboard((evt) => {
    if (shutdownPhase >= 0) return;
    const uiModals = useUIStore.getState().modals;
    if (selectIsAnyModalOpen(useUIStore.getState())) {
      const hasOwnInput =
        uiModals.commandPalette ||
        uiModals.skillSearch ||
        uiModals.sessionPicker ||
        uiModals.errorLog ||
        uiModals.compactionLog ||
        uiModals.llmSelector ||
        uiModals.firstRunWizard ||
        uiModals.mcpSettings ||
        uiModals.modelEvents ||
        uiModals.tabNamePopup ||
        uiModals.workflow;
      if (evt.ctrl && evt.name === "c") {
        if (copySelection()) {
          evt.stopPropagation();
          evt.preventDefault();
          return;
        }
        if (!hasOwnInput) handleExit();
      }
      if (!hasOwnInput) evt.stopPropagation();
      return;
    }

    // Helper: consume a shortcut — execute the action and stop event propagation
    // so child components (InputBox, etc.) never see global shortcuts.
    const consume = (action: () => void) => {
      action();
      evt.stopPropagation();
      evt.preventDefault();
    };

    if (evt.ctrl && evt.name === "o")
      return consume(() => useUIStore.getState().toggleAllExpanded(tabMgr.activeTabId));

    if (evt.name === "escape" && renderer.getSelection()) {
      return consume(() => renderer.clearSelection());
    }

    // Copy must be checked BEFORE snap-scroll (scroll can invalidate selection)
    if ((evt.ctrl || evt.super) && evt.name === "c") {
      if (copySelection()) {
        evt.stopPropagation();
        evt.preventDefault();
        return;
      }
      // Ctrl+Shift+C is copy-only (Konsole/Wayland forwards it as bare Ctrl+C
      // with shift:true). Never exit on shift.
      if (evt.shift) return;
      if (evt.ctrl) return;
      if (evt.ctrl) handleExit();
      return;
    }

    if (evt.ctrl && evt.name === "x") return consume(() => activeChatRef.current?.abort());
    if (evt.ctrl && evt.name === "l")
      return consume(() => useUIStore.getState().toggleModal("llmSelector"));
    if (evt.ctrl && evt.name === "s")
      return consume(() => useUIStore.getState().toggleModal("skillSearch"));
    if (evt.ctrl && evt.name === "t")
      return consume(() => {
        if (!tabMgr.canCreateTab) return;
        useUIStore.getState().openModal("tabNamePopup");
      });
    if (evt.ctrl && evt.name === "n") return consume(() => newSession());
    if (evt.ctrl && evt.name === "d") return consume(() => cycleMode());
    if (evt.ctrl && evt.name === "g")
      return consume(() => useUIStore.getState().toggleModal("gitMenu"));
    if (evt.ctrl && evt.name === "k")
      return consume(() => useUIStore.getState().toggleModal("commandPalette"));
    if (evt.ctrl && evt.name === "h")
      return consume(() => useUIStore.getState().toggleModal("commandPalette"));
    if (evt.ctrl && evt.name === "p")
      return consume(() => useUIStore.getState().toggleModal("sessionPicker"));
    if (evt.meta && evt.name === "r")
      return consume(() => useUIStore.getState().toggleModal("errorLog"));
    if (evt.ctrl && evt.name === "w")
      return consume(() => {
        if (tabMgr.tabCount <= 1) return;
        if (tabMgr.isTabLoading(tabMgr.activeTabId)) {
          const closingId = tabMgr.activeTabId;
          useUIStore.getState().openCommandPicker({
            title: "Tab is busy — close anyway?",
            icon: "⚠",
            options: [
              { value: "yes", label: "Yes, close it", icon: "✓" },
              { value: "no", label: "Cancel", icon: "✕" },
            ],
            onSelect: (val) => {
              if (val === "yes") tabMgr.closeTab(closingId);
            },
          });
        } else {
          tabMgr.closeTab(tabMgr.activeTabId);
        }
      });
    if ((evt.meta || evt.ctrl) && evt.name >= "1" && evt.name <= "9") {
      return consume(() => tabMgr.switchToIndex(Number(evt.name) - 1));
    }
    if (evt.ctrl && evt.name === "[") return consume(() => tabMgr.prevTab());
    if (evt.ctrl && evt.name === "]") return consume(() => tabMgr.nextTab());

    // ^B / ^F — checkpoint browsing (skips undone checkpoints)
    if (evt.ctrl && evt.name === "b")
      return consume(() => {
        const store = useCheckpointStore.getState();
        const tid = tabMgr.activeTabId;
        const cps = store.getCheckpoints(tid);
        const active = cps.filter((c) => !c.undone);
        if (active.length === 0) return;
        const current = store.getViewing(tid);
        // From live: go to second-to-last (last is what you're already seeing).
        // From a viewed checkpoint: go to the one before it.
        const currentIdx = current ?? active[active.length - 1]?.index ?? 0;
        const prev = active.filter((c) => c.index < currentIdx).pop();
        if (prev) {
          store.setViewing(tid, prev.index);
        } else if (current === null && active.length >= 1) {
          // Only one checkpoint — show it (first ^B highlights it)
          store.setViewing(tid, active[active.length - 1]?.index ?? 1);
        }
      });
    if (evt.ctrl && evt.name === "f")
      return consume(() => {
        const store = useCheckpointStore.getState();
        const tid = tabMgr.activeTabId;
        const cps = store.getCheckpoints(tid);
        const active = cps.filter((c) => !c.undone);
        if (active.length === 0) return;
        const current = store.getViewing(tid);
        if (current === null) return; // already live
        // Find the next active checkpoint after current viewing position
        const next = active.find((c) => c.index > current);
        if (next) {
          store.setViewing(tid, next.index);
        } else {
          store.setViewing(tid, null); // go to live
        }
      });
  });
}
