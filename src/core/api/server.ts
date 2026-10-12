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
 * The attention endpoint polls the store the same way for everything that waits for a person
 * across all runs and streams the whole list whenever it changes.
 *
 * The project endpoints report the workspace's project (`baked/project.json`) with its working
 * set, sessions and runs, and change the working set, as `baked project` does. `GET /v1/projects`
 * lists every folder BAKED was opened in with its session and run counts, as `baked projects`
 * does; each folder is served by its own `baked serve`.
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
import { BakeChatHost } from "../chat/host.js";
import { scriptedHostFromEnv } from "../chat/scripted-host.js";
import { ChatError, ChatService } from "../chat/sessions.js";
import type { ContextManager } from "../context/manager.js";
import { storageDirs } from "../diagnostics/storage.js";
import { runsFreezingFile } from "../instruction-files.js";
import { CodeGraphCache } from "../intelligence/code-graph.js";
import type { LspServiceDeps } from "../intelligence/lsp-service.js";
import { MemoryManager } from "../memory/manager.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import { progress } from "../progress.js";
import { listKnownProjects } from "../projects/known.js";
import { projectOverview } from "../projects/overview.js";
import { realPath } from "../projects/paths.js";
import { ProjectService } from "../projects/service.js";
import type { SkillCatalog } from "../skills/manager.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import { CURRENT_VERSION } from "../version.js";
import { type AttentionItem, attentionItems } from "../workflows/attention.js";
import { WorkflowFault } from "../workflows/errors.js";
import { InitiativeService } from "../workflows/initiatives/service.js";
import { redactSecrets } from "../workflows/redaction.js";
import { type RunSnapshot, SafeId, type WorkflowErrorCode } from "../workflows/schemas.js";
import type { NativeWorkflowService } from "../workflows/service.js";
import { usageSummary } from "../workflows/usage.js";
import {
  bearerMatches,
  generateApiToken,
  hostAllowed,
  normalizeOrigin,
  removeTokenFile,
  writeTokenFile,
} from "./auth.js";
import { chatMemoryRoute } from "./chat-memory-routes.js";
import { chatErrorStatus, chatRoute } from "./chat-routes.js";
import { type CheckRunRecord, checkRoute } from "./check-routes.js";
import { diagnosticsRoute } from "./diagnostics-routes.js";
import { gitRoute } from "./git-routes.js";
import { graphRoute } from "./graph-routes.js";
import { hooksRoute } from "./hooks-routes.js";
import { initiativeRoute } from "./initiative-routes.js";
import { type LspRouteContext, lspRoute } from "./lsp-routes.js";
import { mcpRoute } from "./mcp-routes.js";
import { memoryRoute } from "./memory-routes.js";
import { progressRoute } from "./progress-routes.js";
import type { RouteContext } from "./route-context.js";
import {
  AnswerBody,
  ApproveBody,
  CandidateBody,
  CommandBody,
  ContinueBody,
  DeliverBody,
  DeliverExecuteBody,
  EventsQuery,
  EvidenceBody,
  ExtendBody,
  GatesConfirmBody,
  ListQuery,
  PreRunQuery,
  RecoverBody,
  RejectBody,
  RerouteBody,
  ReviseBody,
  RouteQuery,
  StartBody,
  UndoBody,
  UsageQuery,
  WorkingSetBody,
} from "./schemas.js";
import { type SettingsSecretStore, settingsRoute } from "./settings-routes.js";
import { setupRoute } from "./setup-routes.js";

