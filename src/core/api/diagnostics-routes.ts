/**
 * Diagnostics of the local API (`/v1/diagnostics/*`): disk use and cleanup of BAKED's data, the
 * background error log and the model events of this server process. The terminal UI's
 * `/storage`, `/errors` and `/model-events` read the same core modules in src/core/diagnostics/.
 */
import { z } from "zod";
import { backgroundErrors } from "../diagnostics/errors.js";
import { modelEventsStore, modelEventsView } from "../diagnostics/model-events.js";
import {
  clearHistory,
  clearPlans,
  computeStorageSizes,
  type StorageDirs,
  type StorageSizes,
  vacuumDatabases,
} from "../diagnostics/storage.js";
import type { RouteContext } from "./route-context.js";

export interface DiagnosticsRouteContext extends RouteContext {
  dirs: StorageDirs;
  /** Deletes the project's saved chat sessions; throws while a chat turn runs. */
  clearSessions: () => number;
  /** Clears the repository map through the running context manager; throws while busy. */
  clearRepoMap: () => Promise<void>;
}

export const CLEANUP_TARGETS = ["repo-map", "sessions", "plans", "history", "vacuum"] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

const CleanupBody = z
  .strictObject({
    target: z.enum(CLEANUP_TARGETS),
    /** Required for every target that deletes data; only `vacuum` keeps everything. */
    confirm: z.literal(true).optional(),
  })
  .refine((body) => body.target === "vacuum" || body.confirm === true, {
    message: "Deleting data needs confirm: true",
    path: ["confirm"],
  });

const ModelEventsBody = z.strictObject({ action: z.enum(["enable", "disable", "clear"]) });

/** The `GET /v1/diagnostics/storage` answer. */
export function storageView(sizes: StorageSizes) {
  return {
    projectDir: sizes.projectDir,
    globalDir: sizes.globalDir,
    project: {
      totalBytes: sizes.projectTotal,
      repoMapBytes: sizes.repoMap,
      sessionsBytes: sizes.sessions,
      sessionCount: sizes.sessionCount,
      memoryBytes: sizes.projectMemory,
      plansBytes: sizes.plans,
      configBytes: sizes.projectConfig,
    },
    global: {
      totalBytes: sizes.globalTotal,
      historyBytes: sizes.history,
      memoryBytes: sizes.globalMemory,
      configBytes: sizes.globalConfig,
      binariesBytes: sizes.bins,
    },
  };
}

/** Answers a diagnostics request, or returns null when the path is not one. */
export async function diagnosticsRoute(ctx: DiagnosticsRouteContext): Promise<Response | null> {
  if (!ctx.path.startsWith("/v1/diagnostics/")) return null;
  switch (ctx.path) {
    case "/v1/diagnostics/storage":
      ctx.only("GET");
      return ctx.json(200, storageView(computeStorageSizes(ctx.dirs)));
    case "/v1/diagnostics/storage/cleanup": {
      ctx.only("POST");
      const { target } = CleanupBody.parse(await ctx.readJson());
      const before = computeStorageSizes(ctx.dirs);
      let freedBytes = 0;
      let removed: number | undefined;
      switch (target) {
        case "repo-map":
          if (before.repoMap > 0) {
            await ctx.clearRepoMap();
            freedBytes = before.repoMap;
          }
          break;
        case "sessions":
          removed = before.sessionCount > 0 ? ctx.clearSessions() : 0;
          freedBytes = removed > 0 ? before.sessions : 0;
          break;
        case "plans":
          freedBytes = clearPlans(ctx.dirs);
          break;
        case "history":
          try {
            freedBytes = before.history > 0 ? clearHistory(ctx.dirs) : 0;
          } catch (error) {
            ctx.fail(
              409,
              "WORKSPACE_BUSY",
              `Could not clear the history database: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        case "vacuum":
          freedBytes = vacuumDatabases(ctx.dirs);
          break;
      }
      return ctx.json(200, {
        target,
        freedBytes,
        ...(removed !== undefined ? { removed } : {}),
        storage: storageView(computeStorageSizes(ctx.dirs)),
      });
    }
    case "/v1/diagnostics/errors":
      ctx.only("GET");
      return ctx.json(200, { errors: backgroundErrors() });
    case "/v1/diagnostics/model-events": {
      ctx.only("GET", "POST");
      if (ctx.method === "POST") {
        const { action } = ModelEventsBody.parse(await ctx.readJson());
        const store = modelEventsStore.getState();
        if (action === "clear") store.clear();
        else store.setEnabled(action === "enable");
      }
      return ctx.json(200, modelEventsView());
    }
    default:
      return ctx.fail(404, "NOT_FOUND", `No endpoint ${ctx.path}`);
  }
}
