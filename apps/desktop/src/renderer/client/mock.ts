import {
  type ApiResponse,
  type AppSettings,
  type AttentionItem,
  DEFAULT_SETTINGS,
  type DesktopProject,
  type StreamEvent,
} from "../../shared/api.js";
import type { DesktopBridge, HttpMethod } from "../../shared/bridge.js";
import { MOCK_ROUTES, MOCK_STREAMS, response } from "./mock-routes.js";

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
    request: async <T>(
      key: string,
      method: HttpMethod,
      path: string,
      body?: unknown,
    ): Promise<ApiResponse<T>> => {
      const found = projects.find((p) => p.key === key);
      if (!found?.open)
        return response(409, { error: { code: "PROJECT_CLOSED", message: "Not open" } });
      if (method === "GET" && path === "/v1/health")
        return response(200, {
          apiVersion: 1,
          version: "0.1.1",
          workspace: found.path,
          capabilities: [
            "workflow",
            "attention",
            "projects",
            "sessions",
            "setup",
            "initiatives",
            "checks",
            "library",
          ],
        });
      const url = new URL(path, "http://mock");
      for (const route of MOCK_ROUTES) {
        const result = await route({
          key,
          method,
          path: url.pathname,
          query: url.searchParams,
          body,
        });
        if (result) return result as ApiResponse<T>;
      }
      return response(404, { error: { code: "NOT_FOUND", message: `Mock has no ${path}` } });
    },
    subscribe: (key: string, path: string, listener: (event: StreamEvent) => void) => {
      for (const stream of MOCK_STREAMS) {
        const stop = stream({ key, path, emit: listener });
        if (stop) return stop;
      }
      return () => {};
    },
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
