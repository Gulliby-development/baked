/** React binding of the model events recorder in src/core/diagnostics/model-events.ts. */
import { useStore } from "zustand";
import { type ModelEventsState, modelEventsStore } from "../core/diagnostics/model-events.js";

export {
  aggregateModelEvents,
  isModelEventsEnabled,
  type ModelAggregate,
  type ModelCallEvent,
  type ModelCallSource,
  type ModelCallState,
  modelErrorEvents,
  recordModelCall,
} from "../core/diagnostics/model-events.js";

export const useModelEventsStore = Object.assign(
  <T>(selector: (state: ModelEventsState) => T): T => useStore(modelEventsStore, selector),
  modelEventsStore,
);
