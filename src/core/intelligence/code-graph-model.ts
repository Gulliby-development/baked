/**
 * The grouped code graph that the desktop Graph section and the terminal `/graph` view draw.
 *
 * Input is a snapshot of the repository map (files with their size and PageRank, and the file to
 * file import links). Showing every file of a large project at once is unreadable, so the graph
 * is shown in levels: the top level holds about sixteen blocks (big folders, the most depended-on
 * files as hubs, and piles of small files), and each folder a person opens shows its own children
 * the same way. Links are summed between whatever blocks are visible, so opening a folder splits
 * its links among its children.
 *
 * This module is pure (no I/O): `code-graph.ts` reads the snapshot from the index database, and
 * the desktop app's preview bridge runs the same code on sample data.
 */

export interface GraphSnapshotFile {
  path: string;
  lines: number;
  symbols: number;
  exported: number;
  /** PageRank from the repository map; larger means more depended on. */
  rank: number;
}

export interface GraphSnapshotLink {
  /** Index into `files` of the importing file. */
  from: number;
  /** Index into `files` of the imported file. */
  to: number;
  weight: number;
  /** The target is mostly type declarations; ranking counts the link at 30%. */
  typeOnly: boolean;
  calls: number;
  cochanges: number;
  /** The first few imported names. */
  names: string[];
}

export interface GraphSnapshot {
  files: GraphSnapshotFile[];
  links: GraphSnapshotLink[];
}

export type GraphUnitKind = "dir" | "file" | "pile" | "dirpile";

/** Colour groups: 0-2 are the top-level folders in size order (repeating), 3 is tests. */
export const TEST_TONE = 3;

export interface GraphInsideFile {
  path: string;
  lines: number;
}

/** One block on the canvas: a folder, a file, or a pile of small files or folders. */
export interface GraphUnit {
  /** `d:<dir>`, `f:<file>`, or the owner's id plus `#files` / `#dirs` for a pile. */
  id: string;
  kind: GraphUnitKind;
  label: string;
  path: string;
  /** The open folder or pile this block sits in; null at the top level. */
  owner: string | null;
  lines: number;
  files: number;
  /** Files among the most depended-on 3% of the project. */
  keys: number;
  tone: number;
  key: boolean;
  test: boolean;
  symbols: number;
  /** A file's place by PageRank (1 = most depended on); 0 for groups. */
  rank: number;
  /** The most depended-on files inside a group, for the inspector. */
  inside: GraphInsideFile[];
}

/** An open folder or pile, drawn as a frame around its children. */
export interface GraphFrame {
  id: string;
  kind: GraphUnitKind;
  label: string;
  path: string;
  owner: string | null;
  depth: number;
  lines: number;
  files: number;
  keys: number;
  /** The biggest key files inside, as on the closed block. */
  inside: GraphInsideFile[];
}

export interface GraphLinkPair {
  from: string;
  to: string;
  weight: number;
  names: string[];
  typeOnly: boolean;
  calls: number;
  cochanges: number;
}

/** The links from one visible block to another, summed. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** File pairs behind this edge. */
  pairs: number;
  weight: number;
  /** Pairs whose target is mostly types. */
  typeOnly: number;
  calls: number;
  cochanges: number;
  /** There is an edge in the other direction too. */
  mutual: boolean;
  /** The strongest file pairs, at most eight. */
  top: GraphLinkPair[];
}

export interface GraphToneLabel {
  tone: number;
  label: string;
}

export interface GraphViewOptions {
  /** Ids of the folders and piles that are open. */
  expanded?: readonly string[];
  /** Show test files (default true). */
  tests?: boolean;
  /** Count links into type-heavy files (default true). */
  typeEdges?: boolean;
  /** A file path to make visible by opening the folders and piles around it. */
  reveal?: string;
}

export interface GraphStats {
  files: number;
  lines: number;
  symbols: number;
  links: number;
  calls: number;
}

export interface GraphView {
  /** Small project: every file is a block and nothing is grouped. */
  flat: boolean;
  /** The open folders after `reveal`, in a stable order. */
  expanded: string[];
  /** The unit id of the revealed file, when `reveal` found it. */
  revealed: string | null;
  units: GraphUnit[];
  frames: GraphFrame[];
  edges: GraphEdge[];
  tones: GraphToneLabel[];
  stats: GraphStats;
  /** The most depended-on files of the project. */
  hubs: { path: string; lines: number; rank: number }[];
}

