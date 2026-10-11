import type { ApiResponse } from "../../shared/api.js";
import type {
  BackgroundError,
  CleanupTarget,
  ModelAggregate,
  ModelCallEvent,
  ModelEventsView,
  StorageView,
} from "./diagnostics.js";
import { type MockRoute, response } from "./mock-routes.js";

const KB = 1024;
const MB = 1024 * KB;

interface DiagnosticsState {
  storage: StorageView;
  enabled: boolean;
  events: ModelCallEvent[];
  errors: BackgroundError[];
}

const states = new Map<string, DiagnosticsState>();

function totals(storage: StorageView): StorageView {
  const p = storage.project;
  const g = storage.global;
  return {
    ...storage,
    project: {
      ...p,
      totalBytes: p.repoMapBytes + p.sessionsBytes + p.memoryBytes + p.plansBytes + p.configBytes,
    },
    global: {
      ...g,
      totalBytes: g.historyBytes + g.memoryBytes + g.configBytes + g.binariesBytes,
    },
  };
}

function state(key: string): DiagnosticsState {
  const found = states.get(key);
  if (found) return found;
  const now = Date.now();
  const created: DiagnosticsState = {
    storage: totals({
      projectDir: `C:\\Project\\${key}\\.baked`,
      globalDir: "C:\\Users\\me\\.baked",
      project: {
        totalBytes: 0,
        repoMapBytes: 18 * MB,
        sessionsBytes: 2.4 * MB,
        sessionCount: 7,
        memoryBytes: 96 * KB,
        plansBytes: 40 * KB,
        configBytes: 2 * KB,
      },
      global: {
        totalBytes: 0,
        historyBytes: 380 * KB,
        memoryBytes: 64 * KB,
        configBytes: 3 * KB,
        binariesBytes: 42 * MB,
      },
    }),
    enabled: true,
    events: [
      {
        id: "ev-3",
        modelId: "anthropic/claude-sonnet-4-5",
        source: "main",
        startedAt: now - 40_000,
        durationMs: 0,
        state: "error",
        sessionId: "s-1",
        errorMessage: "Provider returned a transient error (529 overloaded). Please retry.",
      },
      {
        id: "ev-2",
        modelId: "anthropic/claude-sonnet-4-5",
        source: "main",
        startedAt: now - 70_000,
        durationMs: 4_200,
        state: "ok",
        sessionId: "s-1",
        input: 18_400,
        output: 920,
        cacheRead: 12_000,
        cacheWrite: 0,
      },
      {
        id: "ev-1",
        modelId: "openai/gpt-5-mini",
        source: "run",
        startedAt: now - 300_000,
        durationMs: 2_100,
        state: "ok",
        runId: "run-usage-totals",
        agentId: "planner",
        input: 9_000,
        output: 1_400,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
    errors: [
      {
        id: "err-2",
        source: "lsp",
        message: "typescript-language-server exited with code 1",
        timestamp: now - 120_000,
      },
      {
        id: "err-1",
        source: "hooks",
        message: "PostToolUse hook timed out after 30s",
        timestamp: now - 600_000,
      },
    ],
  };
  states.set(key, created);
  return created;
}

function aggregate(events: readonly ModelCallEvent[]): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>();
  for (const ev of [...events].reverse()) {
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
  for (const agg of byModel.values())
    agg.avgMs = agg.calls ? Math.round(agg.totalMs / agg.calls) : 0;
  return [...byModel.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function view(s: DiagnosticsState): ModelEventsView {
  return { enabled: s.enabled, events: s.events, models: aggregate(s.events) };
}

const fail = (status: number, code: string, message: string): ApiResponse =>
  response(status, { error: { code, message } });

const TARGETS: CleanupTarget[] = ["repo-map", "sessions", "plans", "history", "vacuum"];

function cleanup(s: DiagnosticsState, body: unknown): ApiResponse {
  const { target, confirm } = (body ?? {}) as { target?: CleanupTarget; confirm?: unknown };
  if (!target || !TARGETS.includes(target))
    return fail(400, "INVALID_REQUEST", "target: Invalid option");
  if (target !== "vacuum" && confirm !== true)
    return fail(400, "INVALID_REQUEST", "confirm: Deleting data needs confirm: true");
  const p = { ...s.storage.project };
  const g = { ...s.storage.global };
  let freedBytes = 0;
  let removed: number | undefined;
  if (target === "repo-map") {
    freedBytes = p.repoMapBytes;
    p.repoMapBytes = 0;
  } else if (target === "sessions") {
    freedBytes = p.sessionsBytes;
    removed = p.sessionCount;
    p.sessionsBytes = 0;
    p.sessionCount = 0;
  } else if (target === "plans") {
    freedBytes = p.plansBytes;
    p.plansBytes = 0;
  } else if (target === "history") {
    freedBytes = g.historyBytes;
    g.historyBytes = 0;
  } else {
    freedBytes = Math.round(p.memoryBytes / 4);
    p.memoryBytes -= freedBytes;
  }
  s.storage = totals({ ...s.storage, project: p, global: g });
  return response(200, {
    target,
    freedBytes,
    ...(removed !== undefined ? { removed } : {}),
    storage: s.storage,
  });
}

export const diagnosticsRoutes: MockRoute = ({ key, method, path, body }) => {
  if (!path.startsWith("/v1/diagnostics/")) return undefined;
  const s = state(key);
  switch (`${method} ${path}`) {
    case "GET /v1/diagnostics/storage":
      return response(200, s.storage);
    case "POST /v1/diagnostics/storage/cleanup":
      return cleanup(s, body);
    case "GET /v1/diagnostics/model-events":
      return response(200, view(s));
    case "POST /v1/diagnostics/model-events": {
      const action = (body as { action?: string } | null)?.action;
      if (action === "clear") s.events = [];
      else if (action === "enable") s.enabled = true;
      else if (action === "disable") {
        s.enabled = false;
        s.events = [];
      } else return fail(400, "INVALID_REQUEST", "action: Invalid option");
      return response(200, view(s));
    }
    case "GET /v1/diagnostics/errors":
      return response(200, { errors: s.errors });
    default:
      return fail(404, "NOT_FOUND", `No endpoint ${path}`);
  }
};
