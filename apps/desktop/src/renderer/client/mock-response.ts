import type { ApiResponse, StreamEvent } from "../../shared/api.js";
import type { HttpMethod } from "../../shared/bridge.js";

// The route modules import these from here, not from mock-routes.ts, which imports every route
// module: through that cycle, a test that loaded a route module first met mock-routes.ts before
// the route module had defined its routes.

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
