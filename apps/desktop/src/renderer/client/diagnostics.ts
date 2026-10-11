/**
 * Diagnostics of a project's backend (`diagnostics` capability, docs/desktop/api.md): disk use and
 * cleanup of BAKED's data, the model events and the background error log of that `baked serve`
 * process. The terminal UI shows the same through `/storage`, `/model-events` and `/errors`.
 */
import { call } from "./api.js";
import { DIAGNOSTICS_CAPABILITY } from "./capabilities.js";
import { withCapability } from "./setup.js";

export interface StorageView {
  projectDir: string;
  globalDir: string;
  project: {
    totalBytes: number;
    repoMapBytes: number;
    sessionsBytes: number;
    sessionCount: number;
    memoryBytes: number;
    plansBytes: number;
    configBytes: number;
  };
  global: {
    totalBytes: number;
    historyBytes: number;
    memoryBytes: number;
    configBytes: number;
    binariesBytes: number;
  };
}

export type CleanupTarget = "repo-map" | "sessions" | "plans" | "history" | "vacuum";

export interface CleanupResult {
  target: CleanupTarget;
  freedBytes: number;
  /** Sessions removed, for `sessions`. */
  removed?: number;
  storage: StorageView;
}

export type ModelCallSource = "main" | "subagent" | "compaction" | "embed" | "run" | "other";

export interface ModelCallEvent {
  id: string;
  modelId: string;
  source: ModelCallSource;
  startedAt: number;
  durationMs: number;
  state: "ok" | "error";
  runId?: string;
  sessionId?: string;
  agentId?: string;
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

export interface ModelEventsView {
  enabled: boolean;
  /** Newest first. */
  events: ModelCallEvent[];
  models: ModelAggregate[];
}

export interface BackgroundError {
  id: string;
  source: string;
  message: string;
  timestamp: number;
}

/** One cleanable row of the storage table: what it clears and how the confirmation words it. */
export interface CleanupAction {
  target: CleanupTarget;
  label: string;
  bytes: number;
  /** The confirmation's text; null for `vacuum`, which keeps all data and asks nothing. */
  warning: string | null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The cleanup actions of a storage view; a row with nothing to clear is left out, as in `/storage`. */
export function cleanupActions(view: StorageView): CleanupAction[] {
  const { project, global } = view;
  const actions: CleanupAction[] = [];
  if (project.repoMapBytes > 0)
    actions.push({
      target: "repo-map",
      label: "Code map",
      bytes: project.repoMapBytes,
      warning: `${formatBytes(project.repoMapBytes)} of the repository map are deleted. The next index pass rebuilds it.`,
    });
  if (project.sessionCount > 0)
    actions.push({
      target: "sessions",
      label: "Chat sessions",
      bytes: project.sessionsBytes,
      warning: `${String(project.sessionCount)} saved ${project.sessionCount === 1 ? "session" : "sessions"} (${formatBytes(project.sessionsBytes)}) of this project are deleted, including chats the terminal UI saved. This cannot be undone.`,
    });
  if (project.plansBytes > 0)
    actions.push({
      target: "plans",
      label: "Plans",
      bytes: project.plansBytes,
      warning: `All saved plans (${formatBytes(project.plansBytes)}) of this project are deleted. This cannot be undone.`,
    });
  if (global.historyBytes > 0)
    actions.push({
      target: "history",
      label: "Prompt history",
      bytes: global.historyBytes,
      warning: `The terminal UI's prompt history (${formatBytes(global.historyBytes)}) is deleted for every project. This cannot be undone.`,
    });
  actions.push({ target: "vacuum", label: "Compact databases", bytes: 0, warning: null });
  return actions;
}

export const diagnostics = {
  storage: (key: string) =>
    withCapability(key, DIAGNOSTICS_CAPABILITY, () =>
      call<StorageView>(key, "GET", "/v1/diagnostics/storage"),
    ),
  /** Deleting targets send `confirm: true`; the server refuses them without it. */
  cleanup: (key: string, target: CleanupTarget) =>
    call<CleanupResult>(key, "POST", "/v1/diagnostics/storage/cleanup", {
      target,
      ...(target === "vacuum" ? {} : { confirm: true }),
    }),
  modelEvents: (key: string) =>
    withCapability(key, DIAGNOSTICS_CAPABILITY, () =>
      call<ModelEventsView>(key, "GET", "/v1/diagnostics/model-events"),
    ),
  changeModelEvents: (key: string, action: "enable" | "disable" | "clear") =>
    call<ModelEventsView>(key, "POST", "/v1/diagnostics/model-events", { action }),
  errors: (key: string) =>
    withCapability(key, DIAGNOSTICS_CAPABILITY, () =>
      call<{ errors: BackgroundError[] }>(key, "GET", "/v1/diagnostics/errors"),
    ),
};
