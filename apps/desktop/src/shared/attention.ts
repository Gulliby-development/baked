import type { AttentionItem, AttentionSource } from "./api.js";

type Identity = Pick<
  AttentionItem,
  "source" | "runId" | "sessionId" | "initiativeId" | "requestId" | "kind"
>;

export function sourceOf(item: Pick<AttentionItem, "source">): AttentionSource {
  return item.source ?? "run";
}

/**
 * The ID of an item within its project. Chat and initiative items have no run, so the owner
 * (run, session or initiative) and the source are both part of it.
 */
export function attentionItemId(item: Identity): string {
  const source = sourceOf(item);
  const owner =
    source === "chat" ? item.sessionId : source === "initiative" ? item.initiativeId : item.runId;
  return `${source}:${owner ?? "-"}:${item.requestId ?? item.kind}`;
}

/** The ID of an item across all projects. */
export function attentionId(item: Identity & Pick<AttentionItem, "projectKey">): string {
  return `${item.projectKey}:${attentionItemId(item)}`;
}

/** The route that opens an item in "Needs you", e.g. from a system notification. */
export function attentionHash(item: Identity & Pick<AttentionItem, "projectKey">): string {
  return `#/attention/${encodeURIComponent(item.projectKey)}/${encodeURIComponent(attentionItemId(item))}`;
}

export function findAttention(
  items: AttentionItem[],
  projectKey: string | undefined,
  itemId: string | undefined,
): AttentionItem | undefined {
  if (!projectKey || !itemId) return undefined;
  return items.find((i) => i.projectKey === projectKey && attentionItemId(i) === itemId);
}

export interface AttentionGroups {
  blocking: AttentionItem[];
  advisory: AttentionItem[];
  /** Projects with items, in order of first appearance, with their item counts. */
  projects: { key: string; name: string; count: number }[];
  total: number;
}

/** Splits the list for "Needs you": blocking first, oldest first in each group. */
export function groupAttention(items: AttentionItem[], projectKey: string | null): AttentionGroups {
  const projects = new Map<string, { key: string; name: string; count: number }>();
  for (const item of items) {
    const entry = projects.get(item.projectKey) ?? {
      key: item.projectKey,
      name: item.projectName,
      count: 0,
    };
    entry.count++;
    projects.set(item.projectKey, entry);
  }
  const shown = items
    .filter((i) => projectKey === null || i.projectKey === projectKey)
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    blocking: shown.filter((i) => i.blocking),
    advisory: shown.filter((i) => !i.blocking),
    projects: [...projects.values()],
    total: items.length,
  };
}

export function blockingCount(items: AttentionItem[]): number {
  return items.filter((i) => i.blocking).length;
}

/** Which detail pane answers an item. */
export type DetailKind =
  | "approval"
  | "clarification"
  | "delivery"
  | "chat-approval"
  | "chat-question"
  | "initiative"
  | "run";

export function detailKind(item: Pick<AttentionItem, "source" | "kind" | "requestId">): DetailKind {
  switch (sourceOf(item)) {
    case "chat":
      return item.kind === "question" ? "chat-question" : "chat-approval";
    case "initiative":
      return "initiative";
    case "run":
      if (item.requestId === null) return "run";
      if (item.kind === "approval" || item.kind === "clarification" || item.kind === "delivery")
        return item.kind;
      return "run";
  }
}

const KIND_LABEL: Record<string, string> = {
  approval: "approval",
  clarification: "clarification",
  delivery: "delivery",
  manual_evidence: "manual evidence",
  recovery: "recovery",
  checkpoint: "checkpoint",
  convergence: "convergence decision",
  "outside-cwd": "write outside the project",
  destructive: "destructive command",
  "web-search": "web search",
  "fetch-page": "page fetch",
  question: "question",
  "plan-review": "plan review",
  split_approval: "plan approval",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/[_-]+/g, " ");
}

/** The headline of an item in the list and in notifications. */
export function attentionTitle(item: AttentionItem): string {
  const source = sourceOf(item);
  if (source === "chat") return `${item.title || "Chat"}: ${kindLabel(item.kind)}`;
  if (source === "initiative") return `${item.title || item.initiativeId}: ${kindLabel(item.kind)}`;
  const feature = item.featureId ?? item.runId ?? "run";
  if (item.requestId === null) return `${feature} is blocked`;
  switch (item.kind) {
    case "approval":
      return `Approve ${feature}`;
    case "clarification":
      return `Answer questions for ${feature}`;
    case "delivery":
      return `Deliver ${feature}`;
    default:
      return `${feature}: ${kindLabel(item.kind)}`;
  }
}
