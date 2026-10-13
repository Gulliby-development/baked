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
/** What the Create project dialog sends: a location and either a subfolder name or null. */
export interface NewProjectDraft {
  name: string;
  /** The folder picked with Browse…. */
  parent: string;
  /** A new subfolder of `parent`, or null to use `parent` itself. */
  folder: string | null;
}

/** `baked projects create --check --json`: where the project would go and why it cannot. */
export interface NewProjectCheck {
  path: string;
  creates: boolean;
  error: string | null;
}

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
  /** Why the run is in this state (`approval`, `input_changed`, `budget_exhausted`, ...). */
  reason?: string;
  revision: number;
  eventSeq: number;
  stageId: string | null;
  tokenUsage: number;
  activeMs: number;
  estimatedCostUsd: number | null;
  pendingRequestIds: string[];
  /** Findings the run is accepted with; absent from servers before the field existed. */
  limitations?: { count: number; ids: string[] };
  /** Review findings that started no correction (listed in the run report); absent from older servers. */
  reviewNotes?: { count: number; ids: string[] };
  /** Present while a running run has journaled nothing for longer than the stall limit. */
  stalled?: { silentMs: number; lastEventAt: string | null };
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

/** Languages the Whistle speech model transcribes; omitting one lets the model detect it. */
export const VOICE_LANGUAGES = ["en", "de", "fr", "es", "it", "nl", "pl"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const VOICE_LANGUAGE_NAMES: Record<VoiceLanguage, string> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
};

/** Whether the local speech engine can transcribe here, and why not. */
export interface VoiceStatus {
  available: boolean;
  /** Why transcription is unavailable; set only when `available` is false. */
  reason?: string;
  /** The model that transcribes; set only when `available` is true. */
  model?: string;
}

/** Whether the system lets the app use the microphone. */
export interface MicrophoneAccess {
  granted: boolean;
  /** The system has a microphone privacy page the app can open (macOS, Windows). */
  canOpenSettings: boolean;
}

/** One transcribed recording. */
export interface VoiceTranscript {
  text: string;
  /** The detected or requested language code; empty for silence. */
  language: string;
  durationSeconds: number;
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
  /** The microphone button in the chat composer. */
  voiceInput: boolean;
  /** The language voice input transcribes; "auto" lets the model detect it. */
  voiceLanguage: VoiceLanguage | "auto";
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
  voiceInput: true,
  voiceLanguage: "auto",
};
