/**
 * Model-events sidecar — read-only observer of LLM call activity in this process.
 *
 * Purpose: per-call timeline (model, latency, tokens, error) for the terminal UI's
 * `/model-events` view and the local API's `/v1/diagnostics/model-events`. Off by default for
 * performance; while off, `recordModelCall` is a no-op.
 *
 * Emitted from the terminal UI's main loop (src/hooks/useChat.ts), the API's chat sessions
 * (src/core/chat/sessions.ts), workflow run attempts (src/core/workflows/agent-executor.ts),
 * subagent runs, compaction, web search and context summaries.
 * Every emit site goes through `recordModelCall`, which never throws, so a bug here cannot
 * affect chat or agent execution.
 */
import { createStore } from "zustand/vanilla";

export type ModelCallSource = "main" | "subagent" | "compaction" | "embed" | "run" | "other";
export type ModelCallState = "ok" | "error";

export interface ModelCallEvent {
  id: string;
  modelId: string;
  source: ModelCallSource;
  startedAt: number;
  durationMs: number;
  state: ModelCallState;
  tabId?: string;
  agentId?: string;
  messageId?: string;
  /** The workflow run the call belongs to. */
  runId?: string;
  /** The local API chat session the call belongs to. */
  sessionId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  errorMessage?: string;
}

export interface ModelAggregate {
  modelId: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  lastMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  lastAt: number;
}

export const MAX_MODEL_EVENTS = 500;

export interface ModelEventsState {
  /** Off by default — opt-in for performance. */
  enabled: boolean;
  events: ModelCallEvent[];
  setEnabled: (v: boolean) => void;
  push: (event: Omit<ModelCallEvent, "id"> & { id?: string }) => string | null;
  clear: () => void;
}

export const modelEventsStore = createStore<ModelEventsState>()((set, get) => ({
  enabled: false,
  events: [],
  setEnabled: (v) => set(v ? { enabled: true } : { enabled: false, events: [] }),
  push: (event) => {
    if (!get().enabled) return null;
    const id = event.id ?? crypto.randomUUID();
    const full: ModelCallEvent = { ...event, id };
    set((s) => {
      const events =
        s.events.length >= MAX_MODEL_EVENTS
          ? [...s.events.slice(-(MAX_MODEL_EVENTS - 1)), full]
          : [...s.events, full];
      return { events };
    });
    return id;
  },
  clear: () => set({ events: [] }),
}));

/**
 * Safe emit — never throws and is a no-op when recording is off. The store is a passive
 * observer; if it ever fails the LLM call must continue.
 */
export function recordModelCall(event: Omit<ModelCallEvent, "id">): void {
  try {
    const s = modelEventsStore.getState();
    if (!s.enabled) return;
    s.push(event);
  } catch {}
}

/** Fast path used by hot emit sites to avoid building the event object. */
export function isModelEventsEnabled(): boolean {
  try {
    return modelEventsStore.getState().enabled;
  } catch {
    return false;
  }
}

/** Roll up events into per-model aggregates, most recently used first. Pure derivation. */
export function aggregateModelEvents(events: readonly ModelCallEvent[]): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>();
  for (const ev of events) {
    const prev = byModel.get(ev.modelId) ?? {
      modelId: ev.modelId,
      calls: 0,
      errors: 0,
      totalMs: 0,
      avgMs: 0,
      lastMs: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      lastAt: 0,
    };
    prev.calls += 1;
    if (ev.state === "error") prev.errors += 1;
    prev.totalMs += ev.durationMs;
    prev.lastMs = ev.durationMs;
    prev.input += ev.input ?? 0;
    prev.output += ev.output ?? 0;
    prev.cacheRead += ev.cacheRead ?? 0;
    prev.cacheWrite += ev.cacheWrite ?? 0;
    prev.lastAt = Math.max(prev.lastAt, ev.startedAt + ev.durationMs);
    byModel.set(ev.modelId, prev);
  }
  for (const agg of byModel.values()) {
    agg.avgMs = agg.calls > 0 ? Math.round(agg.totalMs / agg.calls) : 0;
  }
  return [...byModel.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Filter to just errors — drives the error-feed tab. */
export function modelErrorEvents(events: readonly ModelCallEvent[]): ModelCallEvent[] {
  return events.filter((e) => e.state === "error");
}

export interface ModelEventsView {
  enabled: boolean;
  /** Newest first. */
  events: ModelCallEvent[];
  models: ModelAggregate[];
}

/** Whether recording is on, the recorded calls newest first, and per-model totals. */
export function modelEventsView(): ModelEventsView {
  const { enabled, events } = modelEventsStore.getState();
  return { enabled, events: [...events].reverse(), models: aggregateModelEvents(events) };
}
