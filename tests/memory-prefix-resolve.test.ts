import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../src/core/memory/db.js";
import { MemoryManager } from "../src/core/memory/manager.js";

describe("MemoryDB.resolveId", () => {
  let db: MemoryDB;
  beforeEach(() => {
    db = new MemoryDB(":memory:", "project");
  });
  afterEach(() => {
    db.close();
  });

  it("returns the same id on full-match input", () => {
    const r = db.write({ summary: "x", details: "", category: null, source: "agent" });
    expect(db.resolveId(r.record.id)).toBe(r.record.id);
  });

  it("resolves an 8-char prefix to the unique full id", () => {
    const r = db.write({ summary: "x", details: "", category: null, source: "agent" });
    const prefix = r.record.id.slice(0, 8);
    expect(db.resolveId(prefix)).toBe(r.record.id);
  });

  it("returns null for empty string and for prefixes shorter than 4 chars", () => {
    db.write({ summary: "x", details: "", category: null, source: "agent" });
    expect(db.resolveId("")).toBeNull();
    expect(db.resolveId("ab")).toBeNull();
    expect(db.resolveId("abc")).toBeNull();
  });

  it("returns null when no row matches", () => {
    db.write({ summary: "x", details: "", category: null, source: "agent" });
    expect(db.resolveId("ffffffff")).toBeNull();
  });

  it("returns {ambiguous} when 2+ rows share the same prefix (forced via direct INSERT)", () => {
    // Force two rows that share the same 8-char prefix. UUIDs almost never
    // collide naturally; we simulate the contention via raw SQL.
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into raw db
    const raw = (db as any).db;
    const h1 = MemoryDB.computeContentHash("a", "");
    const h2 = MemoryDB.computeContentHash("b", "");
    raw.run(
      `INSERT INTO memories (id, summary, details, source, content_hash) VALUES ('abc12345-row-1','a','','agent',?)`,
      [h1],
    );
    raw.run(
      `INSERT INTO memories (id, summary, details, source, content_hash) VALUES ('abc12345-row-2','b','','agent',?)`,
      [h2],
    );
    const r = db.resolveId("abc12345");
    expect(typeof r).toBe("object");
    if (r && typeof r === "object" && "ambiguous" in r) {
      expect(r.ambiguous.sort()).toEqual(["abc12345-row-1", "abc12345-row-2"]);
    } else {
      throw new Error("expected ambiguous result");
    }
  });
});

describe("MemoryManager.resolveId", () => {
  let dir: string;
  let mgr: MemoryManager;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-prefix-"));
    mgr = new MemoryManager(dir, join(dir, "home"));
  });
  afterEach(() => {
    mgr.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a project-only prefix and tags scope", () => {
    const r = mgr.write("project", { summary: "p", details: "", category: null, source: "agent" });
    const found = mgr.resolveId("all", r.record.id.slice(0, 8));
    expect(found).not.toBeNull();
    if (found && "scope" in found) {
      expect(found.scope).toBe("project");
      expect(found.id).toBe(r.record.id);
    } else {
      throw new Error("expected scoped record");
    }
  });

  it("returns null for unknown prefix across all scopes", () => {
    expect(mgr.resolveId("all", "deadbeef")).toBeNull();
  });

  it("returns ambiguous when the same prefix exists in both scopes", () => {
    // Write the same row id into both scopes via direct DB access.
    const proj = mgr.getDbForScope("project");
    const glob = mgr.getDbForScope("global");
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into raw db
    const projRaw = (proj as any).db;
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into raw db
    const globRaw = (glob as any).db;
    const h1 = MemoryDB.computeContentHash("p", "");
    const h2 = MemoryDB.computeContentHash("g", "");
    projRaw.run(
      `INSERT INTO memories (id, summary, details, source, content_hash) VALUES ('shared12-proj','p','','agent',?)`,
      [h1],
    );
    globRaw.run(
      `INSERT INTO memories (id, summary, details, source, content_hash) VALUES ('shared12-glob','g','','agent',?)`,
      [h2],
    );
    const r = mgr.resolveId("all", "shared12");
    expect(r).not.toBeNull();
    if (r && "ambiguous" in r) {
      expect(r.ambiguous.length).toBe(2);
      expect(new Set(r.ambiguous.map((m) => m.scope))).toEqual(new Set(["project", "global"]));
    } else {
      throw new Error("expected ambiguous result");
    }
  });
});
