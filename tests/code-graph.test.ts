import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { graphOverviewLines } from "../src/core/commands/graph.js";
import type { ContextManager } from "../src/core/context/manager.js";
import { SharedRootContext } from "../src/core/context/shared-root.js";
import {
  CodeGraphCache,
  explainGraphLink,
  readGraphSnapshot,
  repoMapDbPath,
} from "../src/core/intelligence/code-graph.js";
import {
  buildGraphModel,
  FLAT_LIMIT,
  type GraphSnapshot,
  type GraphView,
  graphFileDetail,
  graphOverview,
  graphView,
  searchGraphFiles,
  TEST_TONE,
  TOP_BUDGET,
} from "../src/core/intelligence/code-graph-model.js";
import { getThemeTokens } from "../src/core/theme/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A deterministic project: `dirs` folders under src/ with `per` files each, tests and links. */
function project(dirs: number, per: number): GraphSnapshot {
  const files: GraphSnapshot["files"] = [];
  for (let d = 0; d < dirs; d++)
    for (let f = 0; f < per; f++)
      files.push({
        path: `src/area${d}/part${f % 3}/file${f}.ts`,
        lines: f === 0 ? 900 : 20 + ((d * 31 + f * 17) % 200),
        symbols: 3,
        exported: 2,
        rank: 0,
      });
  for (let t = 0; t < 6; t++)
    files.push({ path: `tests/t${t}.test.ts`, lines: 80, symbols: 1, exported: 0, rank: 0 });
  const links: GraphSnapshot["links"] = [];
  files.forEach((_, i) => {
    if (i === 0) return;
    // Everything leans on the first file of area0; neighbours link too.
    links.push({ from: i, to: 0, weight: 3, typeOnly: false, calls: 1, cochanges: 0, names: ["core"] });
    if (i > 1) links.push({ from: i, to: i - 1, weight: 1, typeOnly: i % 5 === 0, calls: 0, cochanges: 1, names: [] });
  });
  const indegree = files.map((_, i) => links.filter((l) => l.to === i).reduce((s, l) => s + l.weight, 0));
  const total = indegree.reduce((a, b) => a + b, 0);
  files.forEach((f, i) => {
    f.rank = (indegree[i] ?? 0) / total;
  });
  return { files, links };
}

function visibleIds(view: GraphView): Set<string> {
  return new Set(view.units.map((u) => u.id));
}

describe("code graph grouping", () => {
  test("a small project is drawn flat, every file a block", () => {
    const model = buildGraphModel(project(2, 4), "tiny");
    const view = graphView(model);
    expect(model.flat).toBe(true);
    expect(view.flat).toBe(true);
    expect(view.units).toHaveLength(14);
    expect(view.units.every((u) => u.kind === "file")).toBe(true);
    expect(view.stats.files).toBeLessThanOrEqual(FLAT_LIMIT);
  });

  test("a larger project starts with a few groups and key files", () => {
    const model = buildGraphModel(project(12, 30), "medium");
    const view = graphView(model);
    expect(view.flat).toBe(false);
    expect(view.units.length).toBeLessThanOrEqual(TOP_BUDGET + 8);
    expect(view.units.some((u) => u.kind === "dir")).toBe(true);
    // The most depended-on file stays on top as a key file.
    expect(view.hubs[0]?.path).toBe("src/area0/part0/file0.ts");
    const key = view.units.find((u) => u.path === "src/area0/part0/file0.ts");
    expect(key?.key).toBe(true);
    // Tests get their own tone.
    expect(view.units.find((u) => u.label.startsWith("tests"))?.tone).toBe(TEST_TONE);
    // Links only join blocks that are on screen, never a block to itself.
    const ids = visibleIds(view);
    for (const e of view.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
      expect(e.top.length).toBeGreaterThan(0);
    }
    expect(view.stats).toEqual({ files: 366, lines: model.stats.lines, symbols: model.stats.symbols, links: model.stats.links, calls: model.stats.calls });
  });

  test("opening a folder shows its children inside a frame", () => {
    const model = buildGraphModel(project(12, 30), "medium");
    const top = graphView(model);
    const dir = top.units.find((u) => u.kind === "dir" && !u.test);
    if (!dir) throw new Error("no folder on top");
    const open = graphView(model, { expanded: [dir.id] });
    expect(open.expanded).toEqual([dir.id]);
    const frame = open.frames.find((f) => f.id === dir.id);
    expect(frame).toMatchObject({ depth: 0, files: dir.files, lines: dir.lines });
    expect(visibleIds(open).has(dir.id)).toBe(false);
    const inside = open.units.filter((u) => u.owner === dir.id);
    expect(inside.length).toBeGreaterThan(1);
    expect(inside.reduce((s, u) => s + u.files, 0)).toBe(dir.files);
  });

  test("reveal opens the folders around a file", () => {
    const model = buildGraphModel(project(12, 30), "medium");
    const path = "src/area7/part2/file29.ts";
    const view = graphView(model, { reveal: path });
    expect(view.revealed).toBe(`f:${path}`);
    expect(view.units.some((u) => u.id === `f:${path}`)).toBe(true);
    expect(view.expanded.length).toBeGreaterThan(0);
  });

  test("tests and type-only links can be hidden", () => {
    const model = buildGraphModel(project(12, 30), "medium");
    const noTests = graphView(model, { tests: false });
    expect(noTests.units.some((u) => u.test)).toBe(false);
    const all = graphView(model).edges.reduce((s, e) => s + e.pairs, 0);
    const noTypes = graphView(model, { typeEdges: false }).edges.reduce((s, e) => s + e.pairs, 0);
    expect(noTypes).toBeLessThan(all);
  });

  test("search, file detail and the terminal overview", () => {
    const model = buildGraphModel(project(12, 30), "medium");
    expect(searchGraphFiles(model, "area3/part1")[0]).toStartWith("src/area3/part1/");
    expect(searchGraphFiles(model, "a")).toEqual([]);
    const detail = graphFileDetail(model, "src/area0/part0/file0.ts");
    expect(detail?.usedBy.length).toBeGreaterThan(0);
    expect(graphFileDetail(model, "missing.ts")).toBeNull();
    const overview = graphOverview(model, 5);
    expect(overview.keyFiles[0]?.path).toBe("src/area0/part0/file0.ts");
    expect(overview.keyFiles).toHaveLength(5);
    const lines = graphOverviewLines(overview, getThemeTokens(), 4);
    expect(lines.filter((l) => l.type === "bar")).toHaveLength(4);
    expect(lines.some((l) => l.type === "entry" && l.label === "★ src/area0/part0/file0.ts")).toBe(true);
  });

  test("a very large project stays within the block budget", () => {
    const model = buildGraphModel(project(60, 120), "huge");
    const view = graphView(model);
    expect(view.stats.files).toBe(7206);
    expect(view.units.length).toBeLessThanOrEqual(TOP_BUDGET + 8);
    const dir = view.units.find((u) => u.kind === "dir" && !u.test);
    if (!dir) throw new Error("no folder on top");
    const open = graphView(model, { expanded: [dir.id] });
    expect(open.units.filter((u) => u.owner === dir.id).length).toBeLessThanOrEqual(TOP_BUDGET + 8);
  });
});