export const TOP_BUDGET = 16;
export const CHILD_BUDGET = 13;
/** Projects with at most this many files are shown flat. */
export const FLAT_LIMIT = 30;
const HUB_COUNT = 5;
const PILE_CAP = 120;
const BIG_FILE_LINES = 400;
const INSIDE_COUNT = 6;
const TOP_PAIRS = 8;

interface DirNode {
  id: string;
  kind: "dir";
  name: string;
  path: string;
  label: string;
  parent: DirNode | null;
  children: Node[];
  lines: number;
  files: number;
  keys: number;
  tests: number;
}

interface FileNode {
  id: string;
  kind: "file";
  index: number;
  name: string;
  path: string;
  parent: DirNode;
  lines: number;
  symbols: number;
  rank: number;
  place: number;
  key: boolean;
  test: boolean;
}

interface PileNode {
  id: string;
  kind: "pile" | "dirpile";
  label: string;
  path: string;
  parent: DirNode | PileNode;
  members: Node[];
  lines: number;
  files: number;
  keys: number;
}

type Node = DirNode | FileNode | PileNode;
type Group = DirNode | PileNode;

export interface GraphModel {
  readonly snapshot: GraphSnapshot;
  readonly root: DirNode;
  readonly files: FileNode[];
  readonly flat: boolean;
  readonly hubs: FileNode[];
  readonly top: Node[];
  readonly byId: Map<string, Node>;
  readonly byPath: Map<string, FileNode>;
  readonly tones: Map<string, number>;
  readonly stats: GraphStats;
  readonly groupCache: Map<string, Node[]>;
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A file name, with its folder when the name alone says little (`index.ts`, `types.ts`). */
export function shortFileName(path: string): string {
  const name = base(path);
  if (!/^(index|types|utils|constants|schema|config|main|mod)\./.test(name)) return name;
  const parts = path.split("/");
  return parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name;
}

export function buildGraphModel(snapshot: GraphSnapshot, projectName: string): GraphModel {
  const root: DirNode = {
    id: "d:",
    kind: "dir",
    name: projectName,
    path: "",
    label: projectName,
    parent: null,
    children: [],
    lines: 0,
    files: 0,
    keys: 0,
    tests: 0,
  };
  const dirs = new Map<string, DirNode>([["", root]]);
  const ranks = snapshot.files.map((f) => f.rank).sort((a, b) => b - a);
  const keyCut =
    ranks[Math.max(0, Math.min(ranks.length - 1, Math.floor(ranks.length * 0.03)))] ?? Infinity;
  const order = snapshot.files.map((_, i) => i).sort((a, b) => snapshotRank(b) - snapshotRank(a));
  function snapshotRank(i: number): number {
    return snapshot.files[i]?.rank ?? 0;
  }
  const place = new Map<number, number>();
  order.forEach((i, p) => {
    place.set(i, p + 1);
  });
  const files: FileNode[] = [];
  const byPath = new Map<string, FileNode>();
  let lines = 0;
  let symbols = 0;
  snapshot.files.forEach((f, index) => {
    const parts = f.path.split("/");
    let cur = root;
    let acc = "";
    for (let j = 0; j < parts.length - 1; j++) {
      const name = parts[j] ?? "";
      acc = acc ? `${acc}/${name}` : name;
      let d = dirs.get(acc);
      if (!d) {
        d = {
          id: `d:${acc}`,
          kind: "dir",
          name,
          path: acc,
          label: name,
          parent: cur,
          children: [],
          lines: 0,
          files: 0,
          keys: 0,
          tests: 0,
        };
        dirs.set(acc, d);
        cur.children.push(d);
      }
      cur = d;
    }
    const node: FileNode = {
      id: `f:${f.path}`,
      kind: "file",
      index,
      name: base(f.path),
      path: f.path,
      parent: cur,
      lines: f.lines,
      symbols: f.symbols,
      rank: f.rank,
      place: place.get(index) ?? 0,
      key: f.rank >= keyCut && f.rank > 0,
      test: isTestPath(f.path),
    };
    cur.children.push(node);
    files.push(node);
    byPath.set(f.path, node);
    lines += f.lines;
    symbols += f.symbols;
    for (let d: DirNode | null = cur; d; d = d.parent) {
      d.lines += f.lines;
      d.files++;
      if (node.key) d.keys++;
      if (node.test) d.tests++;
    }
  });
  const byId = new Map<string, Node>();
  for (const d of dirs.values()) byId.set(d.id, d);
  for (const f of files) byId.set(f.id, f);
  let calls = 0;
  for (const l of snapshot.links) calls += l.calls;
  const flat = files.length <= FLAT_LIMIT;
  const model: GraphModel = {
    snapshot,
    root,
    files,
    flat,
    hubs: flat
      ? []
      : files
          .filter((f) => !f.test)
          .sort((a, b) => b.rank - a.rank)
          .slice(0, HUB_COUNT),
    top: [],
    byId,
    byPath,
    tones: new Map(),
    stats: { files: files.length, lines, symbols, links: snapshot.links.length, calls },
    groupCache: new Map(),
  };
  const top = topUnits(model);
  (model as { top: Node[] }).top = top;
  assignTones(model);
  return model;
}

function isTestGroup(d: DirNode): boolean {
  return d.files > 0 && d.tests / d.files > 0.6;
}

function assignTones(model: GraphModel): void {
  const dirsBySize = model.top
    .filter((u): u is DirNode => u.kind === "dir" && !isTestGroup(u))
    .sort((a, b) => b.lines - a.lines);
  dirsBySize.forEach((d, i) => {
    model.tones.set(d.id, i % 3);
  });
}

/** The colour group of a node: the tone of the top-level block it belongs to. */
function toneOf(model: GraphModel, node: Node): number {
  if (node.kind === "file" && node.test) return TEST_TONE;
  if (node.kind === "dir" && isTestGroup(node)) return TEST_TONE;
  for (let x: Node | null = node; x; x = x.parent) {
    const t = model.tones.get(x.id);
    if (t !== undefined) return t;
    if (x.kind === "dir" && isTestGroup(x)) return TEST_TONE;
  }
  return -1;
}

function collapseChain(d: DirNode): { node: DirNode; label: string } {
  let node = d;
  let label = d.name;
  while (node.children.length === 1 && node.children[0]?.kind === "dir") {
    node = node.children[0];
    label += `/${node.name}`;
  }
  return { node, label };
}

function pileOf(
  model: GraphModel,
  owner: Group,
  what: "files" | "dirs",
  members: Node[],
): PileNode {
  const id = `${owner.id}#${what}`;
  const existing = model.byId.get(id);
  if (existing && existing.kind !== "dir" && existing.kind !== "file") return existing;
  let lines = 0;
  let files = 0;
  let keys = 0;
  for (const m of members) {
    lines += m.lines;
    if (m.kind === "file") {
      files++;
      if (m.key) keys++;
    } else {
      files += m.files;
      keys += m.keys;
    }
  }
  const pile: PileNode = {
    id,
    kind: what === "dirs" ? "dirpile" : "pile",
    label: what === "dirs" ? `${members.length} more folders` : `${members.length} small files`,
    path: owner.path,
    parent: owner,
    members,
    lines,
    files,
    keys,
  };
  model.byId.set(id, pile);
  return pile;
}

/** The blocks an open folder or pile shows, at most about `budget` of them. */
function groupOf(model: GraphModel, owner: Group, budget: number): Node[] {
  const cacheKey = `${owner.id}|${budget}`;
  const cached = model.groupCache.get(cacheKey);
  if (cached) return cached;
  const members = owner.kind === "dir" ? owner.children : owner.members;
  const ds: DirNode[] = [];
  const fs: FileNode[] = [];
  for (const c of members) {
    if (c.kind === "dir") {
      const { node, label } = collapseChain(c);
      if (node.children.length === 1 && node.children[0]?.kind === "file") {
        fs.push(node.children[0]);
        continue;
      }
      if (owner.kind === "dir") node.label = label;
      ds.push(node);
    } else if (c.kind === "file") fs.push(c);
  }
  ds.sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
  fs.sort(
    (a, b) =>
      Number(b.key) - Number(a.key) ||
      b.rank - a.rank ||
      b.lines - a.lines ||
      a.path.localeCompare(b.path),
  );
  const out: Node[] = [];
  if (model.flat) {
    out.push(...ds, ...fs);
    model.groupCache.set(cacheKey, out);
    return out;
  }
  const dirSlots = ds.length > budget - 2 ? budget - 4 : ds.length;
  out.push(...ds.slice(0, dirSlots));
  const restDirs = ds.slice(dirSlots);
  if (restDirs.length) out.push(pileOf(model, owner, "dirs", restDirs));
  const fileSlots = Math.max(3, budget - out.length - 1);
  const big = fs
    .filter((f) => f.key || f.lines >= BIG_FILE_LINES || fs.length <= 4)
    .slice(0, fileSlots);
  const minShown = Math.min(3, fs.length);
  if (big.length < minShown)
    big.push(...fs.filter((f) => !big.includes(f)).slice(0, minShown - big.length));
  out.push(...big);
  const restFiles = fs.filter((f) => !big.includes(f));
  if (restFiles.length > 3) out.push(pileOf(model, owner, "files", restFiles));
  else out.push(...restFiles);
  model.groupCache.set(cacheKey, out);
  return out;
}

function pileChildren(model: GraphModel, pile: PileNode): Node[] {
  if (pile.kind === "dirpile" || pile.members.length <= PILE_CAP) return pile.members;
  return [
    ...pile.members.slice(0, PILE_CAP),
    pileOf(model, pile, "files", pile.members.slice(PILE_CAP)),
  ];
}

function childrenOf(model: GraphModel, node: Node): Node[] {
  if (node.kind === "dir") return groupOf(model, node, CHILD_BUDGET);
  if (node.kind === "pile" || node.kind === "dirpile") return pileChildren(model, node);
  return [];
}

function expandable(node: Node): node is Group {
  return node.kind !== "file";
}

/** The top level: the root's blocks, with the biggest folders flattened while they fit. */
function topUnits(model: GraphModel): Node[] {
  if (model.flat) return model.files.slice();
  const units = groupOf(model, model.root, TOP_BUDGET).slice();
  for (let guard = 0; guard < 40; guard++) {
    const candidates = units
      .filter((u): u is DirNode => u.kind === "dir")
      .sort((a, b) => b.files - a.files);
    let flattened = false;
    for (const d of candidates) {
      const kids = groupOf(model, d, CHILD_BUDGET);
      if (units.length - 1 + kids.length > TOP_BUDGET) continue;
      for (const k of kids) if (k.kind === "dir") k.label = `${d.label}/${k.label}`;
      units.splice(units.indexOf(d), 1, ...kids);
      flattened = true;
      break;
    }
    if (!flattened) break;
  }
  return units;
}

function labelOf(node: Node): string {
  if (node.kind === "file") return shortFileName(node.path);
  return node.label;
}

function insideOf(node: Node): GraphInsideFile[] {
  if (node.kind === "file") return [];
  const all: FileNode[] = [];
  const walk = (x: Node): void => {
    if (x.kind === "file") all.push(x);
    else if (x.kind === "dir") x.children.forEach(walk);
    else x.members.forEach(walk);
  };
  walk(node);
  return all
    .sort((a, b) => b.rank - a.rank)
    .slice(0, INSIDE_COUNT)
    .map((f) => ({ path: f.path, lines: f.lines }));
}

interface Walked {
  units: Node[];
  owner: Map<string, string | null>;
  proxy: Map<string, string>;
  frames: { node: Group; owner: string | null; depth: number }[];
}

function walkVisible(model: GraphModel, expanded: Set<string>, tests: boolean): Walked {
  const shown = (n: Node): boolean => {
    if (tests) return true;
    if (n.kind === "file") return !n.test;
    if (n.kind === "dir") return !isTestGroup(n);
    return true;
  };
  const w: Walked = { units: [], owner: new Map(), proxy: new Map(), frames: [] };
  const seen = new Set<string>();
  const walk = (list: Node[], own: string | null, depth: number): void => {
    for (const u of list) {
      if (seen.has(u.id) || !shown(u)) continue;
      seen.add(u.id);
      if (expandable(u) && expanded.has(u.id)) {
        w.frames.push({ node: u, owner: own, depth });
        walk(childrenOf(model, u), u.id, depth + 1);
      } else {
        w.units.push(u);
        w.owner.set(u.id, own);
        if (u.kind === "pile" || u.kind === "dirpile")
          for (const m of u.members) w.proxy.set(m.id, u.id);
      }
    }
  };
  const hubs = new Set<Node>(model.hubs);
  walk(
    model.top.filter((u) => !hubs.has(u)),
    null,
    0,
  );
  walk(model.hubs, null, 0);
  return w;
}

function representative(w: Walked, visible: Set<string>, file: FileNode): string | null {
  for (let x: Node | null = file; x; x = x.parent) {
    if (visible.has(x.id)) return x.id;
    let p = w.proxy.get(x.id);
    while (p && !visible.has(p)) p = w.proxy.get(p);
    if (p) return p;
  }
  return null;
}

/** Ids of the folders and piles that must be open for `path` to show as its own block. */
function revealChain(
  model: GraphModel,
  path: string,
  expanded: Set<string>,
  tests: boolean,
): string | null {
  const file = model.byPath.get(path);
  if (!file) return null;
  for (let guard = 0; guard < 16; guard++) {
    const w = walkVisible(model, expanded, tests);
    const visible = new Set(w.units.map((u) => u.id));
    if (visible.has(file.id)) return file.id;
    const rep = representative(w, visible, file);
    const node = rep ? model.byId.get(rep) : undefined;
    if (!node || !expandable(node)) return null;
    expanded.add(node.id);
  }
  return null;
}

export function graphView(model: GraphModel, options: GraphViewOptions = {}): GraphView {
  const tests = options.tests ?? true;
  const typeEdges = options.typeEdges ?? true;
  const expanded = new Set(
    (options.expanded ?? []).filter((id) => model.byId.has(id) || id.includes("#")),
  );
  // Piles are created lazily; make sure the ones named exist before walking.
  const revealed =
    options.reveal !== undefined ? revealChain(model, options.reveal, expanded, tests) : null;
  const w = walkVisible(model, expanded, tests);
  const visible = new Set(w.units.map((u) => u.id));
  const reps = model.files.map((f) => representative(w, visible, f));
  const agg = new Map<string, GraphEdge & { order: number[] }>();
  const links = model.snapshot.links;
  for (let k = 0; k < links.length; k++) {
    const l = links[k];
    if (!l || (!typeEdges && l.typeOnly)) continue;
    const a = model.files[l.from];
    const b = model.files[l.to];
    if (!a || !b || (!tests && (a.test || b.test))) continue;
    const s = reps[l.from];
    const t = reps[l.to];
    if (!s || !t || s === t) continue;
    const id = `${s}>${t}`;
    let e = agg.get(id);
    if (!e) {
      e = {
        id,
        from: s,
        to: t,
        pairs: 0,
        weight: 0,
        typeOnly: 0,
        calls: 0,
        cochanges: 0,
        mutual: false,
        top: [],
        order: [],
      };
      agg.set(id, e);
    }
    e.pairs++;
    e.weight += l.weight;
    e.calls += l.calls;
    e.cochanges += l.cochanges;
    if (l.typeOnly) e.typeOnly++;
    e.order.push(k);
  }
  const edges: GraphEdge[] = [];
  for (const e of agg.values()) {
    const top = e.order
      .sort((x, y) => (links[y]?.weight ?? 0) - (links[x]?.weight ?? 0))
      .slice(0, TOP_PAIRS)
      .map((k) => {
        const l = links[k] as GraphSnapshotLink;
        return {
          from: model.files[l.from]?.path ?? "",
          to: model.files[l.to]?.path ?? "",
          weight: round1(l.weight),
          names: l.names.slice(0, 3),
          typeOnly: l.typeOnly,
          calls: l.calls,
          cochanges: l.cochanges,
        };
      });
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      pairs: e.pairs,
      weight: round1(e.weight),
      typeOnly: e.typeOnly,
      calls: e.calls,
      cochanges: e.cochanges,
      mutual: agg.has(`${e.to}>${e.from}`),
      top,
    });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const units: GraphUnit[] = w.units.map((u) => ({
    id: u.id,
    kind: u.kind,
    label: labelOf(u),
    path: u.path,
    owner: w.owner.get(u.id) ?? null,
    lines: u.lines,
    files: u.kind === "file" ? 1 : u.files,
    keys: u.kind === "file" ? Number(u.key) : u.keys,
    tone: toneOf(model, u),
    key: u.kind === "file" && u.key,
    test: u.kind === "file" ? u.test : u.kind === "dir" && isTestGroup(u),
    symbols: u.kind === "file" ? u.symbols : 0,
    rank: u.kind === "file" ? u.place : 0,
    inside: insideOf(u),
  }));
  const frames: GraphFrame[] = w.frames.map((f) => ({
    id: f.node.id,
    kind: f.node.kind,
    label: labelOf(f.node),
    path: f.node.path,
    owner: f.owner,
    depth: f.depth,
    lines: f.node.lines,
    files: f.node.files,
    keys: f.node.keys,
    inside: insideOf(f.node),
  }));
  const tones: GraphToneLabel[] = model.top
    .filter((u): u is DirNode => u.kind === "dir" && model.tones.has(u.id))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 5)
    .map((d) => ({ tone: model.tones.get(d.id) ?? 0, label: d.label }));
  if (model.files.some((f) => f.test)) tones.push({ tone: TEST_TONE, label: "tests" });
  return {
    flat: model.flat,
    expanded: [...expanded].filter((id) => frames.some((f) => f.id === id)),
    revealed,
    units,
    frames,
    edges,
    tones,
    stats: model.stats,
    hubs: model.files
      .slice()
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 7)
      .map((f) => ({ path: f.path, lines: f.lines, rank: f.place })),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Files whose path contains `query`, names that start with it first. */
