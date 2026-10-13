/**
 * Artifacts over the local API (`artifacts` capability): the HTML pages shared by every project,
 * their pages for preview, opening one in the browser, saving and deploying to the user's Vercel.
 * A deploy needs `confirm: true` in the body, which the desktop sends only after the person
 * approved the plan from `GET .../deploy`. Core logic is in src/core/artifacts/.
 */
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { deployArtifact, planDeploy } from "../artifacts/deploy.js";
import { ArtifactError, type ArtifactStore } from "../artifacts/store.js";
import { VercelError, type VercelOptions } from "../artifacts/vercel.js";
import { openPath } from "../utils/open-path.js";
import type { RouteContext } from "./route-context.js";

export interface ArtifactRouteContext extends RouteContext {
  store: ArtifactStore;
  workspace: string;
  config: () => Pick<AppConfig, "artifactDeploy" | "vercelTeamId">;
  /** Replaces the Vercel endpoint and token in tests. */
  vercel?: Partial<VercelOptions>;
  /** Opens a file in the default browser; tests pass a fake. */
  open?: (path: string) => boolean;
}

const SaveBody = z.strictObject({
  html: z.string().min(1),
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const Target = z.enum(["preview", "production"]);
const DeployQuery = z.object({ target: Target.optional() });
const DeployBody = z.strictObject({ target: Target.default("preview"), confirm: z.literal(true) });
const PageQuery = z.object({ version: z.coerce.number().int().positive().optional() });

/** Answers an artifacts request, or returns null when the path is not one. */
export async function artifactRoute(ctx: ArtifactRouteContext): Promise<Response | null> {
  if (!ctx.path.startsWith("/v1/artifacts")) return null;
  try {
    if (ctx.path === "/v1/artifacts") {
      ctx.only("GET", "POST");
      if (ctx.method === "GET") return ctx.json(200, { items: ctx.store.list() });
      // A page may be up to 5 MiB; the body limit grows with it.
      const body = SaveBody.parse(await ctx.readJson(6 * 1024 * 1024));
      return ctx.json(201, ctx.store.save({ ...body, project: ctx.workspace }));
    }
    const match = /^\/v1\/artifacts\/([^/]+)(?:\/(page|open|deploy))?$/.exec(ctx.path);
    if (!match) return null;
    const id = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    if (!action) {
      ctx.only("GET", "DELETE");
      if (ctx.method === "DELETE") {
        ctx.store.remove(id);
        return ctx.json(200, { removed: id });
      }
      return ctx.json(200, ctx.store.get(id));
    }
    if (action === "page") {
      ctx.only("GET");
      const { version } = ctx.query(PageQuery);
      const meta = ctx.store.get(id);
      const wanted = version ?? meta.version;
      return ctx.json(200, { id, version: wanted, html: ctx.store.read(id, wanted) });
    }
    if (action === "open") {
      ctx.only("POST");
      // The server runs on the person's machine; its browser opens the page with scripts on.
      const file = ctx.store.pagePath(id);
      return ctx.json(200, { opened: (ctx.open ?? openPath)(file), path: file });
    }
    ctx.only("GET", "POST");
    if (ctx.method === "GET") {
      const { target } = ctx.query(DeployQuery);
      return ctx.json(
        200,
        planDeploy(ctx.store, ctx.config(), id, target ?? "preview", ctx.vercel?.token),
      );
    }
    const body = DeployBody.parse(await ctx.readJson());
    const config = ctx.config();
    const plan = planDeploy(ctx.store, config, id, body.target, ctx.vercel?.token);
    if (plan.refusal) ctx.fail(400, "DEPLOY_REFUSED", plan.refusal);
    const result = await deployArtifact(ctx.store, config, id, body.target, ctx.vercel ?? {});
    return ctx.json(200, result);
  } catch (error) {
    if (error instanceof ArtifactError)
      ctx.fail(error.code === "NOT_FOUND" ? 404 : 400, error.code, error.message);
    if (error instanceof VercelError) ctx.fail(502, "VERCEL", error.message);
    throw error;
  }
}
