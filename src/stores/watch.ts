import { create } from "zustand";

/**
 * Watch mode in the terminal app. One tab at a time watches the project, so two tabs never both
 * answer the same comment; `/watch on` in another tab moves the watch there.
 */
interface WatchState {
  /** The tab that should watch, or null when watch mode is off. */
  tabId: string | null;
  /** The watcher is running ("native" file events or "poll"), or null while it starts or is off. */
  method: "native" | "poll" | null;
  /** Where the last watch turn came from, e.g. "src/x.ts:42 (baked!)". */
  last: string | null;
  /** Watch turns sent so far in this watch. */
  turns: number;
  error: string | null;
  enable: (tabId: string) => void;
  disable: () => void;
  setRunning: (method: "native" | "poll" | null) => void;
  noteTurn: (label: string) => void;
  setError: (message: string | null) => void;
}

export const useWatchStore = create<WatchState>()((set) => ({
  tabId: null,
  method: null,
  last: null,
  turns: 0,
  error: null,
  enable: (tabId) =>
    set((s) =>
      s.tabId === tabId ? s : { tabId, method: null, last: null, turns: 0, error: null },
    ),
  disable: () => set({ tabId: null, method: null }),
  setRunning: (method) => set({ method }),
  noteTurn: (label) => set((s) => ({ last: label, turns: s.turns + 1 })),
  setError: (error) => set({ error }),
}));
