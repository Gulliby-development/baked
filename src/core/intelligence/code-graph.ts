/**
 * Reads the code graph from the repository map database (`.baked/repomap.db`) for the desktop
 * Graph section and the terminal `/graph` view. The intelligence worker owns and writes the
 * database; this opens it read-only, so a scan in progress is never blocked and the graph shows
 * the last committed state. Grouping is in `code-graph-model.ts`.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildGraphModel,
  type GraphModel,
  type GraphSnapshot,
  type GraphSnapshotLink,
} from "./code-graph-model.js";

/** Languages the repository map indexes that are data or prose, not code. */
const NOT_CODE = new Set([
  "json",
  "jsonc",
  "markdown",
  "mdx",
  "yaml",
  "toml",
  "lockfile",
  "ignore",
  "svg",
  "text",
  "plaintext",
  "xml",
  "ini",
  "csv",
  "unknown",
]);

export function repoMapDbPath(workspace: string): string {
  return join(workspace, ".baked", "repomap.db");
}

function openReadOnly(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout = 2000");
    return db;
  } catch {
    return null;
  }
}

function hasTable(db: Database, name: string): boolean {
  return (
    db.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name)?.n === 1
  );
}

/** Reads the files and links of the index, or null when there is no index yet. */
export function readGraphSnapshot(workspace: string): GraphSnapshot | null {
  const db = openReadOnly(repoMapDbPath(workspace));
  if (!db) return null;
  try {
    if (!hasTable(db, "files") || !hasTable(db, "edges")) return null;
    const rows = db
      .query<
        { id: number; path: string; language: string; line_count: number; symbol_count: number; pagerank: number },
        []
      >("SELECT id, path, language, line_count, symbol_count, pagerank FROM files ORDER BY path")
      .all()
      .filter((r) => !NOT_CODE.has(r.language));
    if (rows.length === 0) return null;
    const index = new Map<number, number>();
    rows.forEach((r, i) => index.set(r.id, i));
    const exported = new Map<number, number>();
    for (const r of db
      .query<{ file_id: number; n: number }, []>(
        "SELECT file_id, count(*) AS n FROM symbols WHERE is_exported = 1 GROUP BY file_id",
      )
      .all())
      exported.set(r.file_id, r.n);
    const key = (a: number, b: number): string => `${a}>${b}`;
    const names = new Map<string, string[]>();
    if (hasTable(db, "refs"))
      for (const r of db
        .query<{ file_id: number; source_file_id: number; name: string }, []>(
          "SELECT file_id, source_file_id, name FROM refs WHERE source_file_id IS NOT NULL",
        )
        .all()) {
        const k = key(r.file_id, r.source_file_id);
        const list = names.get(k) ?? [];
        if (list.length < 3 && !list.includes(r.name)) list.push(r.name);
        names.set(k, list);
      }
    const calls = new Map<string, number>();
    if (hasTable(db, "calls"))
      for (const r of db
        .query<{ src: number; dst: number; n: number }, []>(
          `SELECT s.file_id AS src, c.callee_file_id AS dst, count(*) AS n
             FROM calls c JOIN symbols s ON s.id = c.caller_symbol_id
            WHERE c.callee_file_id IS NOT NULL GROUP BY s.file_id, c.callee_file_id`,
        )
        .all())
        calls.set(key(r.src, r.dst), r.n);
    const cochanges = new Map<string, number>();
    if (hasTable(db, "cochanges"))
      for (const r of db
        .query<{ a: number; b: number; n: number }, []>(
          "SELECT file_id_a AS a, file_id_b AS b, count AS n FROM cochanges",
        )
        .all()) {
        cochanges.set(key(r.a, r.b), r.n);
        cochanges.set(key(r.b, r.a), r.n);
      }
    const hasTypeFlag = db
      .query<{ name: string }, []>("PRAGMA table_info(edges)")
      .all()
      .some((c) => c.name === "is_type_edge");
    const links: GraphSnapshotLink[] = [];
    for (const e of db
      .query<{ s: number; t: number; w: number; ty: number }, []>(
        `SELECT source_file_id AS s, target_file_id AS t, weight AS w, ${hasTypeFlag ? "is_type_edge" : "0"} AS ty FROM edges`,
      )
      .all()) {
      const from = index.get(e.s);
      const to = index.get(e.t);
      if (from === undefined || to === undefined || from === to) continue;
      const k = key(e.s, e.t);
      links.push({
        from,
        to,
        weight: e.w,
        typeOnly: e.ty === 1,
        calls: calls.get(k) ?? 0,
        cochanges: cochanges.get(k) ?? 0,
        names: names.get(k) ?? [],
      });
    }
    return {
      files: rows.map((r) => ({
        path: r.path,
        lines: r.line_count,
        symbols: r.symbol_count,
        exported: exported.get(r.id) ?? 0,
        rank: r.pagerank,
      })),
      links,
    };
  } finally {
    db.close();
  }
}

