/**
 * Types shared by the main process, the preload bridge and the renderer. Shapes that come from
 * `baked serve` mirror `src/core/api/server.ts` and the workflow core; only the fields the app
 * reads are declared.
 */

export type RunState =
  | "created"
  | "running"
  | "waiting"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProjectOverview {
  sessions: number;
  lastSessionAt: number | null;
  activeRuns: number;
  attention: number;
}

/** A folder BAKED was opened in, as `baked projects list --json` prints it. */
export interface KnownProject {
  path: string;
  name: string;
  projectId: string | null;
  pinned: boolean;
  addedAt: number;
  lastOpenedAt: number;
  exists: boolean;
  overview: ProjectOverview;
}

export type BackendState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running"; version: string }
  | { kind: "restarting"; attempt: number; lastError: string }
  | { kind: "failed"; lastError: string; stderr: string[] };

/** A known project plus what the app knows about it: its route key and its backend. */
export interface DesktopProject extends KnownProject {
  /** Stable short key for routes, derived from the folder path. */
  key: string;
  open: boolean;
  backend: BackendState;
  /** The checked-out Git branch, when the folder is a repository on a branch. */
  branch?: string | null;
}

export type AttentionSource = "run" | "chat" | "initiative";

/**
 * `GET /v1/attention` item, tagged with the project it came from. Run items carry `runId` and
 * `featureId`; chat items the session (`requestId` is the prompt); initiative items
 * `initiativeId`. Backends older than the chat API send no `source`: those items are runs.
 */
export interface AttentionItem {
  source?: AttentionSource;
  runId: string | null;
  featureId: string | null;
  sessionId?: string | null;
  initiativeId?: string;
  /** The session or initiative title; null for run items. */
  title?: string | null;
  status: RunState;
  requestId: string | null;
  kind: string;
  blocking: boolean;
  createdAt: number;
  projectKey: string;
  projectName: string;
}

export interface RunSnapshot {
  runId: string;
  featureId: string;
  status: RunState;
  revision: number;
  eventSeq: number;
  stageId: string | null;
  tokenUsage: number;
  activeMs: number;
  estimatedCostUsd: number | null;
  pendingRequestIds: string[];
  approvalDigest?: string | null;
  projectId?: string;
}

export interface RunList {
  items: RunSnapshot[];
  cursor?: string;
}

export interface Health {
  apiVersion: number;
  version: string;
  workspace: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

/** One Server-Sent Event as the main process parsed it. */
export interface StreamEvent {
  id: string | null;
  event: string;
  data: string;
}

export type Theme = "system" | "dark" | "light";

/** Settings of this app on this computer; agents and runs never read them. */
export interface AppSettings {
  theme: Theme;
  density: "comfortable" | "compact";
  openLastProjects: boolean;
  keepRunningInTray: boolean;
  notifyBlocking: boolean;
  notifyAdvisory: boolean;
  /** Absolute path of a `baked` executable to run instead of the bundled one. */
  bakedPath: string | null;
  openProjects: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  density: "comfortable",
  openLastProjects: true,
  keepRunningInTray: true,
  notifyBlocking: true,
  notifyAdvisory: false,
  bakedPath: null,
  openProjects: [],
};
