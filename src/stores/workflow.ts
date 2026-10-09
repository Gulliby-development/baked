import { create } from "zustand";
import type { RunSnapshot, WorkflowEvent } from "../core/workflows/schemas.js";

export interface WorkflowProjection {
  snapshot: RunSnapshot | null;
  lastSeq: number;
}
export function applyWorkflowEvent(
  projection: WorkflowProjection,
  event: WorkflowEvent,
): WorkflowProjection {
  if (
    !projection.snapshot ||
    projection.snapshot.runId !== event.runId ||
    event.seq <= projection.lastSeq
  )
    return projection;
  if (event.seq !== projection.lastSeq + 1) return projection;
  const snapshot = { ...projection.snapshot, eventSeq: event.seq };
  if (event.type === "run.state_changed") {
    snapshot.status = event.payload.to;
    snapshot.reason = event.payload.reason;
    snapshot.revision = event.payload.revision;
  }
  if (event.type === "stage.started") snapshot.stageId = event.payload.stageId;
  return { snapshot, lastSeq: event.seq };
}

export type WorkflowScreen = "home" | "run" | "new";
/** Compact status shown outside the panel while a run is tracked in this tab session. */
export interface WorkflowBadge {
  runId: string;
  featureId: string;
  status: RunSnapshot["status"];
  stageId: string | null;
  needsUser: boolean;
  tokens: number;
}
interface WorkflowUIState {
  selectedRunId: string | null;
  runsByTab: Record<string, string>;
  projection: WorkflowProjection;
  screen: WorkflowScreen;
  draftPrompt: string;
  badge: WorkflowBadge | null;
  /** Runs whose terminal state the user has already seen in the panel. */
  acknowledged: Record<string, string>;
  select: (runId: string | null, tabId?: string) => void;
  showHome: () => void;
  showNew: (prompt?: string) => void;
  load: (snapshot: RunSnapshot) => void;
  event: (event: WorkflowEvent) => void;
  setBadge: (badge: WorkflowBadge | null) => void;
  acknowledge: (runId: string, status: string) => void;
}
export const useWorkflowStore = create<WorkflowUIState>((set) => ({
  selectedRunId: null,
  runsByTab: {},
  projection: { snapshot: null, lastSeq: 0 },
  screen: "home",
  draftPrompt: "",
  badge: null,
  acknowledged: {},
  select: (runId, tabId) =>
    set((s) => ({
      selectedRunId: runId,
      screen: runId ? "run" : "home",
      runsByTab: tabId && runId ? { ...s.runsByTab, [tabId]: runId } : s.runsByTab,
    })),
  showHome: () => set({ screen: "home" }),
  showNew: (prompt) => set((s) => ({ screen: "new", draftPrompt: prompt ?? s.draftPrompt })),
  load: (snapshot) => set({ projection: { snapshot, lastSeq: snapshot.eventSeq } }),
  event: (event) => set((s) => ({ projection: applyWorkflowEvent(s.projection, event) })),
  setBadge: (badge) => set({ badge }),
  acknowledge: (runId, status) =>
    set((s) =>
      s.acknowledged[runId] === status
        ? s
        : { acknowledged: { ...s.acknowledged, [runId]: status } },
    ),
}));
