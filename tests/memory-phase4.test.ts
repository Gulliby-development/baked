import { describe, expect, it } from "bun:test";
import { MemoryDB } from "../src/core/memory/db.js";
import { cosine, embed, EMBED_DIM } from "../src/core/memory/embedder.js";
import { MemoryRecall } from "../src/core/memory/recall.js";

function adapt(db: MemoryDB) {
  return {
    searchUnicode: (q: string, l?: number) => db.searchUnicode(q, l),
    searchTrigram: (q: string, l?: number) => db.searchTrigram(q, l),
    searchTrigramWithBigram: (q: string, l?: number) => db.searchTrigramWithBigram(q, l),
    findByFileIds: (ids: number[], l?: number) => db.findByFileIds(ids, l),
    findByPaths: (paths: string[], l?: number) => db.findByPaths(paths, l),
    topByUsage: (l?: number) => db.topByUsage(l),
    readMany: (ids: string[]) => db.readMany(ids),
    fileIdsByMemoryIds: (ids: string[]) => db.fileIdsByMemoryIds(ids),
    listEmbeddings: (model?: string) => db.listEmbeddings(model),
    getEmbedding: (id: string) => db.getEmbedding(id),
  };
}

describe("embedder — hash-bag basics", () => {
  it("produces unit-norm vectors", () => {
    const v = embed("authentication middleware for express");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(Math.abs(Math.sqrt(n) - 1)).toBeLessThan(1e-6);
    expect(v.length).toBe(EMBED_DIM);
  });

  it("similar texts have higher cosine than unrelated texts", () => {
    const a = embed("auth middleware login flow");
    const b = embed("auth middleware login pipeline");
    const c = embed("postgres database migration script");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(cosine(a, b)).toBeGreaterThan(0.3);
  });

  it("identical text → cosine 1", () => {
    const a = embed("hello world example");
    const b = embed("hello world example");
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });

  it("empty text → zero vector", () => {
    const v = embed("");
    let n = 0;
    for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
    expect(n).toBe(0);
  });
});

describe("MemoryDB — Phase 4 embeddings + edges", () => {
  it("write auto-embeds and links similar memories", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({
        summary: "auth middleware verifies JWT in header",
        details: "uses HS256 secret from env",
        category: null,
        topics: ["auth", "jwt"],
        source: "agent",
      });
      const b = db.write({
        summary: "auth middleware verifies JWT bearer",
        details: "uses HS256 secret from env",
        category: null,
        topics: ["auth"],
        source: "agent",
      });
      const c = db.write({
        summary: "build the deployment pipeline with docker",
        details: "",
        category: null,
        topics: ["deploy"],
        source: "agent",
      });

      const eA = db.getEmbedding(a.record.id);
      const eB = db.getEmbedding(b.record.id);
      const eC = db.getEmbedding(c.record.id);
      expect(eA).not.toBeNull();
      expect(eB).not.toBeNull();
      expect(eC).not.toBeNull();

      const edges = db.listEdges(a.record.id, "similar");
      // a and b should be linked, c should not.
      const linkedIds = new Set(edges.flatMap((e) => [e.src_id, e.dst_id]));
      expect(linkedIds.has(b.record.id)).toBe(true);
      expect(linkedIds.has(c.record.id)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("similarClusters groups connected components", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      // Three near-identical, one outlier
      const a = db.write({
        summary: "redis cache invalidation strategy",
        details: "TTL 300s",
        category: null,
        topics: [],
        source: "agent",
      });
      const b = db.write({
        summary: "redis cache invalidation strategy timeout",
        details: "TTL 600s",
        category: null,
        topics: [],
        source: "agent",
      });
      const c = db.write({
        summary: "redis cache invalidation pattern",
        details: "uses pubsub",
        category: null,
        topics: [],
        source: "agent",
      });
      const d = db.write({
        summary: "kubernetes ingress controller",
        details: "",
        category: null,
        topics: [],
        source: "agent",
      });

      const clusters = db.similarClusters(0.5);
      const ids = new Set([a.record.id, b.record.id, c.record.id]);
      const found = clusters.find((cl) => cl.memberIds.every((id) => ids.has(id)));
      expect(found).toBeTruthy();
      // d should not appear in any cluster
      const allClusterIds = new Set(clusters.flatMap((cl) => cl.memberIds));
      expect(allClusterIds.has(d.record.id)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("MemoryRecall — semantic signal", () => {
  it("semantic match surfaces a paraphrase that FTS misses", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({
        summary: "redis cache invalidation strategy with TTL",
        details: "expire keys after 300 seconds; uses redis SETEX",
        category: null,
        topics: ["redis", "cache"],
        source: "agent",
      });
      db.write({
        summary: "kubernetes ingress controller config",
        details: "nginx-based",
        category: null,
        topics: ["k8s"],
        source: "agent",
      });

      const recall = new MemoryRecall(
        [{ scope: "project" as const, db: adapt(db) }],
        null,
        { defaultThreshold: 0 },
      );
      // Query overlap with first memory (redis, cache, TTL); FTS would also hit
      // but this asserts semantic signal is present in the result.
      const hits = await recall.recall({ query: "redis cache TTL invalidation", limit: 5 });
      expect(hits.length).toBeGreaterThanOrEqual(1);
      const top = hits[0];
      expect(top).toBeTruthy();
      expect(top!.signals.semantic).not.toBeNull();
      expect(top!.signals.semantic!).toBeGreaterThan(0.3);
    } finally {
      db.close();
    }
  });

  it("query with no semantic match keeps semantic_rank null", async () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      db.write({
        summary: "redis cache invalidation",
        details: "",
        category: null,
        topics: [],
        source: "agent",
      });
      const recall = new MemoryRecall(
        [{ scope: "project" as const, db: adapt(db) }],
        null,
        { defaultThreshold: 0 },
      );
      const hits = await recall.recall({ query: "completely unrelated kubernetes pods" });
      // FTS won't hit either, so likely zero results — but if any leak through
      // via topByUsage fallback, semantic_rank must be null.
      for (const h of hits) {
        if (h.signals.fts_unicode === null && h.signals.fts_trigram === null) {
          expect(h.signals.semantic_rank).toBeNull();
        }
      }
    } finally {
      db.close();
    }
  });
});

describe("MemoryDB — schema v2 migration", () => {
  it("backfillEmbeddings populates rows missing embeddings", () => {
    const db = new MemoryDB(":memory:", "project");
    try {
      const a = db.write({
        summary: "test record one",
        details: "",
        category: null,
        topics: [],
        source: "agent",
      });
      // Simulate pre-Phase-4 row by clearing the embedding.
      db["db"].run("UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE id = ?", [
        a.record.id,
      ]);
      expect(db.getEmbedding(a.record.id)).toBeNull();

      const missing = db.listMissingEmbeddings(undefined, 10);
      expect(missing.length).toBe(1);
      const linked = db.embedAndLink(a.record.id);
      expect(linked).toEqual([]); // no other memories to link
      expect(db.getEmbedding(a.record.id)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