/** Writes a repository map database with the tables the reader uses. */
function writeRepoMap(workspace: string): void {
  mkdirSync(join(workspace, ".baked"), { recursive: true });
  const db = new Database(repoMapDbPath(workspace));
  db.run(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, mtime_ms REAL, language TEXT, line_count INTEGER, symbol_count INTEGER, pagerank REAL);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, kind TEXT, line INTEGER, end_line INTEGER, is_exported INTEGER);
    CREATE TABLE edges (source_file_id INTEGER, target_file_id INTEGER, weight REAL, is_type_edge INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE refs (file_id INTEGER, name TEXT, source_file_id INTEGER, import_source TEXT);
    CREATE TABLE calls (caller_symbol_id INTEGER, callee_name TEXT, callee_symbol_id INTEGER, callee_file_id INTEGER, line INTEGER);
    CREATE TABLE cochanges (file_id_a INTEGER, file_id_b INTEGER, count INTEGER);
    CREATE TABLE external_imports (file_id INTEGER, package TEXT, specifiers TEXT);
    INSERT INTO files VALUES
      (1, 'src/cli.ts', 0, 'typescript', 120, 4, 0.2),
      (2, 'src/parse.ts', 0, 'typescript', 240, 9, 0.5),
      (3, 'src/types.ts', 0, 'typescript', 60, 6, 0.3),
      (4, 'README.md', 0, 'markdown', 40, 0, 0.0);
    INSERT INTO symbols VALUES
      (1, 1, 'main', 'function', 3, 20, 1),
      (2, 2, 'parse', 'function', 1, 40, 1),
      (3, 2, 'Token', 'interface', 41, 50, 1),
      (4, 3, 'Options', 'interface', 1, 9, 1);
    INSERT INTO edges VALUES (1, 2, 4.5, 0), (2, 3, 2, 1), (1, 3, 1, 1), (1, 4, 1, 0);
    INSERT INTO refs VALUES (1, 'parse', 2, './parse'), (1, 'Token', 2, './parse'), (2, 'Options', 3, './types');
    INSERT INTO calls VALUES (1, 'parse', 2, 2, 12), (1, 'parse', 2, 2, 18);
    INSERT INTO cochanges VALUES (1, 2, 5);
    INSERT INTO external_imports VALUES (1, 'commander', 'Command');
  `);
  db.close();
}

describe("reading the repository map", () => {
  test("reads code files, links and their reasons read-only", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-graph-"));
    cleanups.push(() => removeTempDir(workspace));
    expect(readGraphSnapshot(workspace)).toBeNull();
    writeRepoMap(workspace);
    const snapshot = readGraphSnapshot(workspace);
    expect(snapshot?.files.map((f) => f.path)).toEqual(["src/cli.ts", "src/parse.ts", "src/types.ts"]);
    const cliToParse = snapshot?.links.find((l) => l.from === 0 && l.to === 1);
    expect(cliToParse).toEqual({ from: 0, to: 1, weight: 4.5, typeOnly: false, calls: 2, cochanges: 5, names: ["parse", "Token"] });
    expect(snapshot?.files[1]?.exported).toBe(2);
    expect(explainGraphLink(workspace, "src/cli.ts", "src/parse.ts")).toEqual({
      from: "src/cli.ts",
      to: "src/parse.ts",
      weight: 4.5,
      typeOnly: false,
      names: ["Token", "parse"],
      calls: 2,
      callSites: [
        { caller: "main", callee: "parse", line: 12 },
        { caller: "main", callee: "parse", line: 18 },
      ],
      cochanges: 5,
      mutual: false,
    });
    expect(explainGraphLink(workspace, "src/parse.ts", "src/cli.ts")).toBeNull();
    const cache = new CodeGraphCache(workspace);
    const first = cache.get();
    expect(first?.files).toHaveLength(3);
    expect(cache.get()).toBe(first);
  });
});

describe("code graph over the local API", () => {
  test("answers views, files, links and search once the index exists", async () => {
    // Other test files turn the repository map off for the whole process.
    const noRepoMap = process.env.BAKED_NO_REPOMAP;
    delete process.env.BAKED_NO_REPOMAP;
    cleanups.push(async () => {
      if (noRepoMap !== undefined) process.env.BAKED_NO_REPOMAP = noRepoMap;
    });
    const fixture = workflowFixture();
    let ready = false;
    const fake = {
      isRepoMapReady: () => ready,
      isRepoMapScanning: () => false,
      dispose: async () => {},
    } as unknown as ContextManager;
    Object.defineProperty(fixture.service, "rootContext", { value: new SharedRootContext(async () => fake) });
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" } });
    const view = async (body: unknown) => (await call("/v1/graph", { method: "POST", body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("code-graph");
    expect((await view({})).state).toBe("indexing");
    // The root starts in the background; once it reports ready and there is still no index the project is empty.
    await fixture.service.rootContext.get();
    ready = true;
    expect(await view({})).toEqual({ state: "empty", indexing: false });

    writeRepoMap(fixture.root);
    const answer = (await view({ tests: false })) as { state: string; view: GraphView };
    expect(answer.state).toBe("ready");
    expect(answer.view.flat).toBe(true);
    expect(answer.view.units.map((u) => u.path).sort()).toEqual(["src/cli.ts", "src/parse.ts", "src/types.ts"]);

    const file = (await (await call("/v1/graph/file?path=src/cli.ts")).json()) as { packages: string[]; imports: unknown[] };
    expect(file.packages).toEqual(["commander"]);
    expect(file.imports.length).toBe(2);
    expect((await call("/v1/graph/file?path=nope.ts")).status).toBe(404);
    const link = (await (await call("/v1/graph/link?from=src/cli.ts&to=src/parse.ts")).json()) as { calls: number };
    expect(link.calls).toBe(2);
    expect((await call("/v1/graph/link?from=src/types.ts&to=src/cli.ts")).status).toBe(404);
    expect(await (await call("/v1/graph/search?q=pars")).json()).toEqual({ paths: ["src/parse.ts"] });
    expect((await call("/v1/graph", { method: "POST", body: JSON.stringify({ bogus: 1 }) })).status).toBe(400);
    expect((await call("/v1/graph")).status).toBe(405);
  });

  test("baked serve opens the index in the background and reports its updates", async () => {
    const noRepoMap = process.env.BAKED_NO_REPOMAP;
    delete process.env.BAKED_NO_REPOMAP;
    cleanups.push(async () => {
      if (noRepoMap !== undefined) process.env.BAKED_NO_REPOMAP = noRepoMap;
    });
    const fixture = workflowFixture();
    let opened = 0;
    let scanning = false;
    const fake = {
      isRepoMapReady: () => true,
      isRepoMapScanning: () => scanning,
      updateRepoMapInBackground: async () => {},
      dispose: async () => {},
    } as unknown as ContextManager;
    Object.defineProperty(fixture.service, "rootContext", {
      value: new SharedRootContext(async () => {
        opened++;
        return fake;
      }),
    });
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    const server = await startApiServer({
      service: fixture.service,
      pollMs: 20,
      configDir,
      homeDir,
      log: () => {},
      backgroundIndex: true,
      backgroundIndexDelayMs: 10,
    });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    for (let i = 0; i < 100 && opened === 0; i++) await Bun.sleep(10);
    expect(opened).toBe(1);

    writeRepoMap(fixture.root);
    const view = async () =>
      (await (
        await fetch(`${server.url}/v1/graph`, {
          method: "POST",
          body: "{}",
          headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        })
      ).json()) as { state: string; indexing: boolean };
    expect(await view()).toMatchObject({ state: "ready", indexing: false });
    // A background update keeps the last graph and only flags it.
    scanning = true;
    expect(await view()).toMatchObject({ state: "ready", indexing: true });
  });
});
