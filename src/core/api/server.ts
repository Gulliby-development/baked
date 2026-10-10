/**
 * Local HTTP API over the workflow core, served by `baked serve`.
 *
 * Every endpoint translates its request into the same `WorkflowArgs` the `baked workflow` CLI
 * parses and runs it through `executeWorkflowCommand`, so validation, access checks, approval
 * digests, revisions and command idempotency are those of the CLI. Runs started or resumed here
 * are driven in this process, like the CLI's foreground `run` and `resume`; the response returns
 * once the run has started and the drive continues in the background until the run waits, stops
 * or the server shuts down. Human decisions arrive through the approve, reject and answer
 * endpoints, after which a client resumes the run, exactly as with the CLI. Nothing here prompts
 * on a terminal: the workflow runtime has no TTY-bound step, its approvals are durable requests.
 *
 * The durable event log is authoritative. The event endpoint polls it by sequence and streams it
 * as Server-Sent Events whose `id` is the sequence, so a client resumes with `Last-Event-ID`.
 *
 * Security: binds 127.0.0.1 only; every request needs the per-start bearer token; the Host header
 * must name the loopback address and port (DNS rebinding); requests with an Origin header are
 * refused unless that origin was allowed explicitly.
 */
import { join } from "node:path";
import type { Server } from "bun";
import { ZodError, type z } from "zod";
import { executeWorkflowCommand } from "../../headless/workflow.js";
import { validateWorkflowArgs, type WorkflowArgs } from "../../headless/workflow-parse.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import { CURRENT_VERSION } from "../version.js";
import { WorkflowFault } from "../workflows/errors.js";
import { redactSecrets } from "../workflows/redaction.js";
import { type RunSnapshot, SafeId, type WorkflowErrorCode } from "../workflows/schemas.js";
import type { NativeWorkflowService } from "../workflows/service.js";
import {
  bearerMatches,
  generateApiToken,
  hostAllowed,
  normalizeOrigin,
  removeTokenFile,
  writeTokenFile,
} from "./auth.js";
import {
  AnswerBody,
  ApproveBody,
  CommandBody,
  EventsQuery,
  ExtendBody,
  ListQuery,
  RejectBody,
  StartBody,
} from "./schemas.js";

/** How long shutdown waits for the HTTP server to report its connections closed. */
const STOP_WAIT_MS = 1000;
export const API_VERSION = 1;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const EVENT_PAGE = 200;

export interface ApiServerOptions {
  service: NativeWorkflowService;
  /** 0 picks a free port. */
  port?: number;
  /** Defaults to `<workspace>/.baked/serve-<port>.token`. */
  tokenFile?: string;
  /** Exact origins (scheme://host[:port]) whose browser requests are accepted. */
  allowOrigins?: string[];
  /** Close the service on stop; false when the caller owns it. */
  ownsService?: boolean;
  pollMs?: number;
  heartbeatMs?: number;
  maxBodyBytes?: number;
  /** Receives one line per background drive failure. Defaults to stderr. */
  log?: (line: string) => void;
}

export interface ApiServer {
  url: string;
  port: number;
  tokenFile: string;
  token: string;
  /** Stops accepting, aborts active drives, closes streams and removes the token file. */
  stop(): Promise<void>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CONFLICTS: readonly WorkflowErrorCode[] = [
  "REVISION_CONFLICT",
  "COMMAND_CONFLICT",
  "STALE_DECISION",
  "WORKSPACE_BUSY",
  "INPUT_CHANGED",
  "RUN_TERMINAL",
];
export function faultStatus(code: WorkflowErrorCode): number {
  if (code === "NOT_FOUND" || code === "ARTIFACT_MISSING") return 404;
  if (["INVALID_DEFINITION", "INVALID_REFERENCE", "CYCLE_DETECTED"].includes(code)) return 400;
  if (code === "CAPABILITY_DENIED") return 403;
  if (CONFLICTS.includes(code)) return 409;
  return 500;
}

function errorOf(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ApiError)
    return { status: error.status, code: error.code, message: error.message };
  if (error instanceof WorkflowFault)
    return { status: faultStatus(error.code), code: error.code, message: error.message };
  if (error instanceof ZodError)
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    };
  if (error instanceof SyntaxError)
    return { status: 400, code: "INVALID_REQUEST", message: error.message };
  return {
    status: 500,
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}

