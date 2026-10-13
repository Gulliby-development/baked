/**
 * The layout of a commit graph, without I/O: lanes, nodes and edges for commits given newest first,
 * as `git log --graph` draws them. src/core/git/graph.ts reads the repository; the desktop Git
 * screen (through `GET /v1/git/graph`) and the terminal's `/git graph` render the result.
 */
/** How a branch is coloured: the base branch, `feature/`, `bugfix/`, BAKED run branches, others. */
export type BranchKind = "main" | "feature" | "bugfix" | "run" | "other";

export interface GraphRef {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
  /** The colour of the branch the ref names; tags and HEAD take the commit's. */
  branchKind: BranchKind;
}

/** One segment of a row: half a row tall, from lane `from` to lane `to`. */
export interface GraphEdge {
  from: number;
  to: number;
  kind: BranchKind;
  /** The branch whose line this is, when one owns it. */
  branch: string | null;
}

export interface GraphCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  /** Committer time, Unix seconds. */
  time: number;
  subject: string;
  refs: GraphRef[];
  /** The node's column. */
  lane: number;
  kind: BranchKind;
  /** The branch whose first-parent line this commit is on, base and current branch first. */
  branch: string | null;
  /** Segments above the node: each lane that enters this row, to where it goes at the node's height. */
  up: GraphEdge[];
  /** Segments below the node: from the node's height to each lane that leaves this row. */
  down: GraphEdge[];
}

export interface GraphBranch {
  name: string;
  kind: BranchKind;
  current: boolean;
  head: string;
  /** Committer time of the branch's tip, Unix seconds. */
  time: number;
  subject: string;
  upstream: string | null;
  /** Commits on the branch and not on the base branch; null for the base itself or when unknown. */
  ahead: number | null;
  behind: number | null;
}

export interface GitGraph {
  isRepo: boolean;
  /** The branch others are measured against: origin's HEAD, else main, master, trunk or develop. */
  base: string | null;
  current: string | null;
  /** Local branches, most recently committed first. */
  branches: GraphBranch[];
  commits: GraphCommit[];
  /** The widest row, in lanes. */
  lanes: number;
  /** More commits exist past `limit`. */
  truncated: boolean;
}

/** Names taken for the base branch when origin names none. */
export const BASE_NAMES = ["main", "master", "trunk", "develop"];
/** The field and record separators of the `git log` format `parseLog` reads. */
export const FS = "\x1f";
export const RS = "\x1e";

/** The colour kind of a branch name; `origin/feature/x` is a feature branch too. */
export function branchKind(name: string, base: string | null): BranchKind {
  const local = name.replace(/^(refs\/(heads|remotes)\/)?/, "");
  const bare =
    local.includes("/") && !/^(feature|bugfix|fix|hotfix|baked)\//.test(local)
      ? local.slice(local.indexOf("/") + 1)
      : local;
  if (bare === base || local === base || BASE_NAMES.includes(bare)) return "main";
  if (/^feature\//.test(bare)) return "feature";
  if (/^(bugfix|fix|hotfix)\//.test(bare)) return "bugfix";
  if (/^baked\//.test(bare)) return "run";
  return "other";
}

/** Parses `%D` decorations: "HEAD -> main, origin/main, tag: v1". */
export function parseRefs(decoration: string, localBranches: ReadonlySet<string>): GraphRef[] {
  const refs: GraphRef[] = [];
  for (const part of decoration.split(",")) {
    const text = part.trim();
    if (!text) continue;
    if (text.startsWith("HEAD -> ")) {
      refs.push({ name: "HEAD", kind: "head", branchKind: "other" });
      refs.push({ name: text.slice(8), kind: "branch", branchKind: "other" });
    } else if (text === "HEAD") refs.push({ name: "HEAD", kind: "head", branchKind: "other" });
    else if (text.startsWith("tag: "))
      refs.push({ name: text.slice(5), kind: "tag", branchKind: "other" });
    else if (!text.endsWith("/HEAD"))
      refs.push({
        name: text,
        kind: localBranches.has(text) ? "branch" : "remote",
        branchKind: "other",
      });
  }
  return refs;
}

export interface RawCommit {
  hash: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
  refs: GraphRef[];
}

interface Slot {
  hash: string;
  kind: BranchKind;
  branch: string | null;
  /** Holds lane 0 for the base branch until its tip's row; draws nothing. */
  ghost?: boolean;
}

/**
 * Lays out commits given newest first in topological order. Each lane waits for one commit; a
 * commit takes the leftmost lane that waits for it, the lanes that also waited for it end there
 * (the branches that forked from it), its first parent continues its lane and each further parent
 * (a merge) joins a lane that already waits for it or opens a free one. A line keeps the colour
 * of the branch that drew it, so a feature branch stays green down to its fork from main.
 */
export function layoutGraph(
  commits: readonly RawCommit[],
  owners: ReadonlyMap<string, string>,
  kindOf: (branch: string) => BranchKind,
  /** The base branch's tip: lane 0 stays free for it, so main runs down the left edge. */
  baseTip?: { hash: string; branch: string },
): { commits: GraphCommit[]; lanes: number } {
  const lanes: (Slot | null)[] =
    baseTip && commits.some((commit) => commit.hash === baseTip.hash)
      ? [{ hash: baseTip.hash, kind: kindOf(baseTip.branch), branch: baseTip.branch, ghost: true }]
      : [];
  let width = 0;
  const laid: GraphCommit[] = [];
  for (const commit of commits) {
    const owner = owners.get(commit.hash) ?? null;
    let lane = lanes.findIndex((slot) => slot?.hash === commit.hash);
    const before = lanes.slice();
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
    }
    const waiting = before[lane];
    const branch = owner ?? waiting?.branch ?? null;
    const kind = owner ? kindOf(owner) : (waiting?.kind ?? "other");

    const up: GraphEdge[] = [];
    before.forEach((slot, index) => {
      if (!slot) return;
      if (slot.ghost) {
        if (slot.hash === commit.hash) lanes[index] = null;
        return;
      }
      const to = slot.hash === commit.hash ? lane : index;
      up.push({ from: index, to, kind: slot.kind, branch: slot.branch });
      if (slot.hash === commit.hash) lanes[index] = null;
    });

    const [first, ...rest] = commit.parents;
    const down: GraphEdge[] = [];
    // The first parent always continues the commit's lane, even when another lane waits for it
    // too, so main keeps its column; the lanes meet at the parent's row.
    if (first !== undefined) lanes[lane] = { hash: first, kind, branch };
    const merged = mergedBranch(commit.subject);
    for (const parent of rest) {
      const parentOwner = owners.get(parent) ?? merged;
      const slot: Slot = {
        hash: parent,
        kind: parentOwner ? kindOf(parentOwner) : "other",
        branch: parentOwner,
      };
      const already = lanes.findIndex((s) => s?.hash === parent);
      if (already !== -1) {
        const target = lanes[already];
        if (target?.ghost) lanes[already] = { ...target, ghost: false };
        down.push({ from: lane, to: already, kind: slot.kind, branch: slot.branch });
        continue;
      }
      let free = lanes.findIndex((s, i) => s === null && i > lane);
      if (free === -1) free = lanes.length;
      lanes[free] = slot;
      down.push({ from: lane, to: free, kind: slot.kind, branch: slot.branch });
    }
    lanes.forEach((slot, index) => {
      if (!slot || slot.ghost) return;
      // The first parent's own lane, and lanes that pass this row untouched.
      if (index === lane && slot.hash === first) down.push({ from: lane, to: lane, ...pick(slot) });
      else if (before[index]?.hash === slot.hash)
        down.push({ from: index, to: index, ...pick(slot) });
    });
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lane + 1, lanes.length, before.length);
    laid.push({
      ...commit,
      short: commit.hash.slice(0, 7),
      refs: commit.refs.map((ref) => ({
        ...ref,
        branchKind: ref.kind === "branch" || ref.kind === "remote" ? kindOf(ref.name) : kind,
      })),
      lane,
      kind,
      branch,
      up,
      down,
    });
  }
  return { commits: laid, lanes: width };
}

/**
 * The branch a merge commit brought in, from Git's and GitHub's default merge messages, so a merged
 * and deleted `feature/` branch keeps its colour.
 */
export function mergedBranch(subject: string): string | null {
  const match =
    /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject) ??
    /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  return match?.[1] ?? null;
}

