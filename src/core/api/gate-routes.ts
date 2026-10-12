/**
 * Gates written from a sentence over the local API (`gate-drafts` capability, #372): draft a gate
 * with the configured model, save a draft a person confirmed, and read one gate in words. Core
 * logic is in src/core/workflows/v2/gate-draft.ts; `baked workflow gate` is the same in a shell.
 */
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { PolicySchema, SafeId } from "../workflows/schemas.js";
import {
  configuredDraftModel,
  type DraftModel,
  draftGate,
  gateCapabilities,
  saveGateDraft,
} from "../workflows/v2/gate-draft.js";
import { bindGate, gatePlaces } from "../workflows/v2/gate-placement.js";
import { describeGate, loadGateLibrary, readConfirmations } from "../workflows/v2/library.js";
import type { RouteContext } from "./route-context.js";

export interface GateRouteContext extends RouteContext {
  workspace: string;
  config: AppConfig;
  /** Tests pass a scripted model; otherwise the configured one drafts. */
  draftModel?: DraftModel;
}

const DraftBody = z.strictObject({
  text: z.string().min(1).max(4000),
  kind: z.enum(["command", "ai-acceptance", "human", "ai-review"]).optional(),
  id: SafeId.optional(),
  fromCriteria: z.boolean().optional(),
  model: z.string().min(1).max(200).optional(),
});
const SaveBody = z.strictObject({
  gate: z.unknown(),
  script: z
    .strictObject({ path: z.string().min(1).max(256), content: z.string().min(1).max(20000) })
    .nullable()
    .optional(),
});

const PlacesQuery = z.strictObject({ workflow: SafeId.optional() });
const BindBody = z.strictObject({
  workflow: SafeId.optional(),
  at: z.string().regex(/^(stage|transition):[A-Za-z0-9_-]{1,96}$/),
});

/** Answers a gate draft request, or returns null when the path is not one. */
export async function gateRoute(ctx: GateRouteContext): Promise<Response | null> {
  const policy = () => PolicySchema.parse(ctx.config.workflows?.policy ?? defaultWorkflowPolicy);
  const library = () => loadGateLibrary(ctx.workspace, policy());
  if (ctx.path === "/v1/workflow/gates/draft") {
    ctx.only("POST");
    const body = DraftBody.parse(await ctx.readJson());
    try {
      const draft = await draftGate(
        ctx.workspace,
        {
          text: body.text,
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.id ? { id: body.id } : {}),
          ...(body.fromCriteria ? { fromCriteria: true } : {}),
        },
        ctx.draftModel ?? configuredDraftModel(ctx.config, body.model),
        library(),
      );
      return ctx.json(200, draft);
    } catch (error) {
      ctx.fail(422, "DRAFT_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
  if (ctx.path === "/v1/workflow/gates" && ctx.method === "POST") {
    const body = SaveBody.parse(await ctx.readJson());
    try {
      return ctx.json(
        201,
        saveGateDraft(ctx.workspace, { gate: body.gate, script: body.script ?? null }, library),
      );
    } catch (error) {
      ctx.fail(422, "INVALID_GATE", error instanceof Error ? error.message : String(error));
    }
  }
  const placement = /^\/v1\/workflow\/gates\/([^/]+)\/(places|bind)$/.exec(ctx.path);
  if (placement) {
    const id = decodeURIComponent(placement[1] ?? "");
    const fallback = ctx.config.workflows?.defaultWorkflow ?? "sdd";
    const places = placement[2] === "places";
    ctx.only(places ? "GET" : "POST");
    const query = places ? ctx.query(PlacesQuery) : null;
    const body = places ? null : BindBody.parse(await ctx.readJson());
    try {
      return ctx.json(
        200,
        body
          ? bindGate(ctx.workspace, body.workflow ?? fallback, id, body.at, policy())
          : gatePlaces(ctx.workspace, query?.workflow ?? fallback, id, policy()),
      );
    } catch (error) {
      ctx.fail(422, "INVALID_PLACE", error instanceof Error ? error.message : String(error));
    }
  }
  const match = /^\/v1\/workflow\/gates\/([^/]+)$/.exec(ctx.path);
  if (match && match[1] !== "confirm" && ctx.method === "GET") {
    const entry = library().entries.get(decodeURIComponent(match[1] ?? ""));
    if (!entry) ctx.fail(404, "NOT_FOUND", `No gate ${match[1]}`);
    const confirmed = readConfirmations(ctx.workspace)[entry.gate.id] === entry.hash;
    return ctx.json(200, {
      id: entry.gate.id,
      type: entry.gate.type,
      mode: entry.gate.required ? "required" : "advisory",
      source: entry.source,
      path: entry.path,
      summary: describeGate(entry),
      ...(entry.source === "project" ? { confirmed } : {}),
      capabilities: gateCapabilities(entry.gate, null),
      gate: entry.gate,
    });
  }
  return null;
}
