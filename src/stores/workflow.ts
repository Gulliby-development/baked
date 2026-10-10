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

export type WorkflowScreen = "home" | "run" | "new" | "gates" | "editor" | "initiatives";
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
  /** The workflow the new-run form opens with; null keeps the project default. */
  draftWorkflow: string | null;
  badge: WorkflowBadge | null;
  /** Runs whose terminal state the user has already seen in the panel. */
  acknowledged: Record<string, string>;
  select: (runId: string | null, tabId?: string) => void;
  showHome: () => void;
  showNew: (prompt?: string, workflow?: string | null) => void;
  showGates: () => void;
  /** The definition the editor window shows, and the screen Esc returns to. */
  editorId: string | null;
  editorReturn: "home" | "new";
  showEditor: (id: string, from?: "home" | "new") => void;
  /** The initiative the initiative screen shows in detail; null shows the list. */
  initiativeId: string | null;
  showInitiatives: (id?: string | null) => void;
  /** Where Esc on a run returns: the run list, or the initiative the run was opened from. */
  runReturn: "home" | "initiatives";
  /** Opens a feature run from the initiative screen; Esc on the run returns there. */
  openInitiativeRun: (runId: string, tabId?: string) => void;
  /** Leaves the run screen for the screen it was opened from. */
  leaveRun: () => void;
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
  draftWorkflow: null,
  badge: null,
  acknowledged: {},
  select: (runId, tabId) =>
    set((s) => ({
      selectedRunId: runId,
      screen: runId ? "run" : "home",
      runReturn: "home",
      runsByTab: tabId && runId ? { ...s.runsByTab, [tabId]: runId } : s.runsByTab,
    })),
  showHome: () => set({ screen: "home" }),
  showGates: () => set({ screen: "gates" }),
  editorId: null,
  editorReturn: "home",
  showEditor: (id, from = "home") => set({ screen: "editor", editorId: id, editorReturn: from }),
  initiativeId: null,
  showInitiatives: (id) =>
    set((s) => ({ screen: "initiatives", initiativeId: id === undefined ? s.initiativeId : id })),
  runReturn: "home",
  openInitiativeRun: (runId, tabId) =>
    set((s) => ({
      selectedRunId: runId,
      screen: "run",
      runReturn: "initiatives",
      runsByTab: tabId ? { ...s.runsByTab, [tabId]: runId } : s.runsByTab,
    })),
  leaveRun: () => set((s) => ({ screen: s.runReturn === "initiatives" ? "initiatives" : "home" })),
  showNew: (prompt, workflow = null) =>
    set((s) => ({ screen: "new", draftPrompt: prompt ?? s.draftPrompt, draftWorkflow: workflow })),
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
