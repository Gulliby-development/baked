import type {
  GraphModel,
  GraphSnapshot,
  GraphSnapshotLink,
} from "../../../../../src/core/intelligence/code-graph-model.js";
import type { ApiResponse } from "../../shared/api.js";
import type { GraphLinkAnswer, GraphRequest } from "./graph.js";
import { type MockRequest, response } from "./mock-response.js";

/**
 * The code graph in the preview bridge. It runs the core grouping on sample data: the BAKED
 * project uses a snapshot of this repository's own index, `docs` a nine-file project (shown flat)
 * and `site` a generated monorepo of about 34,000 files. Both the sample and the grouping code
 * load on first use so they stay out of the main bundle.
 */

type SampleFile = [string, number, number, number, number];
type SampleLink = [number, number, number, number, number, number, string];

async function bakedSample(): Promise<GraphSnapshot> {
  const raw = (await import("./graph-sample.json")).default as unknown as {
    files: SampleFile[];
    links: SampleLink[];
  };
  return {
    files: raw.files.map(([path, lines, symbols, exported, rank]) => ({
      path,
      lines,
      symbols,
      exported,
      rank: rank / 1e5,
    })),
    links: raw.links.map(([from, to, weight, typeOnly, calls, cochanges, names]) => ({
      from,
      to,
      weight,
      typeOnly: typeOnly === 1,
      calls,
      cochanges,
      names: names ? names.split(",") : [],
    })),
  };
}

function tinySample(): GraphSnapshot {
  const file = (path: string, lines: number, symbols: number, rank: number) => ({
    path,
    lines,
    symbols,
    exported: Math.max(0, symbols - 2),
    rank,
  });
  const files = [
    file("src/index.ts", 42, 3, 0.09),
    file("src/cli.ts", 118, 6, 0.14),
    file("src/parse.ts", 236, 11, 0.41),
    file("src/describe.ts", 184, 9, 0.33),
    file("src/fields.ts", 96, 7, 0.52),
    file("src/errors.ts", 24, 2, 0.38),
    file("src/format.ts", 61, 4, 0.21),
    file("tests/parse.test.ts", 142, 1, 0.04),
    file("tests/describe.test.ts", 128, 1, 0.04),
  ];
  const link = (
    from: number,
    to: number,
    weight: number,
    names: string[],
    calls: number,
    cochanges: number,
    typeOnly = false,
  ): GraphSnapshotLink => ({ from, to, weight, names, calls, cochanges, typeOnly });
  return {
    files,
    links: [
      link(0, 1, 4, ["runCli"], 1, 3),
      link(1, 2, 9, ["parseCron", "CronExpr"], 2, 5),
      link(1, 3, 8, ["describe"], 1, 4),
      link(1, 6, 3, ["bold", "dim"], 4, 1),
      link(2, 4, 12, ["FIELDS", "FieldSpec", "rangeFor"], 5, 6),
      link(2, 5, 5, ["CronSyntaxError"], 6, 2),
      link(3, 4, 7, ["FIELDS", "monthName", "dayName"], 3, 4),
      link(3, 2, 4, ["CronExpr"], 0, 3, true),
      link(3, 6, 2, ["plural"], 2, 0),
      link(7, 2, 6, ["parseCron"], 18, 4),
      link(7, 5, 2, ["CronSyntaxError"], 3, 1),
      link(8, 3, 6, ["describe"], 15, 3),
      link(8, 2, 3, ["parseCron"], 15, 2),
    ],
  };
}