function pick(slot: Slot): { kind: BranchKind; branch: string | null } {
  return { kind: slot.kind, branch: slot.branch };
}

/**
 * Which branch each commit belongs to: walking the first parents of each tip, base branch first,
 * then the current branch, then the rest by recency, a commit goes to the first branch that
 * reaches it.
 */
export function assignOwners(
  commits: readonly RawCommit[],
  tips: readonly { name: string; hash: string }[],
): Map<string, string> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const owners = new Map<string, string>();
  for (const tip of tips) {
    let hash: string | undefined = tip.hash;
    while (hash && !owners.has(hash)) {
      const commit = byHash.get(hash);
      if (!commit) break;
      owners.set(hash, tip.name);
      hash = commit.parents[0];
    }
  }
  return owners;
}

export function parseLog(stdout: string, localBranches: ReadonlySet<string>): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const record of stdout.split(RS)) {
    const text = record.replace(/^\n/, "");
    if (!text.trim()) continue;
    const [hash = "", parents = "", author = "", time = "0", subject = "", refs = ""] =
      text.split(FS);
    if (!hash) continue;
    commits.push({
      hash,
      parents: parents.split(" ").filter(Boolean),
      author,
      time: Number.parseInt(time, 10) || 0,
      subject,
      refs: parseRefs(refs.trim(), localBranches),
    });
  }
  return commits;
}

const LANE_GLYPH: Record<"node" | "line" | "empty", string> = {
  node: "●",
  line: "│",
  empty: " ",
};

/**
 * One text line per commit, for the terminal: a column per lane, `●` for the commit, `│` for the
 * lanes that pass, `╮`/`╯` where a merge or fork joins another lane on that row.
 */
export function graphText(commit: GraphCommit, lanes: number): string {
  const cells: string[] = Array.from({ length: Math.max(1, lanes) }, () => LANE_GLYPH.empty);
  for (const edge of [...commit.up, ...commit.down]) {
    if (edge.from === edge.to && cells[edge.from] === LANE_GLYPH.empty)
      cells[edge.from] = LANE_GLYPH.line;
  }
  // A lane that bends into the node or out of it; a lane that also passes keeps its line.
  for (const edge of commit.up) {
    if (edge.from !== edge.to && cells[edge.from] === LANE_GLYPH.empty)
      cells[edge.from] = edge.from > edge.to ? "╯" : "╰";
  }
  for (const edge of commit.down) {
    if (edge.from !== edge.to && cells[edge.to] === LANE_GLYPH.empty)
      cells[edge.to] = edge.to > edge.from ? "╮" : "╭";
  }
  cells[commit.lane] = LANE_GLYPH.node;
  return cells.join(" ").trimEnd();
}
