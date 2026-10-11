/**
 * Everything in a project that waits for a person: pending run requests and blocked runs, pending
 * initiative decisions and, where a chat service runs, chat prompts. `GET /v1/attention` and
 * `baked attention` list the same items.
 */
import type { InitiativeStore } from "./initiatives/store.js";
import type { RunState } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import { isAcceptanceRequest } from "./v2/acceptance.js";

/** One thing waiting for a person: a pending request, or a blocked run (`requestId` null). */
export interface AttentionItem {
  /** A run's request or blocked run, a chat session's pending prompt, or an initiative's request. */
  source: "run" | "chat" | "initiative";
  /** Set on initiative items only. */
  initiativeId?: string;
  runId: string | null;
  featureId: string | null;
  sessionId: string | null;
  /** The session title of a chat prompt, or the initiative title. */
  title: string | null;
  status: RunState;
  requestId: string | null;
  /** The request kind, or the reason of a blocked run. */
  kind: string;
  /** False for an advisory acceptance request, which the run does not wait for. */
  blocking: boolean;
  createdAt: number;
}

/** A pending prompt of a live chat session. */
export interface ChatAttention {
  sessionId: string;
  title: string;
  promptId: string;
  kind: string;
  createdAt: number;
}

/** The attention list, oldest first. */
export function attentionItems(
  runs: WorkflowStore,
  initiatives: InitiativeStore,
  chat: ChatAttention[] = [],
): AttentionItem[] {
  const runItems: AttentionItem[] = runs.attention().map((row) => ({
    source: "run",
    sessionId: null,
    title: null,
    runId: row.run_id,
    featureId: row.feature_id,
    status: row.status,
    requestId: row.request_id,
    kind: row.kind,
    // An acceptance test's decision is advisory: the run goes on without it.
    blocking:
      row.body_json === null || !isAcceptanceRequest({ kind: row.kind, body_json: row.body_json }),
    createdAt: row.created_at,
  }));
  const prompts: AttentionItem[] = chat.map((prompt) => ({
    source: "chat",
    sessionId: prompt.sessionId,
    title: prompt.title,
    runId: null,
    featureId: null,
    status: "waiting",
    requestId: prompt.promptId,
    kind: prompt.kind,
    blocking: true,
    createdAt: prompt.createdAt,
  }));
  const decisions: AttentionItem[] = initiatives.list().flatMap((row) =>
    initiatives
      .requests(row.id)
      .filter((request) => request.status === "pending")
      .map(
        (request): AttentionItem => ({
          source: "initiative",
          initiativeId: row.id,
          sessionId: null,
          title: row.title,
          runId: null,
          featureId: null,
          status: "waiting",
          requestId: request.id,
          kind: request.kind,
          blocking: true,
          createdAt: request.created_at,
        }),
      ),
  );
  return [...runItems, ...prompts, ...decisions].sort((a, b) => a.createdAt - b.createdAt);
}
