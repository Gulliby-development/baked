/** React binding of the background error log in src/core/diagnostics/errors.ts. */
import { useStore } from "zustand";
import { type ErrorLogState, errorLogStore } from "../core/diagnostics/errors.js";

export { logBackgroundError } from "../core/diagnostics/errors.js";

export const useErrorStore = Object.assign(
  <T>(selector: (state: ErrorLogState) => T): T => useStore(errorLogStore, selector),
  errorLogStore,
);
