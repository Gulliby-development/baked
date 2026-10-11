/**
 * The chat endpoints of the local API: `/v1/sessions`, `/v1/models` and `/v1/mentions`. The contract is
 * `docs/desktop/api.md`; the sessions themselves live in `ChatService`.
 */
import type { ChatError, ChatService } from "../chat/sessions.js";
import { fetchProviderModels } from "../llm/models.js";
import { checkProviders } from "../llm/provider.js";
import type { RouteContext } from "./route-context.js";
import {
  CompactBody,
  CreateSessionBody,
  ForkSessionBody,
  MentionsQuery,
  MessageBody,
  ModelsQuery,
  PromptAnswerBody,
  SessionListQuery,
  UpdateSessionBody,
} from "./schemas.js";

export interface ChatRouteContext extends RouteContext {
  chat: ChatService;
}

const ID = "[A-Za-z0-9-]+";
const SESSION = new RegExp(
  `^/v1/sessions/(${ID})(?:/(fork|messages|interrupt|events|prompts|compact|diff)(?:/(${ID}))?)?$`,
);

export function chatErrorStatus(error: ChatError): number {
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "INVALID_REQUEST":
      return 400;
    case "NOT_SUPPORTED":
      return 501;
    default:
      return 409;
  }
}

/** Answers a chat request, or returns null when the path is not a chat endpoint. */
export async function chatRoute(ctx: ChatRouteContext): Promise<Response | null> {
  const { chat, path, method } = ctx;
  const { only } = ctx;
  if (path === "/v1/models") {
    only("GET");
    return ctx.json(200, await models(ctx.query(ModelsQuery).provider));
  }
  if (path === "/v1/mentions") {
    only("GET");
    const { q, limit } = ctx.query(MentionsQuery);
    const max = Math.min(50, limit ? Number(limit) : 20);
    const mentions = chat.host.suggestMentions ? await chat.host.suggestMentions(q ?? "", max) : [];
    return ctx.json(200, { mentions });
  }
  if (path === "/v1/sessions") {
    only("GET", "POST");
    if (method === "GET") {
      const { limit } = ctx.query(SessionListQuery);
      return ctx.json(200, { sessions: chat.list(limit ? Number(limit) : undefined) });
    }
    const body = CreateSessionBody.parse(await ctx.readJson());
    const session = await chat.create({
      ...(body.title ? { title: body.title } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
    });
    if (body.text) session.send(body.text);
    return ctx.json(201, session.detail());
  }
  const match = SESSION.exec(path);
  if (!match?.[1]) return null;
  const [, id, action, sub] = match;
  if (action === undefined) {
    only("GET", "PATCH", "DELETE");
    if (method === "GET") return ctx.json(200, chat.get(id).detail());
    if (method === "DELETE") {
      chat.delete(id);
      return new Response(null, { status: 204 });
    }
    const body = UpdateSessionBody.parse(await ctx.readJson());
    return ctx.json(200, chat.get(id).update(body));
  }
  if (action === "events") {
    only("GET");
    const session = chat.get(id);
    const lastEventId = ctx.req.headers.get("last-event-id");
    const after =
      lastEventId ?? ctx.url.searchParams.get("after") ?? String(session.detail().lastSeq);
    if (!/^\d+$/.test(after))
      ctx.fail(400, "INVALID_REQUEST", "Last-Event-ID and after must be event sequences");
    ctx.keepOpen();
    return ctx.stream((send) => {
      const frame = (type: string, data: unknown, seq?: number): void =>
        send(
          `${seq === undefined ? "" : `id: ${seq}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      const unsubscribe = session.subscribe(Number(after), (event) =>
        frame(event.type, event, event.seq),
      );
      if (unsubscribe) return unsubscribe;
      frame("reset", { lastSeq: session.detail().lastSeq });
      return () => {};
    });
  }
  if (action === "diff") {
    only("GET");
    if (sub !== undefined) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
    return ctx.json(200, await chat.get(id).diffStats());
  }
  only("POST");
  if (action === "prompts") {
    if (!sub) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
    const body = PromptAnswerBody.parse(await ctx.readJson());
    chat.get(id).answer(sub, body);
    return ctx.json(200, { resolved: true });
  }
  if (sub !== undefined) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
  if (action === "fork") {
    const body = ForkSessionBody.parse(await ctx.readJson());
    const { session, rollback } = await chat.fork(id, body.atMessageId, body);
    return ctx.json(201, { ...session.detail(), ...(rollback ? { rollback } : {}) });
  }
  if (action === "compact") {
    CompactBody.parse(await ctx.readJson());
    return ctx.json(202, chat.get(id).compact());
  }
  if (action === "messages") {
    const body = MessageBody.parse(await ctx.readJson());
    return ctx.json(202, chat.get(id).send(body.text));
  }
  // interrupt
  return ctx.json(200, { interrupted: chat.get(id).interrupt() });
}

async function models(only: string | undefined) {
  const statuses = (await checkProviders()).filter((p) => only === undefined || p.id === only);
  const providers = await Promise.all(
    statuses.map(async (status) => {
      const fetched = status.available ? await fetchProviderModels(status.id) : { models: [] };
      return {
        id: status.id,
        name: status.name,
        configured: status.available,
        models: fetched.models.map((m) => ({
          id: `${status.id}/${m.id}`,
          name: m.name,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        })),
        ...("error" in fetched && fetched.error ? { error: fetched.error } : {}),
      };
    }),
  );
  return { providers };
}
