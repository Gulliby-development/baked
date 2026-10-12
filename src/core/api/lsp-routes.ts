/**
 * Language servers over the local API (`/v1/lsp`): the status `/lsp status` shows in the terminal
 * UI and the changes `/lsp` makes there (install, enable, disable, restart). Everything goes
 * through src/core/intelligence/lsp-service.ts, which `baked lsp` uses too.
 */
import { join } from "node:path";
import { z } from "zod";
import { isIntelligenceReady } from "../intelligence/instance.js";
import {
  installLspServer,
  type LspServiceDeps,
  LspServiceError,
  type LspServiceOptions,
  lspStatus,
  restartLspServer,
  setLspServerDisabled,
} from "../intelligence/lsp-service.js";
import type { RouteContext } from "./route-context.js";

export interface LspRouteContext extends RouteContext {
  workspace: string;
  /** The user configuration directory; tests point it elsewhere. */
  configDir?: string;
  /** Starts the shared code-intelligence worker, which starts the project's language servers. */
  start?: () => Promise<unknown>;
  /** Tests replace what touches the machine. */
  deps?: Partial<LspServiceDeps>;
}

const Scope = z.enum(["global", "project"]);
const ToggleBody = z.strictObject({ scope: Scope.optional() });
const ITEM = /^\/v1\/lsp\/([^/]+)\/(install|enable|disable|restart)$/;
const ERROR_STATUS = { NOT_FOUND: 404, NOT_INSTALLABLE: 409, INSTALL_FAILED: 502 } as const;

/** Installs in progress, by server id, so a second click does not start a second install. */
const installing = new Set<string>();

/** Answers a language-server request, or returns null when the path is not one. */
export async function lspRoute(ctx: LspRouteContext): Promise<Response | null> {
  const { path } = ctx;
  if (path !== "/v1/lsp" && !path.startsWith("/v1/lsp/")) return null;
  const options: LspServiceOptions = {
    workspace: ctx.workspace,
    ...(ctx.configDir ? { files: { global: join(ctx.configDir, "config.json") } } : {}),
    ...(ctx.deps ? { deps: ctx.deps } : {}),
  };
  const started = (): boolean => (ctx.deps?.started ?? isIntelligenceReady)();
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LspServiceError)
        ctx.fail(ERROR_STATUS[error.code], error.code, error.message);
      throw error;
    }
  };
  /** Restarting before anything started the servers starts them instead. */
  const restart = async (id?: string) => {
    if (!started() && ctx.start) {
      // Validates `id` before anything starts.
      await guard(() => restartLspServer(options, id));
      await ctx.start();
      return { ...(await lspStatus(options)), restarted: [] as string[], startedNow: true };
    }
    const result = await guard(() => restartLspServer(options, id));
    return { ...result.status, restarted: result.restarted, startedNow: false };
  };

  if (path === "/v1/lsp") {
    ctx.only("GET");
    return ctx.json(200, await lspStatus(options));
  }
  if (path === "/v1/lsp/restart") {
    ctx.only("POST");
    return ctx.json(200, await restart());
  }
  const match = ITEM.exec(path);
  if (!match) return ctx.fail(404, "NOT_FOUND", `No endpoint at ${path}`);
  ctx.only("POST");
  const id = decodeURIComponent(match[1] ?? "");
  switch (match[2]) {
    case "restart":
      return ctx.json(200, await restart(id));
    case "enable":
    case "disable": {
      const empty = !ctx.req.body || ctx.req.headers.get("content-length") === "0";
      const body = ToggleBody.parse(empty ? {} : await ctx.readJson());
      const result = await guard(() =>
        setLspServerDisabled(options, id, match[2] === "disable", body.scope),
      );
      return ctx.json(200, { ...result.status, restarted: result.restarted });
    }
    default: {
      if (installing.has(id)) return ctx.fail(409, "BUSY", `${id} is already being installed`);
      installing.add(id);
      // An install downloads and builds; it may run for minutes.
      ctx.keepOpen();
      const log: string[] = [];
      try {
        const result = await guard(() => installLspServer(options, id, (line) => log.push(line)));
        return ctx.json(200, {
          ...result.status,
          restarted: result.restarted,
          installed: { server: result.server, package: result.package },
          log,
        });
      } finally {
        installing.delete(id);
      }
    }
  }
}
