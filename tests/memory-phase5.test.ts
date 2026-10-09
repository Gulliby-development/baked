import { describe, expect, it } from "bun:test";
import { MemoryDB } from "../src/core/memory/db.js";

describe("MemoryDB — Phase 5 contradiction hints on write", () => {
  it("attaches similarHints when a near-duplicate paraphrase is written", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({
        summary: "use bun for all script execution, never npm or node",
        details: "project standard since switch from node",
        category: "decision",
        topics: ["tooling", "bun"],
        source: "user",
      });
      const second = db.write({
        summary: "use bun for all script execution, not npm or node",
        details: "project standard since switch from node runtime",
        category: "decision",
        topics: ["tooling"],
        source: "agent",
      });
      // Different content_hash (slight wording change) → fresh insert.
      expect(second.deduped).toBe(false);
      expect(second.similarHints).toBeDefined();
      expect(second.similarHints!.length).toBeGreaterThanOrEqual(1);
      expect(second.similarHints![0]!.weight).toBeGreaterThanOrEqual(0.6);
    } finally {
      db.close();
    }
  });

  it("does NOT attach hints when no existing memory is similar enough", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({
        summary: "use bun for scripts",
        details: "",
        category: "decision",
        topics: [],
        source: "user",
      });
      const second = db.write({
        summary: "kubernetes ingress controller config uses nginx",
        details: "",
        category: "context",
        topics: [],
        source: "agent",
      });
      expect(second.similarHints).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("dedup hit (same content_hash) does NOT produce hints (no fresh insert)", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({
        summary: "exact match summary",
        details: "exact match details",
        category: null,
        topics: [],
        source: "agent",
      });
      const dup = db.write({
        summary: "exact match summary",
        details: "exact match details",
        category: null,
        topics: [],
        source: "agent",
      });
      expect(dup.deduped).toBe(true);
      expect(dup.similarHints).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
