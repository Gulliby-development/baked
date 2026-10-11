/**
 * The code graph over the local API (`/v1/graph*`), drawn by the desktop Graph section. The
 * grouping is in src/core/intelligence/code-graph-model.ts and the index reader in
 * src/core/intelligence/code-graph.ts; the terminal `/graph` view uses the same.
 */
import { z } from "zod";
import {
  graphFileDetail,
  graphView,
  searchGraphFiles,
} from "../intelligence/code-graph-model.js";
import {
  type CodeGraphCache,
  explainGraphLink,
  graphFilePackages,
} from "../intelligence/code-graph.js";
import type { RouteContext } from "./route-context.js";

export interface GraphRouteContext extends RouteContext {
  workspace: string;
  cache: CodeGraphCache;
  /** False when the repository map is turned off in the configuration. */
  enabled: boolean;
  /** Starts indexing on first use; true while the index is still being built or refreshed. */
  indexing(): boolean;
}

const Path = z.string().min(1).max(4096);
const ViewBody = z.strictObject({
  expanded: z.array(z.string().min(1).max(4200)).max(2000).optional(),
  tests: z.boolean().optional(),
  typeEdges: z.boolean().optional(),
  reveal: Path.optional(),
});
const FileQuery = z.strictObject({ path: Path });
const LinkQuery = z.strictObject({ from: Path, to: Path });
const SearchQuery = z.strictObject({ q: z.string().max(200), limit: z.coerce.number().int().min(1).max(50).optional() });

/** Answers a code graph request, or returns null when the path is not one. */
export async function graphRoute(ctx: GraphRouteContext): Promise<Response | null> {
  if (ctx.path !== "/v1/graph" && !ctx.path.startsWith("/v1/graph/")) return null;
  if (ctx.path === "/v1/graph") {
    ctx.only("POST");
    const body = ViewBody.parse(await ctx.readJson());
    if (!ctx.enabled) return ctx.json(200, { state: "disabled", indexing: false });
    const indexing = ctx.indexing();
    const model = ctx.cache.get();
    if (!model) return ctx.json(200, { state: indexing ? "indexing" : "empty", indexing });
    return ctx.json(200, { state: "ready", indexing, view: graphView(model, body) });
  }
  const model = ctx.enabled ? ctx.cache.get() : null;
  const missing = (): never => ctx.fail(404, "NOT_FOUND", "The project has no code index yet");
  if (ctx.path === "/v1/graph/file") {
    ctx.only("GET");
    const { path } = ctx.query(FileQuery);
    if (!model) return missing();
    const detail = graphFileDetail(model, path);
    if (!detail) return ctx.fail(404, "NOT_FOUND", `No indexed file ${path}`);
    return ctx.json(200, { ...detail, packages: graphFilePackages(ctx.workspace, path) });
  }
  if (ctx.path === "/v1/graph/link") {
    ctx.only("GET");
    const { from, to } = ctx.query(LinkQuery);
    if (!model) return missing();
    const link = explainGraphLink(ctx.workspace, from, to);
    if (!link) return ctx.fail(404, "NOT_FOUND", `${from} does not import ${to}`);
    return ctx.json(200, link);
  }
  if (ctx.path === "/v1/graph/search") {
    ctx.only("GET");
    const { q, limit } = ctx.query(SearchQuery);
    return ctx.json(200, { paths: model ? searchGraphFiles(model, q, limit) : [] });
  }
  return null;
}
