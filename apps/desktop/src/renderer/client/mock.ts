import {
  type ApiResponse,
  type AppSettings,
  type AttentionItem,
  DEFAULT_SETTINGS,
  type DesktopProject,
  type RunSnapshot,
  type StreamEvent,
} from "../../shared/api.js";
import type { DesktopBridge, HttpMethod } from "../../shared/bridge.js";

const HOUR = 3_600_000;

function project(
  key: string,
  name: string,
  path: string,
  overview: DesktopProject["overview"],
  extra: Partial<DesktopProject> = {},
): DesktopProject {
  const now = Date.now();
  return {
    key,
    name,
    path,
    projectId: null,
    pinned: false,
    addedAt: now - 30 * 24 * HOUR,
    lastOpenedAt: now - HOUR,
    exists: true,
    open: false,
    backend: { kind: "stopped" },
    overview,
    ...extra,
  };
}

function run(
  featureId: string,
  status: RunSnapshot["status"],
  stageId: string,
  tokens: number,
): RunSnapshot {
  return {
    runId: `run-${featureId}`,
    featureId,
    status,
    revision: 4,
    eventSeq: 120,
    stageId,
    tokenUsage: tokens,
    activeMs: 18 * 60_000,
    estimatedCostUsd: tokens / 1_000_000,
    pendingRequestIds: status === "waiting" ? ["req-1"] : [],
  };
}

/**
 * A bridge with fixtures in place of the main process, so the renderer runs in a plain browser
 * (`bun run dev:web`) and screens can be built before the API they need exists.
 */
export function createMockBridge(): DesktopBridge {
  const now = Date.now();
  let projects: DesktopProject[] = [
    project(
      "baked",
      "BAKED",
      "C:\\Project\\BAKED",
      { sessions: 3, lastSessionAt: now - HOUR, activeRuns: 2, attention: 4 },
      {
        pinned: true,
        projectId: "baked",
        open: true,
        backend: { kind: "running", version: "0.1.1" },
      },
    ),
    project(
      "docs",
      "baked-docs",
      "C:\\Project\\baked-docs",
      { sessions: 1, lastSessionAt: now - 5 * HOUR, activeRuns: 1, attention: 0 },
      { open: true, backend: { kind: "running", version: "0.1.1" } },
    ),
    project(
      "site",
      "site",
      "C:\\Work\\site",
      { sessions: 2, lastSessionAt: now - 2 * HOUR, activeRuns: 1, attention: 2 },
      { open: true, backend: { kind: "running", version: "0.1.1" } },
    ),
    project("client", "client-api", "C:\\Work\\client-api", {
      sessions: 4,
      lastSessionAt: now - 72 * HOUR,
      activeRuns: 0,
      attention: 0,
    }),
  ];
  const attention: AttentionItem[] = [
    item("baked", "BAKED", "usage-totals", "approval", true, 12),
    item("baked", "BAKED", "headless-json", "clarification", true, 4),
    item("baked", "BAKED", "locale-validation", "delivery", true, 20),
    item("site", "site", "pricing-table", "approval", true, 31),
    item("site", "site", "pricing-table", "clarification", true, 26),
    item("baked", "BAKED", "settings-dark-mode", "acceptance", false, 40),
  ];
  const runs: Record<string, RunSnapshot[]> = {
    baked: [
      run("usage-totals", "waiting", "plan", 412_000),
      run("headless-json", "waiting", "research", 96_000),
      run("locale-validation", "completed", "learn", 664_000),
    ],
    docs: [run("guide-refresh", "running", "implement", 230_000)],
    site: [run("pricing-table", "waiting", "plan", 180_000)],
    client: [],
  };
  let settings: AppSettings = { ...DEFAULT_SETTINGS, theme: "dark" };
  const projectListeners = new Set<(p: DesktopProject[]) => void>();
  const emitProjects = (): void => {
    for (const listener of projectListeners) listener(projects);
  };
  const setOpen = (key: string, open: boolean): void => {
    projects = projects.map((p) =>
      p.key === key
        ? {
            ...p,
            open,
            backend: open ? { kind: "running", version: "0.1.1" } : { kind: "stopped" },
          }
        : p,
    );
    emitProjects();
  };

  return {
    platform: "mock",
    projects: async () => projects,
    refreshProjects: async () => projects,
    openProject: async (key) => setOpen(key, true),
    closeProject: async (key) => setOpen(key, false),
    restartProject: async (key) => setOpen(key, true),
    addFolder: async () => null,
    onProjects: (listener) => {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
    request: async <T>(key: string, method: HttpMethod, path: string): Promise<ApiResponse<T>> => {
      const found = projects.find((p) => p.key === key);
      if (!found?.open)
        return response(409, { error: { code: "PROJECT_CLOSED", message: "Not open" } });
      if (method === "GET" && path === "/v1/health")
        return response(200, { apiVersion: 1, version: "0.1.1", workspace: found.path });
      if (method === "GET" && path.startsWith("/v1/workflow/runs"))
        return response(200, { items: runs[key] ?? [] });
      return response(404, { error: { code: "NOT_FOUND", message: `Mock has no ${path}` } });
    },
    subscribe: (_key: string, _path: string, _listener: (event: StreamEvent) => void) => () => {},
    attention: async () => attention,
    onAttention: () => () => {},
    settings: async () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    onNavigate: () => () => {},
  };

  function item(
    projectKey: string,
    projectName: string,
    featureId: string,
    kind: string,
    blocking: boolean,
    minutesAgo: number,
  ): AttentionItem {
    return {
      runId: `run-${featureId}`,
      featureId,
      status: blocking ? "waiting" : "running",
      requestId: `${featureId}-${kind}`,
      kind,
      blocking,
      createdAt: now - minutesAgo * 60_000,
      projectKey,
      projectName,
    };
  }
}

function response<T>(status: number, body: unknown): ApiResponse<T> {
  return { status, body: body as T };
}
