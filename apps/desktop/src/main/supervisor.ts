import type {
  ApiResponse,
  BackendState,
  DesktopProject,
  KnownProject,
  StreamEvent,
} from "../shared/api.js";
import type { HttpMethod } from "../shared/bridge.js";
import { type Backend, BackendError } from "./backend.js";
import { projectKey } from "./project-key.js";
import { SseParser } from "./sse.js";

export interface SupervisorOptions {
  listProjects: () => Promise<KnownProject[]>;
  createBackend: (
    project: KnownProject,
    key: string,
    onState: (state: BackendState) => void,
  ) => Backend;
  fetch?: typeof fetch;
  onChange?: (projects: DesktopProject[]) => void;
  reconnectDelayMs?: number;
}

const FINAL_STREAM_ERRORS = ["STREAM_REFUSED", "PROJECT_CLOSED", "BACKEND_FAILED"];

export interface Stream {
  close(): void;
}

const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Only the versioned API is reachable from the renderer, and only with the methods it uses. */
export function checkApiPath(method: string, path: string): void {
  if (!API_METHODS.has(method))
    throw new BackendError("INVALID_REQUEST", `Method ${method} is not allowed`);
  if (!/^\/v1\/[A-Za-z0-9._~%/-]*(\?[^#]*)?$/.test(path) || /(^|\/)\.\.?(\/|\?|$)/.test(path))
    throw new BackendError("INVALID_REQUEST", `Path ${path} is not an API path`);
}

/**
 * Owns the project list and one backend per open project. All API traffic from the renderer goes
 * through `request` and `stream`, which add the backend's bearer token.
 */
export class ProjectSupervisor {
  private known: KnownProject[] = [];
  private readonly backends = new Map<string, Backend>();
  private readonly states = new Map<string, BackendState>();

  constructor(private readonly options: SupervisorOptions) {}

  projects(): DesktopProject[] {
    return this.known.map((project) => {
      const key = projectKey(project.path);
      return {
        ...project,
        key,
        open: this.backends.has(key),
        backend: this.states.get(key) ?? { kind: "stopped" },
      };
    });
  }

  async refresh(): Promise<DesktopProject[]> {
    this.known = await this.options.listProjects();
    this.changed();
    return this.projects();
  }

  /** Keys of the open projects, in the order they were opened. */
  openKeys(): string[] {
    return [...this.backends.keys()];
  }

  async open(key: string): Promise<void> {
    if (this.backends.has(key)) return;
    const project = this.known.find((p) => projectKey(p.path) === key);
    if (!project) throw new BackendError("NOT_FOUND", "Unknown project");
    if (!project.exists) throw new BackendError("NOT_FOUND", `${project.path} no longer exists`);
    const backend = this.options.createBackend(project, key, (state) => {
      this.states.set(key, state);
      this.changed();
    });
    this.backends.set(key, backend);
    this.changed();
    await backend.start();
  }

  async close(key: string): Promise<void> {
    const backend = this.backends.get(key);
    if (!backend) return;
    this.backends.delete(key);
    await backend.stop();
    this.states.delete(key);
    this.changed();
  }

  async restart(key: string): Promise<void> {
    const backend = this.backends.get(key);
    if (!backend) return this.open(key);
    await backend.restart();
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.backends.keys()].map((key) => this.close(key)));
  }

  async request<T>(
    key: string,
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    checkApiPath(method, path);
    const { url, token } = await this.backend(key).endpointOrStart();
    const response = await (this.options.fetch ?? fetch)(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: hand the text over as it is.
    }
    return { status: response.status, body: parsed as T };
  }

  /**
   * Streams an SSE endpoint. A dropped connection, including one lost to a backend restart, is
   * reopened with the last event ID until `close` is called.
   */
  stream(
    key: string,
    path: string,
    onEvent: (event: StreamEvent) => void,
    lastEventId?: string,
    onError?: (error: Error) => void,
  ): Stream {
    checkApiPath("GET", path);
    const abort = new AbortController();
    let last = lastEventId;
    const run = async (): Promise<void> => {
      while (!abort.signal.aborted) {
        try {
          const { url, token } = await this.backend(key).endpointOrStart();
          const response = await (this.options.fetch ?? fetch)(`${url}${path}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "text/event-stream",
              ...(last ? { "Last-Event-ID": last } : {}),
            },
            signal: abort.signal,
          });
          if (!response.ok || !response.body) {
            const text = await response.text();
            throw new BackendError(
              response.status < 500 ? "STREAM_REFUSED" : "STREAM_FAILED",
              `${path} returned ${response.status}: ${text.slice(0, 200)}`,
            );
          }
          const parser = new SseParser();
          const decoder = new TextDecoder();
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
              if (event.id) last = event.id;
              onEvent(event);
            }
          }
        } catch (error) {
          if (abort.signal.aborted) return;
          onError?.(error instanceof Error ? error : new Error(String(error)));
          // A refused stream (unknown run, bad request, closed project) does not recover by retrying.
          if (error instanceof BackendError && FINAL_STREAM_ERRORS.includes(error.code)) return;
        }
        await sleep(this.options.reconnectDelayMs ?? 1000, abort.signal);
      }
    };
    // Started on a later tick, so the caller holds the stream before any backend state change.
    void Promise.resolve().then(run);
    return { close: () => abort.abort() };
  }

  private backend(key: string): Backend {
    const backend = this.backends.get(key);
    if (!backend) throw new BackendError("PROJECT_CLOSED", "The project is not open");
    return backend;
  }

  private changed(): void {
    this.options.onChange?.(this.projects());
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
