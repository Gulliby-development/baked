import type { ApiResponse, RunSnapshot, StreamEvent } from "../../shared/api.js";
import type { HttpMethod } from "../../shared/bridge.js";
import { agentRoutes } from "./mock-agents.js";
import { artifactRoutes } from "./mock-artifacts.js";
import { attentionRoutes } from "./mock-attention.js";
import { MOCK_CHAT_ROUTES, MOCK_CHAT_STREAMS } from "./mock-chat.js";
import { diagnosticsRoutes } from "./mock-diagnostics.js";
import { editorRoutes } from "./mock-editor.js";
import { gitRoutes } from "./mock-git.js";
import { graphRoutes, progressRoutes } from "./mock-graph.js";
import { INSIGHTS_ROUTES } from "./mock-insights.js";
import { lspRoutes } from "./mock-lsp.js";
import { mcpRoutes } from "./mock-mcp.js";
import { packageRoutes } from "./mock-packages.js";
import { activeRunIds, freezeInputChanged, RUN_ROUTES, RUN_STREAMS } from "./mock-runs.js";
import { scheduleRoutes } from "./mock-schedules.js";
import { settingsRoutes } from "./mock-settings.js";
import { setupRoutes } from "./mock-setup.js";
import { startRoutes } from "./mock-start.js";

export interface MockRequest {
  key: string;
  method: HttpMethod;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/** Answers a request it knows, or returns undefined to let the next route try. */
export type MockRoute = (
  request: MockRequest,
) => ApiResponse | undefined | Promise<ApiResponse | undefined>;

/** Starts a stream it knows and returns its stop function, or undefined. */
export type MockStream = (stream: {
  key: string;
  path: string;
  emit: (event: StreamEvent) => void;
}) => (() => void) | undefined;

export function response<T>(status: number, body: unknown): ApiResponse<T> {
  return { status, body: body as T };
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

const RUNS: Record<string, RunSnapshot[]> = {
  baked: [
    run("usage-totals", "waiting", "plan", 412_000),
    run("headless-json", "waiting", "research", 96_000),
    run("locale-validation", "completed", "learn", 664_000),
  ],
  docs: [run("guide-refresh", "running", "implement", 230_000)],
  site: [run("pricing-table", "waiting", "plan", 180_000)],
  client: [],
};

const workflowRuns: MockRoute = ({ key, method, path }) =>
  method === "GET" && path === "/v1/workflow/runs"
    ? response(200, { items: RUNS[key] ?? [] })
    : undefined;

/** Sample answers per feature; screens add theirs here. */
/**
 * The project home and the setup screens both mock the project summary: the home's carries
 * sessions and runs, the setup screens' the working set and instructions they change.
 */
const projectSummary: MockRoute = async (request) => {
  if (request.method !== "GET" || request.path !== "/v1/projects/current") return undefined;
  const [home, setup] = await Promise.all([startRoutes(request), setupRoutes(request)]);
  if (home?.status !== 200 || setup?.status !== 200) return home ?? setup;
  const { workingSet, instructions } = setup.body as Record<string, unknown>;
  return response(200, { ...(home.body as object), workingSet, instructions });
};

/**
 * Saving an instruction file reports the runs that froze it, and stops those runs the way the
 * backend does. In the sample data every active run froze every instruction file.
 */
const instructionSave: MockRoute = async (request) => {
  if (request.method !== "PUT" || request.path !== "/v1/projects/current/instructions")
    return undefined;
  const saved = await setupRoutes(request);
  if (saved?.status !== 200) return saved;
  const affectedRuns = freezeInputChanged(request.key, activeRunIds(request.key));
  return response(200, { ...(saved.body as object), affectedRuns });
};

export const MOCK_ROUTES: MockRoute[] = [
  attentionRoutes,
  ...RUN_ROUTES,
  workflowRuns,
  projectSummary,
  instructionSave,
  startRoutes,
  setupRoutes,
  settingsRoutes,
  scheduleRoutes,
  ...MOCK_CHAT_ROUTES,
  ...INSIGHTS_ROUTES,
  graphRoutes,
  progressRoutes,
  mcpRoutes,
  lspRoutes,
  editorRoutes,
  gitRoutes,
  diagnosticsRoutes,
  artifactRoutes,
  packageRoutes,
  agentRoutes,
];

/** Sample event streams per feature; screens add theirs here. */
export const MOCK_STREAMS: MockStream[] = [...RUN_STREAMS, ...MOCK_CHAT_STREAMS];
