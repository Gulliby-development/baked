import { describe, expect, test } from "bun:test";
import { AttentionHub } from "../src/main/attention.ts";
import { href, parseRoute } from "../src/renderer/router.ts";
import type { AttentionItem } from "../src/shared/api.ts";
import {
  attentionHash,
  attentionId,
  attentionItemId,
  attentionTitle,
  detailKind,
  findAttention,
  groupAttention,
} from "../src/shared/attention.ts";

const base: AttentionItem = {
  runId: null,
  featureId: null,
  status: "waiting",
  requestId: null,
  kind: "approval",
  blocking: true,
  createdAt: 0,
  projectKey: "p1",
  projectName: "One",
};

const run = (runId: string, kind: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  ...base,
  source: "run",
  runId,
  featureId: runId,
  requestId: `${runId}-${kind}`,
  kind,
  ...extra,
});

const chat = (sessionId: string, requestId: string, kind = "question"): AttentionItem => ({
  ...base,
  source: "chat",
  sessionId,
  title: "A chat",
  requestId,
  kind,
});

describe("attention ids", () => {
  test("chat and initiative items are unique without a run", () => {
    const items = [
      chat("s1", "p1"),
      chat("s1", "p2"),
      chat("s2", "p1"),
      { ...base, source: "initiative" as const, initiativeId: "i1", requestId: "p1" },
      run("r1", "approval", { requestId: "p1" }),
    ];
    const ids = new Set(items.map(attentionId));
    expect(ids.size).toBe(items.length);
    expect(attentionItemId(chat("s1", "p2"))).toBe("chat:s1:p2");
  });

  test("items from older backends count as runs", () => {
    const legacy = { ...base, runId: "r1", requestId: "q" };
    expect(attentionItemId(legacy)).toBe("run:r1:q");
    expect(detailKind(legacy)).toBe("approval");
  });

  test("a blocked run without a request falls back to its kind", () => {
    expect(attentionItemId(run("r1", "blocked", { requestId: null }))).toBe("run:r1:blocked");
  });

  test("the notification hash opens the same item", () => {
    const item = chat("s 1", "p:2");
    const route = parseRoute(attentionHash(item));
    expect(route).toEqual({ name: "attention", key: "p1", id: attentionItemId(item) });
    expect(href(route)).toBe(attentionHash(item));
    if (route.name !== "attention") throw new Error("not an attention route");
    expect(findAttention([run("r1", "approval"), item], route.key, route.id)).toBe(item);
  });

  test("the hub keeps chat prompts of one session apart", () => {
    const hub = new AttentionHub(() => {});
    hub.event("p1", "One", {
      id: null,
      event: "attention",
      data: JSON.stringify({ items: [chat("s1", "a"), chat("s1", "b")] }),
    });
    expect(new Set(hub.items().map(attentionId)).size).toBe(2);
  });
});

describe("grouping", () => {
  const items = [
    run("r1", "approval", { createdAt: 30 }),
    run("r2", "manual_evidence", { blocking: false, createdAt: 10 }),
    chat("s1", "q1"),
    run("r3", "delivery", { projectKey: "p2", projectName: "Two", createdAt: 20 }),
  ];

  test("splits blocking from advisory, oldest first, with project counts", () => {
    const groups = groupAttention(items, null);
    expect(groups.blocking.map((i) => i.runId ?? i.sessionId)).toEqual(["s1", "r3", "r1"]);
    expect(groups.advisory.map((i) => i.runId)).toEqual(["r2"]);
    expect(groups.projects).toEqual([
      { key: "p1", name: "One", count: 3 },
      { key: "p2", name: "Two", count: 1 },
    ]);
    expect(groups.total).toBe(4);
  });

  test("a project filter keeps the counts of every project", () => {
    const groups = groupAttention(items, "p2");
    expect(groups.blocking.map((i) => i.runId)).toEqual(["r3"]);
    expect(groups.advisory).toEqual([]);
    expect(groups.projects).toHaveLength(2);
  });
});

describe("detail kinds and titles", () => {
  test("each source and kind picks its pane", () => {
    expect(detailKind(run("r", "approval"))).toBe("approval");
    expect(detailKind(run("r", "clarification"))).toBe("clarification");
    expect(detailKind(run("r", "delivery"))).toBe("delivery");
    expect(detailKind(run("r", "manual_evidence"))).toBe("run");
    expect(detailKind(run("r", "approval", { requestId: null }))).toBe("run");
    expect(detailKind(chat("s", "p", "question"))).toBe("chat-question");
    expect(detailKind(chat("s", "p", "outside-cwd"))).toBe("chat-approval");
    expect(detailKind({ ...base, source: "initiative", kind: "split_approval" })).toBe(
      "initiative",
    );
  });

  test("titles name what waits", () => {
    expect(attentionTitle(run("usage", "delivery"))).toBe("Deliver usage");
    expect(attentionTitle(chat("s", "p", "web-search"))).toBe("A chat: web search");
    expect(attentionTitle(run("r", "blocked", { requestId: null }))).toBe("r is blocked");
  });
});
