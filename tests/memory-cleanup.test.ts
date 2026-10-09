import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../src/core/memory/db.js";
import { MemoryManager } from "../src/core/memory/manager.js";

let db: MemoryDB;

beforeEach(() => {
  db = new MemoryDB(":memory:", "project");
});

afterEach(() => {
  db.close();
});

describe("MemoryDB — duplicates", () => {
  it("returns nothing when content_hash unique", () => {
    db.write({ summary: "a", details: "x", category: null, source: "agent" });
    db.write({ summary: "b", details: "y", category: null, source: "agent" });
    expect(db.findDuplicates()).toEqual([]);
  });
  // Note: content_hash UNIQUE constraint prevents real duplicates from being
  // written through write() — findDuplicates() targets legacy/imported data.
  // We exercise the query path with a single-group case via direct INSERTs.
  it("groups rows sharing a content_hash, picks pinned/most-recent as kept", () => {
    // Rebuild the memories table without the UNIQUE(content_hash) constraint
    // so we can simulate legacy/imported duplicate-content state. Triggers
    // and FTS are dropped too — findDuplicates only reads from `memories`.
    // biome-ignore lint/suspicious/noExplicitAny: direct DB handle for test setup
    const internal = (db as any).db;
    internal.run(`DROP TRIGGER IF EXISTS memories_ai`);
    internal.run(`DROP TRIGGER IF EXISTS memories_au`);
    internal.run(`DROP TRIGGER IF EXISTS memories_ad`);
    internal.run(`DROP TABLE memories`);
    internal.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        category TEXT,
        summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        topics TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        use_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT
      )
    `);
    const hash = MemoryDB.computeContentHash("shared", "body");
    internal.run(
      `INSERT INTO memories (id, summary, details, source, content_hash, last_used_at)
       VALUES ('dup-1', 'shared', 'body', 'agent', ?, datetime('now', '-2 days'))`,
      [hash],
    );
    internal.run(
      `INSERT INTO memories (id, summary, details, source, content_hash, last_used_at)
       VALUES ('dup-2', 'shared', 'body', 'agent', ?, datetime('now'))`,
      [hash],
    );
    const groups = db.findDuplicates();
    expect(groups.length).toBe(1);
    expect(groups[0].kept.id).toBe("dup-2"); // most recent
    expect(groups[0].dupes.map((d) => d.id)).toEqual(["dup-1"]);
  });
});

describe("MemoryDB — dead file refs", () => {
  it("flags memories whose every linked path is missing", () => {
    const a = db.write({ summary: "alive", details: "", category: null, source: "agent" });
    const b = db.write({ summary: "dead", details: "", category: null, source: "agent" });
    db.addFileRef(a.record.id, "src/alive.ts", null);
    db.addFileRef(b.record.id, "src/gone.ts", null);
    db.addFileRef(b.record.id, "src/also-gone.ts", null);
    const exists = (p: string) => p === "src/alive.ts";
    const dead = db.findDeadFileRefs(exists);
    expect(dead.length).toBe(1);
    expect(dead[0].record.id).toBe(b.record.id);
    expect(dead[0].deadPaths.sort()).toEqual(["src/also-gone.ts", "src/gone.ts"]);
  });

  it("excludes pinned memories", () => {
    const a = db.write({ summary: "pinned-dead", details: "", category: null, source: "agent" });
    db.addFileRef(a.record.id, "src/gone.ts", null);
    db.pin(a.record.id);
    expect(db.findDeadFileRefs(() => false).length).toBe(0);
  });

  it("excludes memories with no file refs (file-agnostic, not broken)", () => {
    db.write({ summary: "no-files", details: "", category: null, source: "agent" });
    expect(db.findDeadFileRefs(() => false).length).toBe(0);
  });
});

describe("MemoryDB — stale candidates", () => {
  it("orders oldest+least-used first, pinned excluded", () => {
    const fresh = db.write({ summary: "fresh", details: "", category: null, source: "agent" });
    const stale = db.write({ summary: "stale", details: "", category: null, source: "agent" });
    const pinned = db.write({
      summary: "pinned-stale",
      details: "",
      category: null,
      source: "agent",
    });
    db.pin(pinned.record.id);
    // biome-ignore lint/suspicious/noExplicitAny: direct mutate for age control
    (db as any).db.run(
      `UPDATE memories SET last_used_at = datetime('now', '-100 days') WHERE id = ?`,
      [stale.record.id],
    );
    const out = db.staleCandidates(10);
    const ids = out.map((o) => o.record.id);
    expect(ids).toContain(stale.record.id);
    expect(ids).toContain(fresh.record.id);
    expect(ids).not.toContain(pinned.record.id);
    expect(ids[0]).toBe(stale.record.id); // oldest first
    expect(out[0].ageDays).toBeGreaterThan(50);
  });
});

describe("MemoryDB — activeCount", () => {
  it("counts only non-hidden", () => {
    const a = db.write({ summary: "a", details: "", category: null, source: "agent" });
    const b = db.write({ summary: "b", details: "", category: null, source: "agent" });
    expect(db.activeCount()).toBe(2);
    db.softDelete(b.record.id);
    expect(db.activeCount()).toBe(1);
    db.restore(b.record.id);
    db.softDelete(a.record.id);
    expect(db.activeCount()).toBe(1);
  });
});

describe("MemoryManager — cleanup tracker", () => {
  let dir: string;
  let mgr: MemoryManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-mem-cleanup-"));
  });

  afterEach(() => {
    mgr?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts with null lastCleanupAt and zero sessions", () => {
    mgr = new MemoryManager(dir, join(dir, "global"));
    expect(mgr.cleanupTracker.lastCleanupAt).toBeNull();
    expect(mgr.cleanupTracker.sessionsSinceCleanup).toBe(0);
  });

  it("noteSessionStart increments and persists across reopen", () => {
    const globalDir = join(dir, "global");
    mgr = new MemoryManager(dir, globalDir);
    mgr.noteSessionStart();
    mgr.noteSessionStart();
    expect(mgr.cleanupTracker.sessionsSinceCleanup).toBe(2);
    mgr.close();

    const mgr2 = new MemoryManager(dir, globalDir);
    expect(mgr2.cleanupTracker.sessionsSinceCleanup).toBe(2);
    mgr2.close();
  });

  it("noteCleanupCompleted resets counter and stamps timestamp", () => {
    mgr = new MemoryManager(dir, join(dir, "global"));
    mgr.noteSessionStart();
    mgr.noteSessionStart();
    mgr.noteCleanupCompleted();
    expect(mgr.cleanupTracker.sessionsSinceCleanup).toBe(0);
    expect(mgr.cleanupTracker.lastCleanupAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("cleanupHint returns null below thresholds", () => {
    mgr = new MemoryManager(dir, join(dir, "global"));
    expect(mgr.cleanupHint()).toBeNull(); // no memories, no sessions
    for (let i = 0; i < 25; i++) mgr.noteSessionStart();
    expect(mgr.cleanupHint()).toBeNull(); // sessions ok but <30 memories
  });

  it("cleanupHint fires when sessions ≥20 AND memories ≥30 AND stale ≥10", () => {
    mgr = new MemoryManager(dir, join(dir, "global"));
    for (let i = 0; i < 35; i++) {
      mgr.write("project", {
        summary: `entry ${String(i)}`,
        details: `body ${String(i)}`,
        category: null,
        source: "agent",
      });
    }
    // Force 15 of them stale
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into DB to age rows
    const proj = (mgr as any).getDbForScope("project");
    // biome-ignore lint/suspicious/noExplicitAny: direct internal handle
    proj.db.run(
      `UPDATE memories SET last_used_at = datetime('now', '-90 days') WHERE rowid IN (SELECT rowid FROM memories LIMIT 15)`,
    );
    for (let i = 0; i < 25; i++) mgr.noteSessionStart();
    const hint = mgr.cleanupHint();
    expect(hint).not.toBeNull();
    if (hint) {
      expect(hint.total).toBeGreaterThanOrEqual(30);
      expect(hint.stale).toBeGreaterThanOrEqual(10);
      expect(hint.sessions).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("MemoryManager — cleanup APIs", () => {
  let dir: string;
  let mgr: MemoryManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-mem-cleanup-api-"));
    mgr = new MemoryManager(dir, join(dir, "global"));
  });

  afterEach(() => {
    mgr?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("findDeadFileRefs aggregates across project + global scopes", () => {
    const proj = mgr.write("project", {
      summary: "p-dead",
      details: "",
      category: null,
      source: "agent",
    });
    const glob = mgr.write("global", {
      summary: "g-dead",
      details: "",
      category: null,
      source: "agent",
    });
    mgr.addFileRef("project", proj.record.id, "missing-p.ts", null);
    mgr.addFileRef("global", glob.record.id, "missing-g.ts", null);

    const exists = (p: string) => false;
    void writeFileSync; // silence import
    const out = mgr.findDeadFileRefs("all", exists);
    expect(out.length).toBe(2);
    expect(new Set(out.map((o) => o.scope))).toEqual(new Set(["project", "global"]));
  });

  it("staleCandidates merges and re-sorts across scopes", () => {
    mgr.write("project", {
      summary: "p-stale-test-unique",
      details: "x",
      category: null,
      source: "agent",
    });
    mgr.write("global", {
      summary: "g-stale-test-unique",
      details: "x",
      category: null,
      source: "agent",
    });
    const out = mgr.staleCandidates("all", 50);
    const ours = out.filter((o) => o.record.summary.endsWith("-stale-test-unique"));
    expect(ours.length).toBe(2);
    expect(new Set(ours.map((o) => o.scope))).toEqual(new Set(["project", "global"]));
  });
});
