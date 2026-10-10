import type {
  ApiResponse,
  AppSettings,
  AttentionItem,
  DesktopProject,
  StreamEvent,
} from "./api.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ProjectAction = "pin" | "unpin" | "forget";

/**
 * What the preload script exposes as `window.baked`. Every call names a project by its key; the
 * main process owns the backends, their URLs and their tokens.
 */
export interface DesktopBridge {
  readonly platform: string;
  projects(): Promise<DesktopProject[]>;
  /** Re-reads the project list from `baked projects list --json`. */
  refreshProjects(): Promise<DesktopProject[]>;
  openProject(key: string): Promise<void>;
  closeProject(key: string): Promise<void>;
  restartProject(key: string): Promise<void>;
  /**
   * Pins, unpins or forgets a known folder through a running backend, or through the `baked`
   * command when none runs; returns the new list.
   */
  manageProject(key: string, action: ProjectAction): Promise<DesktopProject[]>;
  /** Shows the folder picker and adds the chosen folder; null when cancelled. */
  addFolder(): Promise<DesktopProject | null>;
  onProjects(listener: (projects: DesktopProject[]) => void): () => void;
  request<T = unknown>(
    key: string,
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>>;
  /** Streams an SSE endpoint; reconnects with Last-Event-ID until unsubscribed. */
  subscribe(
    key: string,
    path: string,
    listener: (event: StreamEvent) => void,
    lastEventId?: string,
  ): () => void;
  attention(): Promise<AttentionItem[]>;
  onAttention(listener: (items: AttentionItem[]) => void): () => void;
  settings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  openExternal(url: string): Promise<void>;
  /** The main process asks the window to show a route, e.g. after a notification click. */
  onNavigate(listener: (hash: string) => void): () => void;
}

export const IPC = {
  projects: "baked:projects",
  refreshProjects: "baked:projects:refresh",
  openProject: "baked:projects:open",
  closeProject: "baked:projects:close",
  restartProject: "baked:projects:restart",
  addFolder: "baked:projects:add-folder",
  manageProject: "baked:projects:manage",
  projectsChanged: "baked:projects:changed",
  request: "baked:api:request",
  subscribe: "baked:api:subscribe",
  unsubscribe: "baked:api:unsubscribe",
  streamEvent: "baked:api:event",
  attention: "baked:attention",
  attentionChanged: "baked:attention:changed",
  settings: "baked:settings",
  updateSettings: "baked:settings:update",
  openExternal: "baked:open-external",
  navigate: "baked:navigate",
} as const;
