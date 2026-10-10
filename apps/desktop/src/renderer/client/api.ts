import type { ApiErrorBody, ApiResponse, RunList } from "../../shared/api.js";
import type { HttpMethod } from "../../shared/bridge.js";
import { bridge } from "./bridge.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function unwrap<T>(response: ApiResponse<unknown>): T {
  if (response.status >= 200 && response.status < 300) return response.body as T;
  const error = (response.body as Partial<ApiErrorBody> | null)?.error;
  throw new ApiError(
    response.status,
    error?.code ?? "HTTP_ERROR",
    error?.message ?? `Request failed with ${response.status}`,
  );
}

export async function call<T>(
  key: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  return unwrap<T>(await bridge.request(key, method, path, body));
}

export const api = {
  runs: (key: string, limit = 20) => call<RunList>(key, "GET", `/v1/workflow/runs?limit=${limit}`),
};
