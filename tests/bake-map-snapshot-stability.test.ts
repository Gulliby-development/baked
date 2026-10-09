import { describe, expect, test } from "bun:test";
import { BakeMapSnapshot } from "../src/core/context/bake-map-snapshot.js";
import { cacheTtlToMs, supportsPromptCache } from "../src/core/llm/cache-support.js";
import { hash32Hex } from "../src/core/utils/hash.js";

describe("BakeMapSnapshot — idle TTL", () => {
  test("read returns frozen content and bumps lastAccessedAt", () => {
    const snap = new BakeMapSnapshot(
      { content: "v1", paths: new Set(), ttlMs: 60_000 },
      1_000,
    );
    expect(snap.read(2_000)).toBe("v1");
    expect(snap.lastAccessedAt).toBe(2_000);
    expect(snap.read(50_000)).toBe("v1");
    expect(snap.lastAccessedAt).toBe(50_000);
  });

  test("continuous use stays hot past birth-time TTL", () => {
    const snap = new BakeMapSnapshot({ content: "x", paths: new Set(), ttlMs: 60_000 }, 0);
    // Read every 30s for an hour — birth at 0, last access at 3_600_000.
    for (let t = 30_000; t <= 3_600_000; t += 30_000) {
      snap.read(t);
      expect(snap.isIdleExpired(t)).toBe(false);
    }
  });

  test("idle past TTL marks expired", () => {
    const snap = new BakeMapSnapshot({ content: "x", paths: new Set(), ttlMs: 60_000 }, 0);
    snap.read(10_000);
    expect(snap.isIdleExpired(60_000)).toBe(false);
    expect(snap.isIdleExpired(70_001)).toBe(true);
  });

  test("hash is deterministic and stable for same content", () => {
    const a = new BakeMapSnapshot({ content: "hello world", paths: new Set(), ttlMs: 0 });
    const b = new BakeMapSnapshot({ content: "hello world", paths: new Set(), ttlMs: 0 });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(hash32Hex("hello world"));
  });
});

describe("cacheTtlToMs", () => {
  test("maps 5m and 1h", () => {
    expect(cacheTtlToMs("5m")).toBe(5 * 60_000);
    expect(cacheTtlToMs("1h")).toBe(60 * 60_000);
  });
});