/** How long shutdown waits for the HTTP server to report its connections closed. */
const STOP_WAIT_MS = 1000;
export const API_VERSION = 1;
/** The endpoint groups of `docs/desktop/api.md` this server implements. */
export const CAPABILITIES = [
  "workflow",
  "attention",
  "projects",
  "project-rename",
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
  "chat-memory",
  "images",
  "code-graph",
  "skills-install",
  "mcp",
  "lsp",
  "lsp-diagnose",
  "custom-commands",
  "settings",
  "git",
  "hooks",
  "provider-switch",
  "chat-export",
  "diagnostics",
  "progress",
] as const;
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
  /** The user configuration directory that holds the project registry; tests point it elsewhere. */
  configDir?: string;
  /** The home directory holding global commands and skills; tests point it elsewhere. */
  homeDir?: string;
  /** The skills.sh catalog and installer; tests pass a fake one. */
  skillCatalog?: SkillCatalog;
  /** Where secret settings such as web search keys live; tests pass an in-memory one. */
  settingsSecrets?: SettingsSecretStore;
  /** Language-server lookups and installs; tests pass fakes. */
  lspDeps?: Partial<LspServiceDeps>;
  /** Replaces the code intelligence health check of `POST /v1/lsp/diagnose` in tests. */
  lspDiagnose?: LspRouteContext["diagnose"];
  /** Chat sessions; defaults to one over the workspace's sessions with the terminal UI's agent. */
  chat?: ChatService;
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
  if (error instanceof ChatError)
    return { status: chatErrorStatus(error), code: error.code, message: error.message };
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

const MUTATIONS = [
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "answer",
  "extend",
  "reroute",
  "continue",
  "accept",
  "evidence",
  "recover",
  "fork",
  "undo",
  "discard-worktree",
  "revise",
] as const;
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
    case "fork":
    case "discard-worktree":
      return args(identity(CommandBody.parse(raw)));
    case "continue":
    case "accept": {
      const body = ContinueBody.parse(raw);
      return args({ ...identity(body), request: body.requestId });
    }
    case "evidence": {
      const body = EvidenceBody.parse(raw);
      return args(
        {
          ...identity(body),
          request: body.requestId,
          file: true,
          ...(body.accepted ? { accept: true as const } : {}),
        },
        { file: body.evidence },
      );
    }
    case "recover": {
      const body = RecoverBody.parse(raw);
      return args(
        {
          ...identity(body),
          request: body.requestId,
          effect: body.effectId,
          resolution: body.resolution,
          file: true,
        },
        { file: body.evidence },
      );
    }
    case "revise": {
      const body = ReviseBody.parse(raw);
      return args({ ...identity(body), candidate: body.candidate });
    }
    case "undo": {
      const body = UndoBody.parse(raw);
      return args({ ...identity(body), ...(body.path ? { path: body.path } : {}) });
    }
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
    case "reroute": {
      const body = RerouteBody.parse(raw);
      const routes = Object.entries(body.routes ?? {});
      return args({
        ...identity(body),
        ...(body.model ? { model: body.model } : {}),
        ...(routes.length
          ? { route: routes.map(([stage, model]) => `${stage}=${model}`).join(",") }
          : {}),
      });
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
    owner: body.owner ?? "API",
  };
  if (body.feature) flags.feature = body.feature;
  if (body.prompt) flags.prompt = body.prompt;
  if (body.issue) flags.issue = body.issue;
  if (body.workflow) flags.workflow = body.workflow;
  if (body.model) flags.model = body.model;
  if (body.confirmAutoApproval) flags["confirm-auto-approval"] = body.confirmAutoApproval;
  if (body.worktree) flags.worktree = true;
  if (body.writers !== undefined) flags.writers = String(body.writers);
  if (body.clarification) flags.clarification = body.clarification;
  if (body.modelStrict) flags["model-strict"] = true;
  if (body.policy !== undefined) flags.policy = true;
  if (body.budget) flags.budget = body.budget;
  return validateWorkflowArgs({
    command: "run",
    positional: [],
    flags,
    ...(body.policy !== undefined ? { inline: { policy: body.policy } } : {}),
  });
}

/** A client that asks for JSON and not for an event stream gets the JSON variant of a stream. */
function wantsJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return /application\/json/i.test(accept) && !/text\/event-stream/i.test(accept);
}

