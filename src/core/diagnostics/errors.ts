/**
 * Background error log of this process: failures that happen off the chat transcript (agents,
 * hooks, language servers, session saves). The terminal UI's `/errors` view and the local API's
 * `GET /v1/diagnostics/errors` both read it. In memory only, capped at `MAX_ERRORS`.
 */
import { createStore } from "zustand/vanilla";

export interface BackgroundError {
  id: string;
  source: string;
  message: string;
  timestamp: number;
}

export const MAX_ERRORS = 500;

export interface ErrorLogState {
  errors: BackgroundError[];
  push: (source: string, message: string) => void;
  clear: () => void;
}

export const errorLogStore = createStore<ErrorLogState>()((set) => ({
  errors: [],
  push: (source, message) =>
    set((s) => {
      const entry = { id: crypto.randomUUID(), source, message, timestamp: Date.now() };
      const errors =
        s.errors.length >= MAX_ERRORS
          ? [...s.errors.slice(-(MAX_ERRORS - 1)), entry]
          : [...s.errors, entry];
      return { errors };
    }),
  clear: () => set({ errors: [] }),
}));

export function logBackgroundError(source: string, message: string): void {
  errorLogStore.getState().push(source, message);
}

/** The logged errors, newest first. */
export function backgroundErrors(): BackgroundError[] {
  return [...errorLogStore.getState().errors].reverse();
}