const MUTATIONS = ["pause", "resume", "cancel", "approve", "reject", "answer", "extend"] as const;
type Mutation = (typeof MUTATIONS)[number];

const identity = (body: { commandId: string; expectedRevision: number }) => ({
  "command-id": body.commandId,
  "expected-revision": String(body.expectedRevision),
});

/** The CLI arguments a mutation body stands for. */
function mutationArgs(action: Mutation, runId: string, raw: unknown): WorkflowArgs {
  const args = (flags: WorkflowArgs["flags"], inline?: WorkflowArgs["inline"]): WorkflowArgs =>
    validateWorkflowArgs({
      command: action,
      positional: [runId],
      flags,
      ...(inline ? { inline } : {}),
    });
  switch (action) {
    case "pause":
    case "resume":
    case "cancel":
      return args(identity(CommandBody.parse(raw)));
    case "approve": {
      const body = ApproveBody.parse(raw);
      return args({
        ...identity(body),
        request: body.requestId,
        digest: body.digest,
        ...(body.excludeUserChanges ? { "exclude-user-changes": true as const } : {}),
      });
    }
    case "reject": {
      const body = RejectBody.parse(raw);
      return args({ ...identity(body), request: body.requestId, reason: body.reason });
    }
    case "answer": {
      const body = AnswerBody.parse(raw);
      return args(
        { ...identity(body), request: body.requestId, "answers-file": true },
        { "answers-file": body.answers },
      );
    }
    case "extend": {
      const body = ExtendBody.parse(raw);
      return args({
        ...identity(body),
        ...(body.tokens !== undefined ? { tokens: String(body.tokens) } : {}),
        ...(body.calls !== undefined ? { calls: String(body.calls) } : {}),
        ...(body.timeMs !== undefined ? { "time-ms": String(body.timeMs) } : {}),
      });
    }
  }
}

function startArgs(raw: unknown): WorkflowArgs {
  const body = StartBody.parse(raw);
  const flags: WorkflowArgs["flags"] = {
    "command-id": body.commandId,
    feature: body.feature,
    prompt: body.prompt,
    owner: body.owner ?? "API",
  };
  if (body.workflow) flags.workflow = body.workflow;
  if (body.model) flags.model = body.model;
  if (body.confirmAutoApproval) flags["confirm-auto-approval"] = body.confirmAutoApproval;
  if (body.worktree) flags.worktree = true;
  if (body.writers !== undefined) flags.writers = String(body.writers);
  if (body.policy !== undefined) flags.policy = true;
  return validateWorkflowArgs({
    command: "run",
    positional: [],
    flags,
    ...(body.policy !== undefined ? { inline: { policy: body.policy } } : {}),
  });
}