function hugeSample(): GraphSnapshot {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)] as T;
  const words =
    "auth billing search ledger orders catalog notify media geo pricing inventory checkout identity reports audit sync export import chat feeds ranking payments shipping tax crm support flags metrics ingest routing sessions webhooks scheduler storage cache queue i18n forms maps assets".split(
      " ",
    );
  const subs =
    "api domain infra handlers models utils hooks components store adapters jobs schemas views services lib mappers validators fixtures".split(
      " ",
    );
  const stems =
    "index client types config service handler model repo mapper schema util helpers constants errors factory provider context store view form list table card dialog hook query mutation events worker parser format guard policy cache router middleware".split(
      " ",
    );
  const files: GraphSnapshot["files"] = [];
  const pkgOf: number[] = [];
  const shared: number[] = [];
  let pkg = 0;
  for (const [root, count, scale] of [
    ["packages", 34, 1],
    ["services", 24, 1.4],
    ["apps", 8, 3.2],
    ["tools", 6, 0.5],
    ["infra", 4, 0.5],
  ] as const) {
    const used = new Set<string>();
    for (let p = 0; p < count; p++) {
      let name = pick(words);
      while (used.has(name))
        name = `${pick(words)}-${pick(["core", "kit", "web", "admin", "edge", "v2"])}`;
      used.add(name);
      const nSubs = root === "infra" ? 3 : 4 + Math.floor(rnd() * 9);
      for (let s = 0; s < nSubs; s++) {
        const sub = `${subs[(s * 7 + p) % subs.length]}${s >= subs.length ? s : ""}`;
        const n = Math.floor((8 + rnd() * 70) * scale);
        for (let f = 0; f < n; f++) {
          const big = rnd() < 0.06;
          const lines = Math.round(big ? 600 + rnd() * 2400 : 12 + rnd() ** 2.2 * 380);
          files.push({
            path: `${root}/${name}/src/${sub}/${pick(stems)}-${f}.ts`,
            lines,
            symbols: Math.max(1, Math.round(lines / 28)),
            exported: Math.round(lines / 60),
            rank: 0,
          });
          pkgOf.push(pkg);
          if (root === "packages" && p < 6 && big) shared.push(files.length - 1);
        }
      }
      pkg++;
    }
  }
  const byPkg = new Map<number, number[]>();
  pkgOf.forEach((p, i) => {
    const list = byPkg.get(p) ?? [];
    list.push(i);
    byPkg.set(p, list);
  });
  const idents =
    "createClient Result parseInput toDto useQuery logger Config assertNever withRetry Money UserId emit track formatDate schema Paginated".split(
      " ",
    );
  const indegree = new Float64Array(files.length);
  const links: GraphSnapshotLink[] = [];
  for (let i = 0; i < files.length; i++) {
    const own = byPkg.get(pkgOf[i] ?? 0) ?? [i];
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const r = rnd();
      const to = r < 0.68 ? pick(own) : r < 0.93 ? pick(shared) : Math.floor(rnd() * files.length);
      if (to === i) continue;
      const weight = Math.round((1 + rnd() * 9) * 10) / 10;
      const a = pick(idents);
      const b = pick(idents);
      links.push({
        from: i,
        to,
        weight,
        typeOnly: rnd() < 0.12,
        calls: Math.floor(rnd() * 6),
        cochanges: rnd() < 0.08 ? 1 + Math.floor(rnd() * 6) : 0,
        names: a === b ? [a] : [a, b],
      });
      indegree[to] = (indegree[to] ?? 0) + weight;
    }
  }
  let total = 0;
  for (const v of indegree) total += v;
  files.forEach((f, i) => {
    f.rank = (indegree[i] ?? 0) / total;
  });
  return { files, links };
}

type Core = typeof import("../../../../../src/core/intelligence/code-graph-model.js");
let core: Promise<Core> | null = null;

function loadCore(): Promise<Core> {
  core ??= import("../../../../../src/core/intelligence/code-graph-model.js");
  return core;
}
const models = new Map<string, Promise<GraphModel>>();

function modelFor(key: string): Promise<GraphModel> {
  let found = models.get(key);
  if (!found) {
    found = loadCore().then(async (c) => {
      const snapshot =
        key === "baked" ? await bakedSample() : key === "docs" ? tinySample() : hugeSample();
      return c.buildGraphModel(snapshot, key === "baked" ? "BAKED" : key);
    });
    models.set(key, found);
  }
  return found;
}