export type { AttentionItem } from "../workflows/attention.js";

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
  const projects = new ProjectService(
    service.workspace,
    options.configDir ? { configDir: options.configDir } : {},
  );
  const requireProject = (): void => {
    if (!projects.current())
      throw new ApiError(
        404,
        "NOT_FOUND",
        "No project here; run baked project init in the workspace",
      );
  };
  const chat =
    options.chat ??
    new ChatService({
      workspace: service.workspace,
      config: service.config,
      // BAKED_TEST_SCRIPT (tests only) plays a scripted model instead of calling one.
      host:
        scriptedHostFromEnv() ??
        new BakeChatHost(service.workspace, service.config, service.rootContext),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    });
  const initiatives = new InitiativeService(service);
  const graphCache = new CodeGraphCache(service.workspace);
  let graphRoot: ContextManager | null = null;
  let graphRootStarted = false;
  /** Starts the shared repository map on first use; true until its scan is ready. */
  const graphIndexing = (): boolean => {
    if (!graphRootStarted) {
      graphRootStarted = true;
      service.rootContext.get().then(
        (root) => {
          graphRoot = root;
        },
        () => {
          graphRootStarted = false;
        },
      );
    }
    return !graphRoot?.isRepoMapReady();
  };
  /** The latest on-demand result of each check. */
  const checkResults = new Map<string, CheckRunRecord>();
  const gitQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };

  /** Runs that have not ended and froze `absolutePath` as an input. */
  function runsFreezing(absolutePath: string): string[] {
    return runsFreezingFile(service.store, absolutePath);
  }
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

  async function readJson(req: Request, raisedLimit?: number): Promise<unknown> {
    const limit = Math.max(raisedLimit ?? 0, maxBodyBytes);
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > limit)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${limit} bytes`);
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
      if (total > limit) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${limit} bytes`);
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
    const progressId = `run-start-${crypto.randomUUID()}`;
    progress.set(
      "run-start",
      args.command === "resume" ? "Resuming the run" : "Starting the run",
      null,
      progressId,
    );
    const execution = executeWorkflowCommand(service, args, shutdown.signal, (runId) => {
      progress.end(progressId);
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
        progress.end(progressId);
        drives.delete(tracked);
        if (driven !== undefined && runDrives.get(driven) === tracked) runDrives.delete(driven);
      });
    drives.add(tracked);
    const runId = await Promise.race([driving, execution.then(() => undefined)]);
    if (!runId) throw new ApiError(500, "INTERNAL", "The run did not start");
    return service.get(runId);
  }

  /**
   * Waits for a drive that has already stopped to return before a decision or resume. The core
   * commits a run's waiting status together with the state its requests refer to, so this no
   * longer covers a gap there; it is kept because it is harmless and lets the stopped drive of
   * this process release its leases first. A drive that is still running is left alone: pause and
   * cancel stop it themselves.
   */
  async function settle(runId: string): Promise<void> {
    const drive = runDrives.get(runId);
    if (drive && service.store.run(runId).status !== "running") await drive;
  }

  /**
   * Drives an initiative in the background after `start`, `approve` or `resume`, like the CLI
   * does in the foreground; its outcome is in its events and view.
   */
  /** The latest drive of each initiative, and whether another one is queued behind it. */
  const initiativeDrives = new Map<string, { latest: Promise<unknown>; queued: boolean }>();

  /**
   * Drives an initiative in the background. Drives of one initiative run one after another, and a
   * launch while one waits to start adds nothing: the queued drive reads the newest state.
   */
  function driveInitiative(id: string): void {
    const current = initiativeDrives.get(id);
    if (current?.queued) return;
    const entry = { latest: Promise.resolve() as Promise<unknown>, queued: Boolean(current) };
    const tracked: Promise<unknown> = (current?.latest ?? Promise.resolve())
      .then(() => {
        entry.queued = false;
        if (shutdown.signal.aborted) return undefined;
        return initiatives.drive(id, shutdown.signal);
      })
      .catch((error: unknown) => {
        const { code, message } = errorOf(error);
        log(
          JSON.stringify({
            event: "initiative-drive-error",
            code,
            message: redactSecrets(message),
          }),
        );
      })
      .finally(() => {
        drives.delete(tracked);
        if (initiativeDrives.get(id) === entry) initiativeDrives.delete(id);
      });
    entry.latest = tracked;
    initiativeDrives.set(id, entry);
    drives.add(tracked);
  }

  /**
   * A Server-Sent Events response with heartbeats that lives until the client leaves or the
   * server stops. A `tick` stream calls `tick` every poll interval; an error from it is sent as
   * an `error` event and ends the stream. An `attach` stream is pushed to by its source and
   * returns the function that detaches it.
   */
  function sseStream(
    req: Request,
    origin: string | null,
    source:
      | { tick: (send: (text: string) => void) => void }
      | { attach: (send: (text: string) => void, close: () => void) => () => void },
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let detach = (): void => {};
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
          detach();
          streams.delete(close);
          req.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            // The client already went away.
          }
        };
        streams.add(close);
        req.signal.addEventListener("abort", close, { once: true });
        heartbeat = setInterval(() => send(": keep-alive\n\n"), heartbeatMs);
        send("retry: 1000\n\n");
        if ("attach" in source) {
          detach = source.attach(send, close);
          return;
        }
        const poll = (): void => {
          if (closed) return;
          try {
            source.tick(send);
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

  function eventStream(req: Request, runId: string, after: number, origin: string | null) {
    let seq = after;
    return sseStream(req, origin, {
      tick: (send) => {
        for (;;) {
          const page = service.store.events(runId, seq, EVENT_PAGE);
          for (const event of page) {
            send(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            seq = event.seq;
          }
          if (page.length < EVENT_PAGE) break;
        }
      },
    });
  }

  /** Everything waiting for a person, as `GET /v1/attention` returns it. */
  function attention(): AttentionItem[] {
    return attentionItems(
      service.store,
      initiatives.store,
      chat.attention().map(({ session, prompt }) => ({
        sessionId: session.id,
        title: session.title,
        promptId: prompt.id,
        kind: prompt.kind,
        createdAt: prompt.createdAt,
      })),
    );
  }

  /** Streams the whole attention list once at the start and again whenever it changes. */
  function attentionStream(req: Request, origin: string | null) {
    let last: string | null = null;
    return sseStream(req, origin, {
      tick: (send) => {
        const items = attention();
        const key = JSON.stringify(items);
        if (key === last) return;
        last = key;
        send(`event: attention\ndata: ${JSON.stringify({ items })}\n\n`);
      },
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
        {
          apiVersion: API_VERSION,
          version: CURRENT_VERSION,
          workspace: service.workspace,
          capabilities: CAPABILITIES,
        },
        origin,
      );
    }
    if (path === "/v1/attention") {
      only("GET");
      if (wantsJson(req)) return json(200, { items: attention() }, origin);
      // Streams outlive the server's idle timeout; heartbeats keep intermediaries open.
      server.timeout(req, 0);
      return attentionStream(req, origin);
    }
    const ctx: RouteContext = {
      req,
      url,
      path,
      method,
      json: (status, body) => json(status, body, origin),
      readJson: (maxBytes) => readJson(req, maxBytes),
      query: (schema) => queryOf(url, schema),
      fail: (status, code, message) => {
        throw new ApiError(status, code, message);
      },
      only: (...methods) => {
        if (!methods.includes(method))
          throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${methods.join(" or ")} for ${path}`);
      },
      stream: (attach) => sseStream(req, origin, { attach }),
      poll: (tick) => sseStream(req, origin, { tick }),
      wantsJson: () => wantsJson(req),
      keepOpen: () => server.timeout(req, 0),
    };
    const routed =
      progressRoute({ ...ctx, tracker: progress }) ??
      (await chatRoute({ ...ctx, chat })) ??
      (await initiativeRoute({ ...ctx, initiatives, launch: driveInitiative })) ??
      (await memoryRoute({ ...ctx, config: service.config, store: service.store })) ??
      (await mcpRoute({
        ...ctx,
        workspace: service.workspace,
        config: service.config,
        ...(options.configDir ? { configDir: options.configDir } : {}),
      })) ??
      (await lspRoute({
        ...ctx,
        workspace: service.workspace,
        start: () => service.rootContext.get(),
        ...(options.lspDeps ? { deps: options.lspDeps } : {}),
        ...(options.lspDiagnose ? { diagnose: options.lspDiagnose } : {}),
        ...(options.configDir ? { configDir: options.configDir } : {}),
      })) ??
      (await chatMemoryRoute({ ...ctx, workspace: service.workspace, memory: chatMemory })) ??
      (await hooksRoute({ ...ctx, workspace: service.workspace })) ??
      (await graphRoute({
        ...ctx,
        workspace: service.workspace,
        cache: graphCache,
        enabled: service.config.repoMap !== false && process.env.BAKED_NO_REPOMAP !== "1",
        indexing: graphIndexing,
      })) ??
      (await checkRoute({
        ...ctx,
        workspace: service.workspace,
        config: service.config,
        store: service.store,
        results: checkResults,
        signal: shutdown.signal,
      })) ??
      (await gitRoute({
        ...ctx,
        workspace: service.workspace,
        config: service.config,
        store: service.store,
        queue: gitQueue,
      })) ??
      (await setupRoute({
        ...ctx,
        workspace: service.workspace,
        config: service.config,
        runsFreezing,
        ...(options.configDir ? { configDir: options.configDir } : {}),
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.skillCatalog ? { skillCatalog: options.skillCatalog } : {}),
      })) ??
      (await settingsRoute({
        ...ctx,
        workspace: service.workspace,
        config: service.config,
        ...(options.configDir ? { configDir: options.configDir } : {}),
        ...(options.settingsSecrets ? { secrets: options.settingsSecrets } : {}),
      })) ??
      (await diagnosticsRoute({
        ...ctx,
        dirs: storageDirs(service.workspace, options.configDir ?? defaultConfigDir()),
        clearSessions: () => chat.clearAll(),
        clearRepoMap: async () => {
          if (drives.size > 0)
            throw new ApiError(
              409,
              "WORKSPACE_BUSY",
              "Wait for the runs this server drives to stop before clearing the code map",
            );
          chat.assertIdleWorkspace("clearing the code map");
          await (await service.rootContext.get()).clearRepoMap();
        },
      }));
    if (routed) return routed;
    if (path === "/v1/projects") {
      only("GET");
      const here = realPath(service.workspace);
      const known = listKnownProjects(options.configDir ? { configDir: options.configDir } : {});
      return json(
        200,
        {
          projects: known.map((project) => ({
            ...project,
            current: project.path === here,
            overview: projectOverview(project.path),
          })),
        },
        origin,
      );
    }
    if (path === "/v1/projects/current") {
      only("GET");
      requireProject();
      return json(200, projects.summary(), origin);
    }
    if (path === "/v1/projects/current/working-set") {
      only("POST");
      const body = WorkingSetBody.parse(await readJson(req));
      requireProject();
      try {
        if (body.remove?.length) projects.removeFromWorkingSet(body.remove);
        if (body.add?.length) projects.addToWorkingSet(body.add);
      } catch (error) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          error instanceof Error ? error.message : String(error),
        );
      }
      return json(200, projects.summary(), origin);
    }
    if (path === "/v1/workflow/definitions" || path === "/v1/workflow/profiles") {
      only("GET");
      const command = path.endsWith("definitions") ? "definitions" : "profiles";
      return json(200, await execute({ command, positional: [], flags: {} }), origin);
    }
    if (path === "/v1/workflow/doctor" || path === "/v1/workflow/estimate") {
      only("GET");
      const query = queryOf(url, PreRunQuery);
      const flags: WorkflowArgs["flags"] = {};
      if (query.workflow) flags.workflow = query.workflow;
      if (query.model) flags.model = query.model;
      if (query.route) flags.route = query.route;
      if (query.modelStrict === "true") flags["model-strict"] = true;
      if (query.worktree === "true") flags.worktree = true;
      if (query.writers) flags.writers = query.writers;
      if (query.confirmAutoApproval) flags["confirm-auto-approval"] = query.confirmAutoApproval;
      const command = path.endsWith("doctor") ? "doctor" : "estimate";
      return json(
        200,
        await execute(validateWorkflowArgs({ command, positional: [], flags })),
        origin,
      );
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
    if (path === "/v1/workflow/gates") {
      only("GET");
      return json(200, await execute({ command: "gates", positional: [], flags: {} }), origin);
    }
    if (path === "/v1/workflow/gates/confirm") {
      only("POST");
      const body = GatesConfirmBody.parse(await readJson(req));
      return json(
        200,
        await execute(
          validateWorkflowArgs({
            command: "gates",
            positional: ["confirm", ...(body.ids ?? [])],
            flags: body.all ? { all: true } : {},
          }),
        ),
        origin,
      );
    }
    if (path === "/v1/workflow/route") {
      only("GET");
      const query = queryOf(url, RouteQuery);
      const flags: WorkflowArgs["flags"] = {};
      if (query.workflow) flags.workflow = query.workflow;
      if (query.model) flags.model = query.model;
      if (query.route) flags.route = query.route;
      return json(
        200,
        await execute(validateWorkflowArgs({ command: "route", positional: [], flags })),
        origin,
      );
    }
    if (path === "/v1/usage") {
      only("GET");
      const query = queryOf(url, UsageQuery);
      return json(
        200,
        usageSummary(service.store, {
          days: Math.min(Math.max(Number(query.days ?? 7), 1), 366),
          groupBy: query.groupBy ?? ["model"],
          ...(query.model !== undefined ? { model: query.model } : {}),
          ...(query.stage !== undefined ? { stage: query.stage } : {}),
        }),
        origin,
      );
    }
    const match = /^\/v1\/workflow\/runs\/([^/]+)(?:\/([a-z-]+(?:\/execute)?))?$/.exec(path);
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
    if (action === "deliver" || action === "deliver/execute") {
      only("POST");
      const flags: WorkflowArgs["flags"] = {};
      if (action === "deliver") {
        const body = DeliverBody.parse(await readJson(req));
        if (body.remote) flags.remote = body.remote;
        if (body.branch) flags.branch = body.branch;
        if (body.draft) flags.draft = true;
        if (body.pullRequest === false) flags["no-pr"] = true;
      } else {
        const body = DeliverExecuteBody.parse(await readJson(req));
        flags.execute = true;
        flags["expected-revision"] = String(body.expectedRevision);
        if (body.requestId) flags.request = body.requestId;
        await settle(runId);
      }
      return json(
        200,
        await execute(validateWorkflowArgs({ command: "deliver", positional: [runId], flags })),
        origin,
      );
    }
    if (action === "candidate") {
      only("POST");
      const body = CandidateBody.parse(await readJson(req));
      const flags: WorkflowArgs["flags"] = { "command-id": body.commandId };
      const inline: NonNullable<WorkflowArgs["inline"]> = {};
      for (const key of ["spec", "plan", "tasks", "policy"] as const) {
        if (body[key] === undefined) continue;
        flags[key] = true;
        inline[key] = body[key];
      }
      return json(
        200,
        await execute(
          validateWorkflowArgs({ command: "candidate", positional: [runId], flags, inline }),
        ),
        origin,
      );
    }
    if (action === "progress") {
      only("GET");
      return json(
        200,
        await execute({ command: "export-progress", positional: [runId], flags: {} }),
        origin,
      );
    }
    if (action === "usage" || action === "artifacts" || action === "report") {
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
      if (wantsJson(req)) {
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
              "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE",
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
  let ownMemory: MemoryManager | null = null;
  /**
   * The memory store chat sessions use: the shared root's once chat started it, so scope changes
   * reach running sessions; until then one of the API's own, which reads and writes the same files.
   */
  const chatMemory = async (): Promise<MemoryManager> => {
    if (service.rootContext.started && !options.configDir) {
      const root = await service.rootContext.get().catch(() => null);
      if (root) return root.getMemoryManager();
    }
    ownMemory ??= new MemoryManager(service.workspace, options.configDir);
    return ownMemory;
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      shutdown.abort(new Error("API server shutdown"));
      for (const close of [...streams]) close();
      try {
        // stop(true) closes every connection at once. On Bun 1.3.13 its promise can stay pending
        // after a client cancelled an event stream, so the wait for it is bounded.
        await Promise.race([server.stop(true), Bun.sleep(STOP_WAIT_MS)]);
        await Promise.allSettled([...drives]);
        await chat.shutdown();
        ownMemory?.close();
        await service.shutdown();
        if (options.ownsService) {
          // Waits for the shared code-intelligence worker to stop its language servers.
          await service.rootContext.dispose();
          service.close();
        }
      } finally {
        removeTokenFile(tokenFile);
      }
    })();
    return stopping;
  };
  return { url: `http://127.0.0.1:${port}`, port, tokenFile, token, stop };
}