function queryOf<T extends z.ZodType>(url: URL, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(url.searchParams));
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { service } = options;
  const pollMs = options.pollMs ?? 250;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowOrigins = new Set((options.allowOrigins ?? []).map(normalizeOrigin));
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const token = generateApiToken();
  const shutdown = new AbortController();
  /** Background drives started by run and resume requests. */
  const drives = new Set<Promise<unknown>>();
  /** The latest background drive of each run. */
  const runDrives = new Map<string, Promise<unknown>>();
  /** Close functions of open event streams. */
  const streams = new Set<() => void>();
  const encoder = new TextEncoder();
  let port = 0;

  const headers = (origin: string | null, extra: Record<string, string> = {}) => ({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    ...extra,
  });
  const json = (status: number, body: unknown, origin: string | null): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: headers(origin, { "Content-Type": "application/json; charset=utf-8" }),
    });
  const failure = (error: unknown, origin: string | null): Response => {
    const { status, code, message } = errorOf(error);
    return json(status, { error: { code, message: redactSecrets(message) } }, origin);
  };

  async function readJson(req: Request): Promise<unknown> {
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBodyBytes)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBodyBytes} bytes`);
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? ""))
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json");
    if (!req.body) throw new ApiError(400, "INVALID_REQUEST", "Request body is required");
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBodyBytes} bytes`);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  const execute = (args: WorkflowArgs): Promise<unknown> =>
    executeWorkflowCommand(service, args, shutdown.signal);

  /**
   * Runs a `run` or `resume` command like the CLI and answers once it starts driving. The drive
   * keeps going in the background; its outcome is in the event log and the run status.
   */
  async function launch(args: WorkflowArgs): Promise<RunSnapshot> {
    let started = false;
    let onDrive: (runId: string) => void = () => {};
    const driving = new Promise<string>((resolve) => {
      onDrive = resolve;
    });
    let driven: string | undefined;
    const execution = executeWorkflowCommand(service, args, shutdown.signal, (runId) => {
      started = true;
      driven = runId;
      // A second drive of a run this server is driving fails at once; keep waiting on the first.
      if (!runDrives.has(runId)) runDrives.set(runId, tracked);
      onDrive(runId);
    });
    const tracked: Promise<unknown> = execution
      .catch((error: unknown) => {
        if (!started) return;
        const { code, message } = errorOf(error);
        log(JSON.stringify({ event: "drive-error", code, message: redactSecrets(message) }));
      })
      .finally(() => {
        drives.delete(tracked);
        if (driven !== undefined && runDrives.get(driven) === tracked) runDrives.delete(driven);
      });
    drives.add(tracked);
    const runId = await Promise.race([driving, execution.then(() => undefined)]);
    if (!runId) throw new ApiError(500, "INTERNAL", "The run did not start");
    return service.get(runId);
  }

  /**
   * The runtime commits a run's waiting or stopped status before its drive has saved the last
   * state, so a decision must wait for a drive that has already stopped to return. A drive that
   * is still running is left alone: pause and cancel stop it themselves.
   */
  async function settle(runId: string): Promise<void> {
    const drive = runDrives.get(runId);
    if (drive && service.store.run(runId).status !== "running") await drive;
  }

  function eventStream(req: Request, runId: string, after: number, origin: string | null) {
    let seq = after;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let close = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string): void => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          streams.delete(close);
          req.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            // The client already went away.
          }
        };
        const poll = (): void => {
          if (closed) return;
          try {
            for (;;) {
              const page = service.store.events(runId, seq, EVENT_PAGE);
              for (const event of page) {
                send(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
                seq = event.seq;
              }
              if (page.length < EVENT_PAGE) break;
            }
          } catch (error) {
            const { code, message } = errorOf(error);
            send(
              `event: error\ndata: ${JSON.stringify({ error: { code, message: redactSecrets(message) } })}\n\n`,
            );
            close();
            return;
          }
          timer = setTimeout(poll, pollMs);
        };
        streams.add(close);
        req.signal.addEventListener("abort", close, { once: true });
        heartbeat = setInterval(() => send(": keep-alive\n\n"), heartbeatMs);
        send("retry: 1000\n\n");
        poll();
      },
      cancel() {
        close();
      },
    });
    return new Response(stream, {
      headers: headers(origin, {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      }),
    });
  }

  async function route(
    req: Request,
    url: URL,
    origin: string | null,
    server: Server<undefined>,
  ): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;
    const only = (expected: string): void => {
      if (method !== expected)
        throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${expected} for ${path}`);
    };
    if (path === "/v1/health") {
      only("GET");
      return json(
        200,
        { apiVersion: API_VERSION, version: CURRENT_VERSION, workspace: service.workspace },
        origin,
      );
    }
    if (path === "/v1/workflow/definitions" || path === "/v1/workflow/profiles") {
      only("GET");
      const command = path.endsWith("definitions") ? "definitions" : "profiles";
      return json(200, await execute({ command, positional: [], flags: {} }), origin);
    }
    if (path === "/v1/workflow/runs") {
      if (method === "POST") return json(202, await launch(startArgs(await readJson(req))), origin);
      only("GET");
      const query = queryOf(url, ListQuery);
      const flags: WorkflowArgs["flags"] = {};
      if (query.feature) flags.feature = query.feature;
      if (query.status) flags.status = query.status;
      if (query.limit) flags.limit = query.limit;
      if (query.cursor) flags.cursor = query.cursor;
      return json(
        200,
        await execute(validateWorkflowArgs({ command: "list", positional: [], flags })),
        origin,
      );
    }
    const match = /^\/v1\/workflow\/runs\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (!match?.[1]) throw new ApiError(404, "NOT_FOUND", `No endpoint ${path}`);
    const runId = SafeId.parse(decodeURIComponent(match[1]));
    const action = match[2];
    if (action === undefined) {
      only("GET");
      return json(
        200,
        await execute({ command: "status", positional: [runId], flags: {} }),
        origin,
      );
    }
    if ((MUTATIONS as readonly string[]).includes(action)) {
      only("POST");
      const args = mutationArgs(action as Mutation, runId, await readJson(req));
      if (action !== "pause" && action !== "cancel") await settle(runId);
      return json(200, action === "resume" ? await launch(args) : await execute(args), origin);
    }
    if (action === "usage" || action === "artifacts") {
      only("GET");
      const file = action === "artifacts" ? url.searchParams.get("file") : null;
      return json(
        200,
        await execute({
          command: action,
          positional: [runId],
          flags: file ? { file: SafeId.parse(file) } : {},
        }),
        origin,
      );
    }
    if (action === "events") {
      only("GET");
      const query = queryOf(url, EventsQuery);
      service.store.run(runId);
      const lastEventId = req.headers.get("last-event-id");
      if (lastEventId !== null && !/^\d+$/.test(lastEventId))
        throw new ApiError(400, "INVALID_REQUEST", "Last-Event-ID must be an event sequence");
      const after = Number(lastEventId ?? query.after ?? 0);
      const accept = req.headers.get("accept") ?? "";
      if (/application\/json/i.test(accept) && !/text\/event-stream/i.test(accept)) {
        const limit = Math.min(Math.max(Number(query.limit ?? EVENT_PAGE), 1), 1000);
        const events = service.store.events(runId, after, limit);
        return json(200, { events, lastSeq: events.at(-1)?.seq ?? after }, origin);
      }
      // Event streams outlive the server's idle timeout; heartbeats keep intermediaries open.
      server.timeout(req, 0);
      return eventStream(req, runId, after, origin);
    }
    throw new ApiError(404, "NOT_FOUND", `No endpoint ${path}`);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(req, server) {
      const origin = req.headers.get("origin");
      const allowedOrigin = origin !== null && allowOrigins.has(origin) ? origin : null;
      try {
        if (shutdown.signal.aborted)
          throw new ApiError(503, "SHUTTING_DOWN", "The server is shutting down");
        if (!hostAllowed(req.headers.get("host"), port))
          throw new ApiError(421, "HOST_REJECTED", "Host header must name 127.0.0.1 or localhost");
        if (origin !== null && !allowedOrigin)
          throw new ApiError(403, "ORIGIN_REJECTED", "Origin is not allowed");
        if (req.method === "OPTIONS" && allowedOrigin)
          return new Response(null, {
            status: 204,
            headers: headers(allowedOrigin, {
              "Access-Control-Allow-Methods": "GET, POST",
              "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
              "Access-Control-Max-Age": "600",
            }),
          });
        if (!bearerMatches(req.headers.get("authorization"), token))
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } }),
            {
              status: 401,
              headers: headers(allowedOrigin, {
                "Content-Type": "application/json; charset=utf-8",
                "WWW-Authenticate": 'Bearer realm="baked"',
              }),
            },
          );
        return await route(req, new URL(req.url), allowedOrigin, server);
      } catch (error) {
        return failure(error, allowedOrigin);
      }
    },
  });
  port = server.port ?? 0;
  const tokenFile =
    options.tokenFile ?? join(ensurebakedDir(service.workspace), `serve-${port}.token`);
  try {
    writeTokenFile(tokenFile, token);
  } catch (error) {
    await server.stop(true);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      shutdown.abort(new Error("API server shutdown"));
      for (const close of [...streams]) close();
      try {
        // stop(true) closes every connection at once. On Bun 1.3.13 its promise can stay pending
        // after a client cancelled an event stream, so the wait for it is bounded.
        await Promise.race([server.stop(true), Bun.sleep(STOP_WAIT_MS)]);
        await Promise.allSettled([...drives]);
        await service.shutdown();
        if (options.ownsService) service.close();
      } finally {
        removeTokenFile(tokenFile);
      }
    })();
    return stopping;
  };
  return { url: `http://127.0.0.1:${port}`, port, tokenFile, token, stop };
}
