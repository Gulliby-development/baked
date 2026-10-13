/**
 * BAKED packages over the local API (`packages` capability, #135): list the installed packages,
 * plan an install from a local package folder, install a plan the person approved (its
 * `planHash`), and remove a package. Core logic is in src/core/packages/; `baked add` and
 * `baked packages` are the same in a shell.
 */
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import { PackageError } from "../packages/manifest.js";
import {
  type InspectOptions,
  type InstallResult,
  inspectPackage,
  installPackage,
  listPackages,
  removePackage,
} from "../packages/packages.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { PolicySchema } from "../workflows/schemas.js";
import { gateDirectories } from "../workflows/v2/library.js";
import type { RouteContext } from "./route-context.js";
import { PackageInspectBody, PackageInstallBody } from "./schemas.js";

export interface PackageRouteContext extends RouteContext {
  workspace: string;
  config: AppConfig;
  /** The user configuration directory; its `gates` folder holds the user's gates. */
  configDir?: string;
}

/** Results of installs by command ID, so a retried request answers the first result. */
const completed = new Map<string, InstallResult>();
const MAX_REMEMBERED = 100;

const STATUS: Partial<Record<PackageError["code"], number>> = {
  NOT_FOUND: 404,
  NOT_INSTALLED: 404,
  STALE_PLAN: 409,
  CONFLICT: 409,
};

/** Answers a packages request, or returns null when the path is not one. */
export async function packageRoute(ctx: PackageRouteContext): Promise<Response | null> {
  if (ctx.path !== "/v1/packages" && !ctx.path.startsWith("/v1/packages/")) return null;
  const options = (): InspectOptions => ({
    policy: PolicySchema.parse(ctx.config.workflows?.policy ?? defaultWorkflowPolicy),
    ...(ctx.configDir
      ? {
          gateDirectories: {
            user: join(ctx.configDir, "gates"),
            project: gateDirectories(ctx.workspace).project,
          },
        }
      : {}),
  });
  try {
    if (ctx.path === "/v1/packages") {
      ctx.only("GET");
      return ctx.json(200, { packages: listPackages(ctx.workspace) });
    }
    if (ctx.path === "/v1/packages/inspect") {
      ctx.only("POST");
      const body = PackageInspectBody.parse(await ctx.readJson());
      return ctx.json(200, inspectPackage(body.path, ctx.workspace, options()));
    }
    if (ctx.path === "/v1/packages/install") {
      ctx.only("POST");
      const body = PackageInstallBody.parse(await ctx.readJson());
      const key = body.commandId ? `${ctx.workspace}\0${body.commandId}` : null;
      const earlier = key ? completed.get(key) : undefined;
      if (earlier) return ctx.json(200, earlier);
      const plan = inspectPackage(body.path, ctx.workspace, options());
      if (plan.planHash !== body.planHash)
        ctx.fail(
          409,
          "STALE_PLAN",
          "The package or the project changed since the plan was shown; inspect it again",
        );
      const result = installPackage(plan, {
        approved: true,
        overwrite: body.overwrite === true,
        ...options(),
      });
      if (key) {
        completed.set(key, result);
        if (completed.size > MAX_REMEMBERED) completed.delete(completed.keys().next().value ?? "");
      }
      return ctx.json(201, result);
    }
    const match = /^\/v1\/packages\/([A-Za-z0-9._-]+)$/.exec(ctx.path);
    if (!match) return null;
    ctx.only("DELETE");
    return ctx.json(200, removePackage(ctx.workspace, decodeURIComponent(match[1] ?? "")));
  } catch (error) {
    if (error instanceof PackageError)
      ctx.fail(STATUS[error.code] ?? 400, error.code, error.message);
    throw error;
  }
}