export interface GraphLinkCall {
  caller: string;
  callee: string;
  line: number;
}

/** Why one file depends on another: everything the index knows about the pair. */
export interface GraphLinkExplanation {
  from: string;
  to: string;
  weight: number;
  typeOnly: boolean;
  /** Every name `from` imports from `to`. */
  names: string[];
  calls: number;
  /** Up to five call sites. */
  callSites: GraphLinkCall[];
  cochanges: number;
  /** There is a link in the other direction too. */
  mutual: boolean;
}

export function explainGraphLink(
  workspace: string,
  from: string,
  to: string,
): GraphLinkExplanation | null {
  const db = openReadOnly(repoMapDbPath(workspace));
  if (!db) return null;
  try {
    const id = (path: string): number | null =>
      db.query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?").get(path)?.id ??
      null;
    const a = id(from);
    const b = id(to);
    if (a === null || b === null) return null;
    const edge = (s: number, t: number) =>
      db
        .query<{ weight: number; ty: number }, [number, number]>(
          "SELECT weight, is_type_edge AS ty FROM edges WHERE source_file_id = ? AND target_file_id = ?",
        )
        .get(s, t);
    const e = edge(a, b);
    if (!e) return null;
    const names = db
      .query<{ name: string }, [number, number]>(
        "SELECT DISTINCT name FROM refs WHERE file_id = ? AND source_file_id = ? ORDER BY name",
      )
      .all(a, b)
      .map((r) => r.name);
    const sites = db
      .query<{ caller: string; callee: string; line: number }, [number, number]>(
        `SELECT s.name AS caller, c.callee_name AS callee, c.line AS line
           FROM calls c JOIN symbols s ON s.id = c.caller_symbol_id
          WHERE s.file_id = ? AND c.callee_file_id = ? ORDER BY c.line`,
      )
      .all(a, b);
    const co =
      db
        .query<{ n: number }, [number, number, number, number]>(
          "SELECT count AS n FROM cochanges WHERE (file_id_a = ? AND file_id_b = ?) OR (file_id_a = ? AND file_id_b = ?)",
        )
        .get(a, b, b, a)?.n ?? 0;
    return {
      from,
      to,
      weight: Math.round(e.weight * 10) / 10,
      typeOnly: e.ty === 1,
      names,
      calls: sites.length,
      callSites: sites.slice(0, 5),
      cochanges: co,
      mutual: Boolean(edge(b, a)),
    };
  } finally {
    db.close();
  }
}

/** External packages a file imports. */
export function graphFilePackages(workspace: string, path: string): string[] {
  const db = openReadOnly(repoMapDbPath(workspace));
  if (!db) return [];
  try {
    if (!hasTable(db, "external_imports")) return [];
    return db
      .query<{ package: string }, [string]>(
        `SELECT e.package AS package FROM external_imports e JOIN files f ON f.id = e.file_id
          WHERE f.path = ? ORDER BY e.package`,
      )
      .all(path)
      .map((r) => r.package);
  } finally {
    db.close();
  }
}

/**
 * Keeps the grouped graph of one workspace and rebuilds it when the index changes (the database
 * or its write-ahead log was written since the last read).
 */
export class CodeGraphCache {
  private model: GraphModel | null = null;
  private stamp = "";

  constructor(private readonly workspace: string) {}

  private currentStamp(): string {
    const path = repoMapDbPath(this.workspace);
    const parts: string[] = [];
    for (const p of [path, `${path}-wal`]) {
      try {
        const s = statSync(p);
        parts.push(`${s.size}:${s.mtimeMs}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  }

  /** The grouped graph, or null when the workspace has no index yet. */
  get(): GraphModel | null {
    const stamp = this.currentStamp();
    if (this.model && stamp === this.stamp) return this.model;
    const snapshot = readGraphSnapshot(this.workspace);
    this.stamp = stamp;
    this.model = snapshot ? buildGraphModel(snapshot, basename(this.workspace) || "project") : null;
    return this.model;
  }
}
