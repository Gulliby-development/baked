/**
 * The initiative endpoints of the local API (`/v1/initiatives`), the `baked workflow initiative`
 * commands over HTTP. Starting, approving and resuming drive the initiative in the background.
 */
import { z } from "zod";
import {
  InitiativeStartInputSchema,
  initiativeStartRequest,
} from "../workflows/initiatives/forms.js";
import { SplitEditSchema } from "../workflows/initiatives/plan.js";
import type { InitiativeService } from "../workflows/initiatives/service.js";
import { SafeId } from "../workflows/schemas.js";
import type { RouteContext } from "./route-context.js";

export interface InitiativeRouteContext extends RouteContext {
  initiatives: InitiativeService;
  /** Drives the initiative in the background. */
  launch(id: string): void;
}

const Command = z.object({ commandId: SafeId, expectedRevision: z.number().int().min(0) });
const PositiveInt = z.number().int().min(1);
const StartBody = InitiativeStartInputSchema.extend({
  commandId: SafeId,
  owner: z.string().min(1).max(200).optional(),
});
const MergeBody = Command.extend({
  features: z.array(SafeId).min(2),
  id: SafeId.optional(),
  title: z.string().min(1).optional(),
}).strict();
const SplitBody = Command.extend({ feature: SafeId, parts: z.unknown() }).strict();
const FeatureBody = Command.extend({ feature: SafeId }).strict();
const RenameBody = Command.extend({ feature: SafeId, title: z.string().min(1) }).strict();
/** One setting of a feature per call: the workflow its runs use, or its size. */
const ConfigureBody = z.union([
  Command.extend({ feature: SafeId, workflow: SafeId }).strict(),
  Command.extend({ feature: SafeId, size: z.enum(["small", "medium", "large"]) }).strict(),
]);
const ApproveBody = Command.extend({ requestId: SafeId, digest: z.string().min(1) }).strict();
const RejectBody = Command.extend({ requestId: SafeId, reason: z.string().min(1) }).strict();
const ExtendBody = Command.extend({
  tokens: PositiveInt.optional(),
  calls: PositiveInt.optional(),
  timeMs: PositiveInt.optional(),
}).strict();
const RerouteBody = Command.extend({
  model: z.string().min(1),
  resume: z.boolean().optional(),
}).strict();
const EventsQuery = z.strictObject({
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

const ACTIONS = new Set([
  "merge",
  "split",
  "remove",
  "rename",
  "configure",
  "replan",
  "approve",
  "reject",
  "pause",
  "resume",
  "extend",
  "reroute",
]);
const PATH = /^\/v1\/initiatives\/([^/]+)(?:\/([a-z]+))?$/;
const identity = (body: z.infer<typeof Command>) => ({
  commandId: body.commandId,
  expectedRevision: body.expectedRevision,
});

/** Answers an initiative request, or returns null when the path is not an initiative endpoint. */
export async function initiativeRoute(ctx: InitiativeRouteContext): Promise<Response | null> {
  const { initiatives, path, method } = ctx;
  if (path === "/v1/initiatives") {
    ctx.only("GET", "POST");
    if (method === "GET")
      return ctx.json(200, {
        initiatives: initiatives.list().map((view) => ({
          initiativeId: view.initiativeId,
          title: view.title,
          status: view.status,
          features: view.features.length,
          next: view.next,
        })),
      });
    const { commandId, owner, ...input } = StartBody.parse(await ctx.readJson());
    const view = await initiatives.start(
      initiativeStartRequest(input, initiatives.workflows.config, {
        commandId,
        ownerLabel: owner ?? "API",
      }),
    );
    ctx.launch(view.initiativeId);
    return ctx.json(202, view);
  }
  const match = PATH.exec(path);
  if (!match?.[1]) return null;
  const id = SafeId.parse(decodeURIComponent(match[1]));
  const action = match[2];
  if (action === undefined) {
    ctx.only("GET");
    return ctx.json(200, initiatives.view(id));
  }
  if (action === "events") {
    ctx.only("GET");
    const query = ctx.query(EventsQuery);
    const lastEventId = ctx.req.headers.get("last-event-id");
    if (lastEventId !== null && !/^\d+$/.test(lastEventId))
      ctx.fail(400, "INVALID_REQUEST", "Last-Event-ID must be an event sequence");
    let after = Number(lastEventId ?? query.after ?? 0);
    if (ctx.wantsJson()) {
      const events = initiatives.events(id, after, Math.min(Number(query.limit ?? 200), 1000));
      return ctx.json(200, { events, lastSeq: events.at(-1)?.seq ?? after });
    }
    initiatives.view(id);
    ctx.keepOpen();
    return ctx.poll((send) => {
      for (;;) {
        const page = initiatives.events(id, after, 200);
        for (const event of page) {
          send(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.seq;
        }
        if (page.length < 200) break;
      }
    });
  }
  ctx.only("POST");
  if (!ACTIONS.has(action)) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
  const raw = await ctx.readJson();
  switch (action) {
    case "merge": {
      const body = MergeBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.edit(
          id,
          identity(body),
          SplitEditSchema.parse({
            op: "merge",
            featureIds: body.features,
            ...(body.id ? { id: body.id } : {}),
            ...(body.title ? { title: body.title } : {}),
          }),
        ),
      );
    }
    case "split": {
      const body = SplitBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.edit(
          id,
          identity(body),
          SplitEditSchema.parse({ op: "split", featureId: body.feature, into: body.parts }),
        ),
      );
    }
    case "remove": {
      const body = FeatureBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.edit(id, identity(body), { op: "remove", featureId: body.feature }),
      );
    }
    case "rename": {
      const body = RenameBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.edit(id, identity(body), {
          op: "rename",
          featureId: body.feature,
          title: body.title,
        }),
      );
    }
    case "configure": {
      const body = ConfigureBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.edit(
          id,
          identity(body),
          "workflow" in body
            ? { op: "workflow", featureId: body.feature, workflow: body.workflow }
            : { op: "size", featureId: body.feature, size: body.size },
        ),
      );
    }
    case "replan": {
      const body = FeatureBody.parse(raw);
      return ctx.json(200, await initiatives.replan(id, identity(body), body.feature));
    }
    case "approve": {
      const body = ApproveBody.parse(raw);
      const view = await initiatives.approve(id, identity(body), {
        requestId: body.requestId,
        digest: body.digest,
      });
      ctx.launch(id);
      return ctx.json(200, view);
    }
    case "reject": {
      const body = RejectBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.reject(id, identity(body), {
          requestId: body.requestId,
          reason: body.reason,
        }),
      );
    }
    case "pause":
      return ctx.json(200, await initiatives.pause(id, identity(Command.strict().parse(raw))));
    case "resume": {
      const view = await initiatives.resume(id, identity(Command.strict().parse(raw)));
      ctx.launch(id);
      return ctx.json(200, view);
    }
    case "extend": {
      const body = ExtendBody.parse(raw);
      return ctx.json(
        200,
        await initiatives.extendBudget(id, identity(body), {
          ...(body.tokens !== undefined ? { maxTotalTokens: body.tokens } : {}),
          ...(body.calls !== undefined ? { maxAgentCalls: body.calls } : {}),
          ...(body.timeMs !== undefined ? { maxActiveMs: body.timeMs } : {}),
        }),
      );
    }
    case "reroute": {
      const body = RerouteBody.parse(raw);
      const view = await initiatives.reroute(id, identity(body), {
        model: body.model,
        resume: body.resume === true,
      });
      if (body.resume) ctx.launch(id);
      return ctx.json(200, view);
    }
    default:
      return ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
  }
}
