import { recoveryOf } from "../../../../../src/core/workflows/remedies.js";
import type { ApiErrorBody, ApiResponse, RunList } from "../../shared/api.js";
import type { HttpMethod } from "../../shared/bridge.js";
import { bridge } from "./bridge.js";
import { invalidateProject, invalidateRead } from "./cache.js";
import { desktopRecoveryText } from "./remedies.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Every problem of a refused change, when the answer lists them (`ROUTING_REFUSED`). */
    readonly problems: string[] = [],
    /** A workflow refusal's cause, such as `git_required`. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

function unwrap<T>(response: ApiResponse<unknown>): T {
  if (response.status >= 200 && response.status < 300) return response.body as T;
  const answer = response.body as (Partial<ApiErrorBody> & { problems?: unknown }) | null;
  const error = answer?.error;
  const problems = Array.isArray(answer?.problems)
    ? answer.problems.filter((p): p is string => typeof p === "string")
    : [];
  throw new ApiError(
    response.status,
    error?.code ?? "HTTP_ERROR",
    desktopRecoveryText(
      error?.message ?? `Request failed with ${response.status}`,
      recoveryOf(error?.recovery),
    ),
    problems,
    typeof error?.reason === "string" ? error.reason : null,
  );
}

export async function call<T>(
  key: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  if (method === "GET" || READS.has(path))
    return unwrap<T>(await bridge.request(key, method, path, body));
  // A write, even a refused one, may change what any cached read of the project returned.
  try {
    return unwrap<T>(await bridge.request(key, method, path, body));
  } finally {
    invalidateProject(key);
    // Keys and sign-ins are the user's, not the project's: every project's model list changes.
    if (path.startsWith("/v1/providers/")) invalidateRead(MODELS_READ);
  }
}

/** The query name of `GET /v1/models`, shared by every model picker of a project. */
export const MODELS_READ = "models";

/** POST endpoints that only read: they leave the query cache alone. */
const READS = new Set(["/v1/graph"]);

export const api = {
  runs: (key: string, limit = 20) => call<RunList>(key, "GET", `/v1/workflow/runs?limit=${limit}`),
};
