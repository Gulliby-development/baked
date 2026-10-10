import type { ApiResponse, RunSnapshot, StreamEvent } from "../../shared/api.js";
import type { HttpMethod } from "../../shared/bridge.js";
import { MOCK_CHAT_ROUTES, MOCK_CHAT_STREAMS } from "./mock-chat.js";
import { INSIGHTS_ROUTES } from "./mock-insights.js";

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
export const MOCK_ROUTES: MockRoute[] = [workflowRuns, ...MOCK_CHAT_ROUTES, ...INSIGHTS_ROUTES];

/** Sample event streams per feature; screens add theirs here. */
export const MOCK_STREAMS: MockStream[] = [...MOCK_CHAT_STREAMS];
