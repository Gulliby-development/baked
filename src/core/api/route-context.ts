import type { z } from "zod";

/** What a route module of the local API needs from the server for one request. */
export interface RouteContext {
  req: Request;
  url: URL;
  /** The path without a trailing slash. */
  path: string;
  method: string;
  json(status: number, body: unknown): Response;
  readJson(): Promise<unknown>;
  query<T extends z.ZodType>(schema: T): z.infer<T>;
  fail(status: number, code: string, message: string): never;
  /** Throws 405 unless the request uses one of the methods. */
  only(...methods: string[]): void;
  /** A pushed SSE response; `attach` returns the function that detaches the source. */
  stream(attach: (send: (text: string) => void, close: () => void) => () => void): Response;
  /** A polled SSE response; `tick` runs every poll interval. */
  poll(tick: (send: (text: string) => void) => void): Response;
  /** Whether the client asked for JSON instead of an event stream. */
  wantsJson(): boolean;
  /** Lets a stream outlive the server's idle timeout. */
  keepOpen(): void;
}
