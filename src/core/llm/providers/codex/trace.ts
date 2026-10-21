import { appendFileSync } from "node:fs";
import type { CodexAppServerConnection } from "./client.js";

/**
 * The app-server traffic of a connection as JSON lines in `file`, when `BAKED_CODEX_TRACE` names
 * one (#1876): each request, response, notification and server request with its method, id,
 * thread and turn, and the size of its payload, never its text. A stalled resumed tool call shows
 * what the app-server last sent on the thread and what BAKED answered.
 */
export function tracedConnection(
  connection: CodexAppServerConnection,
  file: string,
): CodexAppServerConnection {
  const startedAt = Date.now();
  const write = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(file, `${JSON.stringify({ ms: Date.now() - startedAt, ...entry })}\n`);
    } catch {
      // A trace that cannot be written never breaks the call it describes.
    }
  };
  return {
    get closed() {
      return connection.closed;
    },
    request: async (method, params, timeoutMs) => {
      write({ dir: "out", kind: "request", method, ...traceIds(params), bytes: size(params) });
      try {
        const result = await connection.request(method, params, timeoutMs);
        write({ dir: "in", kind: "result", method, ...traceIds(result), bytes: size(result) });
        return result;
      } catch (error) {
        write({ dir: "in", kind: "error", method, message: String(error).slice(0, 200) });
        throw error;
      }
    },
    waitForNotification: (method, predicate, timeoutMs) =>
      connection.waitForNotification(method, predicate, timeoutMs),
    close: () => {
      write({ kind: "close" });
      connection.close();
    },
    onNotification: (listener) =>
      connection.onNotification((method, params) => {
        write({
          dir: "in",
          kind: "notification",
          method,
          ...traceIds(params),
          bytes: size(params),
        });
        listener(method, params);
      }),
    onClose: (listener) =>
      connection.onClose((error) => {
        write({ kind: "closed", message: error.message.slice(0, 200) });
        listener(error);
      }),
    onServerRequest: (listener) =>
      connection.onServerRequest((method, id, params) => {
        const handled = listener(method, id, params);
        write({
          dir: "in",
          kind: "server-request",
          method,
          id,
          ...traceIds(params),
          bytes: size(params),
          handled,
        });
        return handled;
      }),
    respond: (id, result) => {
      write({ dir: "out", kind: "respond", id, bytes: size(result) });
      connection.respond(id, result);
    },
    respondError: (id, message) => {
      write({ dir: "out", kind: "respond-error", id, message: message.slice(0, 200) });
      connection.respondError(id, message);
    },
  };
}

function traceIds(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const ids: Record<string, unknown> = {};
  for (const key of ["threadId", "turnId", "callId", "itemId", "tool", "status"])
    if (typeof record[key] === "string") ids[key] = record[key];
  const nested = (record.thread ?? record.turn ?? record.item) as Record<string, unknown> | null;
  if (nested && typeof nested === "object") {
    if (typeof nested.id === "string") ids.id = nested.id;
    if (typeof nested.type === "string") ids.type = nested.type;
    if (typeof nested.status === "string") ids.status = nested.status;
  }
  return ids;
}

function size(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return -1;
  }
}
