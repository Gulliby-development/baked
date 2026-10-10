import { describe, expect, test } from "bun:test";
import { AttentionHub } from "../src/main/attention.ts";
import type { AttentionItem } from "../src/shared/api.ts";

const raw = (runId: string, createdAt: number, blocking = true) => ({
  runId,
  featureId: runId,
  status: "waiting",
  requestId: `${runId}-req`,
  kind: "approval",
  blocking,
  createdAt,
});

const event = (items: unknown[]) => ({ id: null, event: "attention", data: JSON.stringify({ items }) });

describe("AttentionHub", () => {
  test("merges projects newest first and reports only new items", () => {
    const calls: { items: AttentionItem[]; added: AttentionItem[] }[] = [];
    const hub = new AttentionHub((items, added) => calls.push({ items, added }));
    hub.event("a", "A", event([raw("r1", 10)]));
    hub.event("b", "B", event([raw("r2", 20)]));
    expect(calls.at(-1)?.items.map((i) => i.runId)).toEqual(["r2", "r1"]);
    // What was waiting when a project opened is not news.
    expect(calls.flatMap((c) => c.added)).toEqual([]);
    hub.event("a", "A", event([raw("r1", 10), raw("r3", 30)]));
    expect(calls.at(-1)?.added.map((i) => i.runId)).toEqual(["r3"]);
    expect(calls.at(-1)?.items[0]?.projectName).toBe("A");
  });

  test("drops a closed project and ignores other events", () => {
    const hub = new AttentionHub(() => {});
    hub.event("a", "A", event([raw("r1", 10)]));
    hub.event("a", "A", { id: null, event: "message", data: "{}" });
    expect(hub.items()).toHaveLength(1);
    hub.remove("a");
    expect(hub.items()).toEqual([]);
  });
});
