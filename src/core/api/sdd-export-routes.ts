/**
 * The SDD export package over HTTP (#2207): `POST .../package` writes it into the project, `GET
 * .../package` answers it as one zip archive for a download. Both only call the core exporter.
 */
import { z } from "zod";
import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "../workflows/errors.js";
import {
  buildSddPackage,
  defaultExportPath,
  NOT_ACCEPTED,
  writeSddPackage,
} from "../workflows/sdd-export/package.js";
import { zipFiles } from "../workflows/sdd-export/zip.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RouteContext } from "./route-context.js";

export interface SddExportRouteContext extends RouteContext {
  store: WorkflowStore;
}

const PackageBody = z.strictObject({
  zip: z.boolean().optional(),
  /** A new path inside the project, relative to it; default `.baked/exports/ID-export`. */
  out: z.string().min(1).max(500).optional(),
});
const PATH = /^\/v1\/(?:workflow\/runs|initiatives)\/([^/]+)\/package$/;

/** Answers a package request, or returns null when the path is not a package endpoint. */
export async function sddExportRoute(ctx: SddExportRouteContext): Promise<Response | null> {
  const match = PATH.exec(ctx.path);
  if (!match?.[1]) return null;
  ctx.only("GET", "POST");
  const kind = ctx.path.startsWith("/v1/initiatives/") ? "initiative" : "run";
  const id = decodeURIComponent(match[1]);
  try {
    const pkg = buildSddPackage(ctx.store, id, kind);
    if (ctx.method === "GET")
      return new Response(zipFiles(pkg.files), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${id}-export.zip"`,
        },
      });
    const body = PackageBody.parse(await ctx.readJson());
    const zip = body.zip === true;
    // The local API writes only inside the project; a path elsewhere is the CLI's to write.
    const out = body.out
      ? workspacePath(ctx.store.workspace, body.out.replaceAll("\\", "/"))
      : defaultExportPath(ctx.store.workspace, id, zip);
    return ctx.json(200, writeSddPackage(pkg, out, zip));
  } catch (error) {
    if (error instanceof WorkflowFault && error.details.reason === NOT_ACCEPTED)
      ctx.fail(409, "NOT_ACCEPTED", error.message);
    throw error;
  }
}
