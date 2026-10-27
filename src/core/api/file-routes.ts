/**
 * Project documents over the local API (`file-preview` capability): a Markdown or HTML file of the
 * project for the desktop chat's preview panel, and opening one with the system's default app.
 * Core logic is in src/core/files/preview.ts.
 */
import { z } from "zod";
import { PreviewError, previewFile, readPreview } from "../files/preview.js";
import { openPath } from "../utils/open-path.js";
import type { RouteContext } from "./route-context.js";

export interface FileRouteContext extends RouteContext {
  workspace: string;
  /** Opens a file with the default app; tests pass a fake. */
  open?: (path: string) => boolean;
}

const PathQuery = z.object({ path: z.string().min(1) });
const OpenBody = z.strictObject({ path: z.string().min(1) });

/** Answers a files request, or returns null when the path is not one. */
export async function fileRoute(ctx: FileRouteContext): Promise<Response | null> {
  if (ctx.path !== "/v1/files/preview" && ctx.path !== "/v1/files/open") return null;
  try {
    if (ctx.path === "/v1/files/preview") {
      ctx.only("GET");
      const { path } = ctx.query(PathQuery);
      return ctx.json(200, readPreview(ctx.workspace, path));
    }
    ctx.only("POST");
    const { path } = OpenBody.parse(await ctx.readJson());
    // Read first, so a missing or oversized file answers like the preview does.
    readPreview(ctx.workspace, path);
    const file = previewFile(ctx.workspace, path);
    return ctx.json(200, { opened: (ctx.open ?? openPath)(file), path: file });
  } catch (error) {
    if (error instanceof PreviewError)
      ctx.fail(
        error.code === "NOT_FOUND" ? 404 : error.code === "TOO_LARGE" ? 413 : 400,
        error.code,
        error.message,
      );
    throw error;
  }
}