function explain(model: GraphModel, from: string, to: string): GraphLinkAnswer | null {
  const a = model.byPath.get(from)?.index;
  const b = model.byPath.get(to)?.index;
  const l = model.snapshot.links.find((x) => x.from === a && x.to === b);
  if (!l) return null;
  return {
    from,
    to,
    weight: l.weight,
    typeOnly: l.typeOnly,
    names: l.names,
    calls: l.calls,
    callSites: l.names
      .slice(0, Math.min(l.calls, 3))
      .map((name, i) => ({ caller: "run", callee: name, line: 40 + i * 37 })),
    cochanges: l.cochanges,
    mutual: model.snapshot.links.some((x) => x.from === b && x.to === a),
  };
}

/** The "site" sample indexes for a while after its graph is first asked for, file by file. */
const INDEXING_KEY = "site";
const INDEX_FILES = 1380;
const INDEX_MS = 15_000;
let indexStartedAt: number | null = null;

/** The first seconds open the project (no count), then files are counted. */
const OPEN_MS = 3000;

function indexedFiles(key: string): number | null {
  if (key !== INDEXING_KEY || indexStartedAt === null) return null;
  const done = Math.floor(((Date.now() - indexStartedAt - OPEN_MS) / INDEX_MS) * INDEX_FILES);
  return done < INDEX_FILES ? Math.max(done, -1) : null;
}

/** `GET /v1/progress`: the sample project's indexing while it runs. */
export function progressRoutes({ key, method, path }: MockRequest): ApiResponse | undefined {
  if (method !== "GET" || path !== "/v1/progress") return undefined;
  const done = indexedFiles(key);
  const startedAt = new Date(indexStartedAt ?? Date.now()).toISOString();
  if (done === null) return response(200, { items: [] });
  if (done < 0)
    return response(200, {
      items: [
        {
          id: "open",
          task: "open",
          label: "Opening the project: mapping the codebase",
          done: null,
          total: null,
          startedAt,
        },
      ],
    });
  return response(200, {
    items: [
      { id: "index", task: "index", label: "Indexing files", done, total: INDEX_FILES, startedAt },
    ],
  });
}

export async function graphRoutes({
  key,
  method,
  path,
  query,
  body,
}: MockRequest): Promise<ApiResponse | undefined> {
  if (!path.startsWith("/v1/graph")) return undefined;
  // Only the browser preview plays the wait; unit tests read the ready sample.
  if (key === INDEXING_KEY && indexStartedAt === null && typeof window !== "undefined")
    indexStartedAt = Date.now();
  if (method === "POST" && path === "/v1/graph" && indexedFiles(key) !== null)
    return response(200, { state: "indexing", indexing: true });
  const c = await loadCore();
  const model = await modelFor(key);
  if (method === "POST" && path === "/v1/graph")
    return response(200, {
      state: "ready",
      indexing: false,
      view: c.graphView(model, body as GraphRequest),
    });
  if (method === "GET" && path === "/v1/graph/file") {
    const detail = c.graphFileDetail(model, query.get("path") ?? "");
    if (!detail) return response(404, { error: { code: "NOT_FOUND", message: "No such file" } });
    return response(200, { ...detail, packages: detail.path.endsWith(".tsx") ? ["react"] : [] });
  }
  if (method === "GET" && path === "/v1/graph/link") {
    const link = explain(model, query.get("from") ?? "", query.get("to") ?? "");
    if (!link) return response(404, { error: { code: "NOT_FOUND", message: "No such link" } });
    return response(200, link);
  }
  if (method === "GET" && path === "/v1/graph/search")
    return response(200, { paths: c.searchGraphFiles(model, query.get("q") ?? "") });
  return undefined;
}