export function searchGraphFiles(model: GraphModel, query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return model.files
    .filter((f) => f.path.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) ||
        b.rank - a.rank,
    )
    .slice(0, limit)
    .map((f) => f.path);
}

export interface GraphFileLink {
  path: string;
  weight: number;
  names: string[];
}

export interface GraphFileDetail {
  path: string;
  lines: number;
  symbols: number;
  exported: number;
  rank: number;
  key: boolean;
  test: boolean;
  usedBy: GraphFileLink[];
  imports: GraphFileLink[];
  usedByCount: number;
  importsCount: number;
}

export function graphFileDetail(
  model: GraphModel,
  path: string,
  limit = 8,
): GraphFileDetail | null {
  const file = model.byPath.get(path);
  if (!file) return null;
  const meta = model.snapshot.files[file.index];
  const usedBy: GraphSnapshotLink[] = [];
  const imports: GraphSnapshotLink[] = [];
  for (const l of model.snapshot.links) {
    if (l.to === file.index) usedBy.push(l);
    if (l.from === file.index) imports.push(l);
  }
  const pick = (list: GraphSnapshotLink[], end: "from" | "to"): GraphFileLink[] =>
    list
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((l) => ({
        path: model.files[l[end]]?.path ?? "",
        weight: round1(l.weight),
        names: l.names.slice(0, 3),
      }));
  return {
    path,
    lines: file.lines,
    symbols: file.symbols,
    exported: meta?.exported ?? 0,
    rank: file.place,
    key: file.key,
    test: file.test,
    usedBy: pick(usedBy, "from"),
    imports: pick(imports, "to"),
    usedByCount: usedBy.length,
    importsCount: imports.length,
  };
}

