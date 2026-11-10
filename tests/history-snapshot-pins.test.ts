import { describe, expect, test } from "bun:test";
import {
  historySnapshot,
  historySnapshotting,
  pinHistoryStore,
  withHistorySnapshot,
} from "../src/core/workflows/history-snapshot.js";

// A pinned history store's reads are kept across snapshot scopes under the identity of its
// content, so the replay corpus reads each history trace once per state, not once per start (#3014).
describe("pinned history stores", () => {
  test("a pinned store is read once per identity and kind, across scopes; re-pinning reads again", () => {
    const store = "/replay/a/.baked/workflows.sqlite";
    let reads = 0;
    const read = () => historySnapshot(store, "history", () => ++reads);
    try {
      pinHistoryStore(store, "trace-a#");
      expect(historySnapshotting(store)).toBe(true);
      expect(withHistorySnapshot(read)).toBe(1);
      expect(withHistorySnapshot(read)).toBe(1);
      expect(read()).toBe(1);
      expect(historySnapshot(store, "samples", () => ++reads)).toBe(2);
      // The replay removed runs: the store holds other rows now.
      pinHistoryStore(store, "trace-a#run-2");
      expect(read()).toBe(3);
      // Another workspace of the same trace with the same runs removed shares the reads.
      const other = "/replay/b/.baked/workflows.sqlite";
      pinHistoryStore(other, "trace-a#run-2");
      expect(historySnapshot(other, "history", () => ++reads)).toBe(3);
      pinHistoryStore(other, null);
    } finally {
      pinHistoryStore(store, null);
    }
  });

  test("an unpinned store is read once per scope and every time outside one", () => {
    const store = "/replay/c/.baked/workflows.sqlite";
    let reads = 0;
    const read = () => historySnapshot(store, "history", () => ++reads);
    expect(historySnapshotting(store)).toBe(false);
    expect(read()).toBe(1);
    expect(read()).toBe(2);
    expect(withHistorySnapshot(() => [read(), read()])).toEqual([3, 3]);
    expect(withHistorySnapshot(read)).toBe(4);
  });
});
