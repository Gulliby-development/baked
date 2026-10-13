/**
 * The chat endpoints of the local API: `/v1/sessions`, `/v1/coordinator`, `/v1/models` and
 * `/v1/mentions`. The contract is `docs/desktop/api.md`; the sessions themselves live in
 * `ChatService`.
 */

import { ApprovalRulesStore } from "../chat/approval-rules.js";
import { BriefError, BriefStore } from "../chat/coordinator.js";
import { requestSummary } from "../chat/coordinator-summary.js";
import {
  acceptImages,
  type ImageInput,
  ImageInputError,
  MAX_IMAGE_BODY_BYTES,
} from "../chat/images.js";
import { ChatError, type ChatService } from "../chat/sessions.js";
import { loadModelCatalog } from "../llm/model-catalog.js";
import { chatExportFileName, renderChatExport } from "../sessions/export.js";
import type { RouteContext } from "./route-context.js";
import {
  ApprovalRulesBody,
  BriefBody,
  CompactBody,
  CoordinatorBody,
  CreateSessionBody,
  ForkSessionBody,
  MentionsQuery,
  MessageBody,
  ModelsQuery,
  PromptAnswerBody,
  RedoSessionBody,
  SessionExportQuery,
  SessionListQuery,
  UndoSessionBody,
  UpdateSessionBody,
  WatchBody,
} from "./schemas.js";

export interface ChatRouteContext extends RouteContext {
  chat: ChatService;
}

const ID = "[A-Za-z0-9-]+";
const SESSION = new RegExp(
  `^/v1/sessions/(${ID})(?:/(fork|messages|interrupt|events|prompts|compact|diff|export|undo|redo|checkpoints|watch)(?:/(${ID}))?)?$`,
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
    return ctx.json(200, await loadModelCatalog(ctx.query(ModelsQuery).provider));
  }
  if (path === "/v1/mentions") {
    only("GET");
    const { q, limit } = ctx.query(MentionsQuery);
    const max = Math.min(50, limit ? Number(limit) : 20);
    const mentions = chat.host.suggestMentions ? await chat.host.suggestMentions(q ?? "", max) : [];
    return ctx.json(200, { mentions });
  }
  if (path === "/v1/coordinator") {
    only("GET", "POST");
    if (method === "GET") {
      const session = await chat.coordinator(false);
      if (!session) ctx.fail(404, "NOT_FOUND", "This project has no coordinator yet");
      return ctx.json(200, session.detail());
    }
    const body = CoordinatorBody.parse(await ctx.readJson());
    const existing = await chat.coordinator(false);
    if (existing) return ctx.json(200, existing.detail());
    const created = await chat.coordinator(true, body.model);
    if (!created) ctx.fail(500, "INTERNAL", "The coordinator could not be created");
    return ctx.json(201, created.detail());
  }
  if (path === "/v1/coordinator/launched") {
    only("GET");
    const session = await chat.coordinator(false);
    if (!session) ctx.fail(404, "NOT_FOUND", "This project has no coordinator yet");
    return ctx.json(200, { launched: chat.launched(session.id) });
  }
  if (path === "/v1/coordinator/summary") {
    only("POST");
    const session = await chat.coordinator(false);
    if (!session) ctx.fail(404, "NOT_FOUND", "This project has no coordinator yet");
    return ctx.json(202, requestSummary(session));
  }
  if (path === "/v1/coordinator/brief") {
    only("GET", "PUT");
    const session = await chat.coordinator(false);
    if (!session) ctx.fail(404, "NOT_FOUND", "This project has no coordinator yet");
    const store = new BriefStore(chat.workspace, session.id);
    if (method === "GET") return ctx.json(200, store.read());
    const { expectedRevision, ...content } = BriefBody.parse(await ctx.readJson());
    try {
      return ctx.json(200, store.write(content, expectedRevision));
    } catch (err) {
      if (err instanceof BriefError)
        ctx.fail(err.code === "STALE_REVISION" ? 409 : 400, err.code, err.message);
      throw err;
    }
  }
  if (path === "/v1/coordinator/approval-rules") {
    only("GET", "PUT");
    const session = await chat.coordinator(false);
    if (!session) ctx.fail(404, "NOT_FOUND", "This project has no coordinator yet");
    const store = new ApprovalRulesStore(chat.workspace, session.id);
    if (method === "GET") return ctx.json(200, store.read());
    const { expectedRevision, ...content } = ApprovalRulesBody.parse(await ctx.readJson());
    try {
      return ctx.json(200, store.write(content, expectedRevision));
    } catch (err) {
      if (err instanceof BriefError)
        ctx.fail(err.code === "STALE_REVISION" ? 409 : 400, err.code, err.message);
      throw err;
    }
  }
  if (path === "/v1/sessions") {
    only("GET", "POST");
    if (method === "GET") {
      const { limit } = ctx.query(SessionListQuery);
      return ctx.json(200, { sessions: chat.list(limit ? Number(limit) : undefined) });
    }
    const body = CreateSessionBody.parse(await ctx.readJson(MAX_IMAGE_BODY_BYTES));
    const images = body.images ? checkedImages(body.images) : undefined;
    const session = await chat.create({
      ...(body.title ? { title: body.title } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      ...(body.permissions ? { permissions: body.permissions } : {}),
      ...(body.contextSize !== undefined ? { contextSize: body.contextSize } : {}),
    });
    if (body.text || images) session.send(body.text ?? "", images);
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
  if (action === "checkpoints") {
    only("GET");
    if (sub !== undefined) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
    return ctx.json(200, chat.get(id).checkpoints());
  }
  if (action === "export") {
    only("GET");
    if (sub !== undefined) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
    const format = ctx.query(SessionExportQuery).format ?? "markdown";
    const { title, messages } = chat.get(id).detail();
    const fileName = chatExportFileName(title, format);
    return new Response(renderChatExport(messages, format, title), {
      status: 200,
      headers: {
        "content-type":
          format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${fileName}"`,
      },
    });
  }
  if (action === "watch") {
    only("GET", "POST");
    if (sub !== undefined) ctx.fail(404, "NOT_FOUND", `No endpoint ${path}`);
    if (method === "GET") return ctx.json(200, chat.watchStatus(id));
    const { on } = WatchBody.parse(await ctx.readJson());
    return ctx.json(200, chat.setWatch(id, on));
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
  if (action === "undo" || action === "redo") {
    const session = chat.get(id);
    const result =
      action === "undo"
        ? await session.undo(UndoSessionBody.parse(await ctx.readJson()))
        : await session.redo(RedoSessionBody.parse(await ctx.readJson()));
    return ctx.json(200, { ...session.detail(), rollback: result.rollback });
  }
  if (action === "compact") {
    CompactBody.parse(await ctx.readJson());
    return ctx.json(202, chat.get(id).compact());
  }
  if (action === "messages") {
    const body = MessageBody.parse(await ctx.readJson(MAX_IMAGE_BODY_BYTES));
    const images = body.images ? checkedImages(body.images) : undefined;
    return ctx.json(202, chat.get(id).send(body.text, images));
  }
  // interrupt
  return ctx.json(200, { interrupted: chat.get(id).interrupt() });
}

function checkedImages(inputs: ImageInput[]) {
  try {
    return acceptImages(inputs);
  } catch (err) {
    if (err instanceof ImageInputError) throw new ChatError("INVALID_REQUEST", err.message);
    throw err;
  }
}