/** A short text summary for the terminal: top-level groups and the strongest links of hubs. */
export interface GraphOverview {
  flat: boolean;
  stats: GraphStats;
  groups: {
    label: string;
    kind: GraphUnitKind;
    files: number;
    lines: number;
    keys: number;
    tone: number;
    test: boolean;
  }[];
  keyFiles: {
    path: string;
    lines: number;
    usedBy: number;
    imports: number;
    topTarget: string | null;
  }[];
}

export function graphOverview(model: GraphModel, keyFiles = 8): GraphOverview {
  const view = graphView(model);
  const usedBy = new Map<number, number>();
  const imports = new Map<number, number>();
  const strongest = new Map<number, GraphSnapshotLink>();
  for (const l of model.snapshot.links) {
    usedBy.set(l.to, (usedBy.get(l.to) ?? 0) + 1);
    imports.set(l.from, (imports.get(l.from) ?? 0) + 1);
    const best = strongest.get(l.from);
    if (!best || l.weight > best.weight) strongest.set(l.from, l);
  }
  return {
    flat: model.flat,
    stats: model.stats,
    groups: view.units
      .filter((u) => u.kind !== "file")
      .map((u) => ({
        label: u.label,
        kind: u.kind,
        files: u.files,
        lines: u.lines,
        keys: u.keys,
        tone: u.tone,
        test: u.test,
      }))
      .sort((a, b) => b.lines - a.lines),
    keyFiles: model.files
      .filter((f) => !f.test)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, keyFiles)
      .map((f) => {
        const s = strongest.get(f.index);
        return {
          path: f.path,
          lines: f.lines,
          usedBy: usedBy.get(f.index) ?? 0,
          imports: imports.get(f.index) ?? 0,
          topTarget: s ? (model.files[s.to]?.path ?? null) : null,
        };
      }),
  };
}
