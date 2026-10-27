import {
  type ApiResponse,
  type AppSettings,
  DEFAULT_SETTINGS,
  type DesktopProject,
  type StreamEvent,
} from "../../shared/api.js";
import type { DesktopBridge, HttpMethod } from "../../shared/bridge.js";
import { mockAttention } from "./mock-attention.js";
import { response } from "./mock-response.js";
import { MOCK_ROUTES, MOCK_STREAMS } from "./mock-routes.js";

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
    branch: "main",
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
 * Sample situations the preview and the UI tests (`e2e/`) pick with `?mock=NAME`:
 * - `default`: four projects, three of them open;
 * - `empty`: no projects yet (first start);
 * - `start-failure`: every project is closed and opening one fails; Restart then succeeds;
 * - `older`: the backends are an older BAKED that offers none of the optional capabilities;
 * - `uninitialized`: only `client-api`, open, in a folder without `baked/project.json`;
 * - `mic-denied`: as `default`, but the system refuses the microphone to voice input;
 * - `no-voice`: as `default`, but the speech engine is not installed.
 */
export const MOCK_SCENARIOS = [
  "default",
  "empty",
  "start-failure",
  "older",
  "uninitialized",
  "mic-denied",
  "no-voice",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export function mockScenario(search: string): MockScenario {
  const name = new URLSearchParams(search).get("mock") ?? "default";
  return (MOCK_SCENARIOS as readonly string[]).includes(name) ? (name as MockScenario) : "default";
}

const RUNNING: DesktopProject["backend"] = { kind: "running", version: "0.1.1" };
const OLDER_VERSION = "0.0.9";
const START_FAILURE: DesktopProject["backend"] = {
  kind: "failed",
  lastError: "baked serve exited with code 1 before it answered /v1/health",
  stderr: ["error: database is locked (.baked/workflows.sqlite)"],
};
const FULL_CAPABILITIES = [
  "workflow",
  "attention",
  "projects",
  "sessions",
  "setup",
  "initiatives",
  "checks",
  "library",
  "routing",
  "compaction",
  "diff-stats",
  "plan-mode",
  "chat-undo",
  "checkpoints",
  "run-memory",
  "critic-outcomes",
  "chat-memory",
  "images",
  "code-graph",
  "progress",
  "skills-install",
  "mcp",
  "lsp",
  "run-maintenance",
  "worktrees",
  "lsp-diagnose",
  "workflow-editor",
  "workflow-delete",
  "custom-commands",
  "commands-edit",
  "settings",
  "git",
  "git-graph",
  "hooks",
  "hooks-edit",
  "provider-switch",
  "provider-limits",
  "chat-export",
  "sdd-export",
  "sdd-import",
  "chat-effort",
  "watch",
  "diagnostics",
  "sandbox",
  "gate-drafts",
  "run-compare",
  "coordinator",
  "coordinator-schedules",
  "coordinator-summary",
  "artifacts",
  "packages",
  "project-agents",
  "permission-modes",
  "file-preview",
];
/** What a backend from before the optional capability groups answers. */
const OLDER_CAPABILITIES = ["workflow", "attention", "projects", "sessions", "setup"];

function sampleProjects(scenario: MockScenario): DesktopProject[] {
  const now = Date.now();
  const projects: DesktopProject[] = [
    project(
      "baked",
      "BAKED",
      "C:\\Project\\BAKED",
      { sessions: 3, lastSessionAt: now - HOUR, activeRuns: 2, attention: 4 },
      {
        pinned: true,
        projectId: "baked",
        open: true,
        backend: RUNNING,
      },
    ),
    project(
      "docs",
      "baked-docs",
      "C:\\Project\\baked-docs",
      { sessions: 1, lastSessionAt: now - 5 * HOUR, activeRuns: 1, attention: 0 },
      { open: true, backend: RUNNING },
    ),
    project(
      "site",
      "site",
      "C:\\Work\\site",
      { sessions: 2, lastSessionAt: now - 2 * HOUR, activeRuns: 1, attention: 2 },
      { branch: "feature/pricing", open: true, backend: RUNNING },
    ),
    project("client", "client-api", "C:\\Work\\client-api", {
      sessions: 4,
      lastSessionAt: now - 72 * HOUR,
      activeRuns: 0,
      attention: 0,
    }),
  ];
  if (scenario === "empty") return [];
  if (scenario === "uninitialized")
    return projects
      .filter((p) => p.key === "client")
      .map((p) => ({ ...p, open: true, backend: RUNNING }));
  if (scenario === "older")
    return projects.map((p) =>
      p.backend.kind === "running"
        ? { ...p, backend: { ...p.backend, version: OLDER_VERSION } }
        : p,
    );
  if (scenario === "start-failure")
    return projects.map((p) => ({ ...p, open: false, backend: { kind: "stopped" } }));
  return projects;
}

/**
 * A bridge with fixtures in place of the main process, so the renderer runs in a plain browser
 * (`bun run dev:web`) and screens can be built before the API they need exists.
 */
export function createMockBridge(scenario: MockScenario = "default"): DesktopBridge {
  let projects = sampleProjects(scenario);
  let settings: AppSettings = { ...DEFAULT_SETTINGS, theme: "dark" };
  const projectListeners = new Set<(p: DesktopProject[]) => void>();
  const emitProjects = (): void => {
    for (const listener of projectListeners) listener(projects);
  };
  const setBackend = (key: string, open: boolean, backend: DesktopProject["backend"]): void => {
    projects = projects.map((p) => (p.key === key ? { ...p, open, backend } : p));
    emitProjects();
  };
  const running: DesktopProject["backend"] =
    scenario === "older" ? { kind: "running", version: OLDER_VERSION } : RUNNING;
  const setOpen = (key: string, open: boolean): void =>
    setBackend(key, open, open ? running : { kind: "stopped" });

  return {
    platform: "mock",
    projects: async () => projects,
    refreshProjects: async () => projects,
    openProject: async (key) =>
      scenario === "start-failure" ? setBackend(key, false, START_FAILURE) : setOpen(key, true),
    closeProject: async (key) => setOpen(key, false),
    restartProject: async (key) => setOpen(key, true),
    addFolder: async () => null,
    pickFolder: async () => "/home/you/code",
    checkNewProject: async (draft) => {
      const path = draft.folder === null ? draft.parent : `${draft.parent}/${draft.folder}`;
      const taken = projects.some((p) => p.path === path);
      const error = !draft.name.trim()
        ? "Enter a project name."
        : taken
          ? `${path} is not empty. Choose an empty folder, or open it as an existing folder.`
          : null;
      return { path, creates: !taken && draft.folder !== null, error };
    },
    createProject: async (draft) => {
      const path = draft.folder === null ? draft.parent : `${draft.parent}/${draft.folder}`;
      const created = project(
        `p${projects.length + 1}`,
        draft.name.trim(),
        path,
        {
          sessions: 0,
          lastSessionAt: null,
          activeRuns: 0,
          attention: 0,
        },
        { open: true, backend: { kind: "running", version: "0.1.1" }, lastOpenedAt: Date.now() },
      );
      projects = [created, ...projects];
      emitProjects();
      return created;
    },
    manageProject: async (key, action) => {
      projects =
        action === "forget"
          ? projects.filter((p) => p.key !== key)
          : projects.map((p) => (p.key === key ? { ...p, pinned: action === "pin" } : p));
      emitProjects();
      return projects;
    },
    renameProject: async (key, name) => {
      const trimmed = name.trim();
      if (trimmed.length > 120) throw new Error("A project name has at most 120 characters.");
      projects = projects.map((p) =>
        p.key === key ? { ...p, name: trimmed || (p.path.split("/").at(-1) ?? p.path) } : p,
      );
      emitProjects();
      return projects;
    },
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
          version: scenario === "older" ? OLDER_VERSION : "0.1.1",
          workspace: found.path,
          capabilities: scenario === "older" ? OLDER_CAPABILITIES : FULL_CAPABILITIES,
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
      return response(404, {
        error: { code: "NOT_FOUND", message: `No endpoint ${path} in the mock` },
      });
    },
    subscribe: (key: string, path: string, listener: (event: StreamEvent) => void) => {
      for (const stream of MOCK_STREAMS) {
        const stop = stream({ key, path, emit: listener });
        if (stop) return stop;
      }
      return () => {};
    },
    exportChat: async (_key, sessionId, format) =>
      `/mock/exports/${sessionId}.${format === "json" ? "json" : "md"}`,
    attention: async () => mockAttention.items(),
    onAttention: (listener) => mockAttention.subscribe(listener),
    settings: async () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    showInFolder: async () => {},
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    onNavigate: () => () => {},
    windowAction: async () => {},
    onMaximized: () => () => {},
    voiceStatus: async () =>
      scenario === "no-voice"
        ? {
            available: false,
            reason:
              'The speech engine is not installed. Run "bun run stage:voice" in apps/desktop ("bun run dev" does it on start), then restart the app.',
          }
        : { available: true, model: "whistle" },
    transcribe: async (samples, language) => ({
      text: `mock transcript of ${(samples.length / 16_000).toFixed(1)} s`,
      language: language ?? "en",
      durationSeconds: samples.length / 16_000,
    }),
    microphoneAccess: async () =>
      scenario === "mic-denied"
        ? { granted: false, canOpenSettings: true }
        : { granted: true, canOpenSettings: true },
    openMicrophoneSettings: async () => {},
  };
}
