/**
 * The initiative endpoints of the local API (`/v1/initiatives`), the `baked workflow initiative`
 * commands over HTTP. Starting, approving and resuming drive the initiative in the background.
 */
import { z } from "zod";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { InitiativePlanSchema, SplitEditSchema } from "../workflows/initiatives/plan.js";
import type { InitiativeService } from "../workflows/initiatives/service.js";
import { PolicySchema, SafeId } from "../workflows/schemas.js";
import type { RouteContext } from "./route-context.js";

export interface InitiativeRouteContext extends RouteContext {
  initiatives: InitiativeService;
  /** Drives the initiative in the background. */
  launch(id: string): void;
}

const Command = z.object({ commandId: SafeId, expectedRevision: z.number().int().min(0) });
const PositiveInt = z.number().int().min(1);
const StartBody = z.strictObject({
  commandId: SafeId,
  initiativeId: SafeId,
  prompt: z.string().min(1),
  plan: InitiativePlanSchema.optional(),
  workflow: SafeId.optional(),
  policy: z.unknown().optional(),
  model: z.string().min(1).optional(),
  owner: z.string().min(1).max(200).optional(),
  budget: z
    .strictObject({ tokens: PositiveInt, calls: PositiveInt, timeMs: PositiveInt })
    .optional(),
  tieredApproval: z.strictObject({ maxTasks: PositiveInt, maxFiles: PositiveInt }).optional(),
  confirmAutoApproval: z.string().min(1).optional(),
});
const MergeBody = Command.extend({
  features: z.array(SafeId).min(2),
  id: SafeId.optional(),
  title: z.string().min(1).optional(),
}).strict();
const SplitBody = Command.extend({ feature: SafeId, parts: z.unknown() }).strict();
const FeatureBody = Command.extend({ feature: SafeId }).strict();
const RenameBody = Command.extend({ feature: SafeId, title: z.string().min(1) }).strict();
const ApproveBody = Command.extend({ requestId: SafeId, digest: z.string().min(1) }).strict();
const RejectBody = Command.extend({ requestId: SafeId, reason: z.string().min(1) }).strict();
const ExtendBody = Command.extend({
  tokens: PositiveInt.optional(),
  calls: PositiveInt.optional(),
  timeMs: PositiveInt.optional(),
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
  "replan",
  "approve",
  "reject",
  "pause",
  "resume",
  "extend",
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
    const body = StartBody.parse(await ctx.readJson());
    const config = initiatives.workflows.config;
    const view = await initiatives.start({
      commandId: body.commandId,
      initiativeId: body.initiativeId,
      prompt: body.prompt,
      ...(body.plan ? { plan: body.plan } : {}),
      policy: PolicySchema.parse(body.policy ?? config.workflows?.policy ?? defaultWorkflowPolicy),
      workflowId: body.workflow ?? config.workflows?.defaultWorkflow ?? "sdd",
      budget: body.budget
        ? {
            maxTotalTokens: body.budget.tokens,
            maxAgentCalls: body.budget.calls,
            maxActiveMs: body.budget.timeMs,
          }
        : null,
      featureAutoApproval: body.tieredApproval ?? null,
      ...(body.confirmAutoApproval ? { autoApprovalConfirmation: body.confirmAutoApproval } : {}),
      ...(body.model ? { model: body.model } : {}),
      ownerLabel: body.owner ?? "API",
    });
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
    default:
      return ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
  }
}
