import { create } from "zustand";
import { DEFAULT_DISABLED_TOOLS } from "../core/settings/schema.js";

const DEFAULT_DISABLED = DEFAULT_DISABLED_TOOLS;

interface ToolsState {
  disabledTools: Set<string>;
  toggleTool: (name: string) => void;
  initFromConfig: (disabled?: string[]) => void;
}

export const useToolsStore = create<ToolsState>()((set) => ({
  disabledTools: new Set<string>(DEFAULT_DISABLED),
  toggleTool: (name) =>
    set((s) => {
      const next = new Set(s.disabledTools);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { disabledTools: next };
    }),
  initFromConfig: (disabled) => set({ disabledTools: new Set(disabled ?? DEFAULT_DISABLED) }),
}));
