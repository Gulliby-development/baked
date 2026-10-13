/**
 * The commit graph of a repository: the local branches with their distance from the base branch,
 * and the latest commits of every local branch laid out in lanes (src/core/git/graph-layout.ts).
 * The desktop Git screen (through `GET /v1/git/graph`) and the terminal's `/git graph` render it.
 */
import {
  assignOwners,
  BASE_NAMES,
  type BranchKind,
  branchKind,
  FS,
  type GitGraph,
  layoutGraph,
  parseLog,
  RS,
} from "./graph-layout.js";
import { isGitRepo, run } from "./status.js";

export * from "./graph-layout.js";

export const GRAPH_COMMITS_DEFAULT = 150;
export const GRAPH_COMMITS_MAX = 1_000;
const BRANCH_MAX = 200;

async function findBase(cwd: string, local: ReadonlySet<string>): Promise<string | null> {
  const origin = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (origin.ok) {
    const name = origin.stdout.trim().replace(/^origin\//, "");
    if (local.has(name)) return name;
  }
  return BASE_NAMES.find((name) => local.has(name)) ?? null;
}

function parseCounts(text: string): { ahead: number; behind: number } | null {
  const [a, b] = text.trim().split(/\s+/);
  const ahead = Number.parseInt(a ?? "", 10);
  const behind = Number.parseInt(b ?? "", 10);
  return Number.isNaN(ahead) || Number.isNaN(behind) ? null : { ahead, behind };
}

/** Each branch's commits ahead of and behind `base`; Git 2.41+ counts them in one call. */
async function distances(
  cwd: string,
  base: string,
  names: readonly string[],
): Promise<Map<string, { ahead: number; behind: number }>> {
  const counts = new Map<string, { ahead: number; behind: number }>();
  const batch = await run(
    [
      "for-each-ref",
      `--format=%(refname:short)${FS}%(ahead-behind:refs/heads/${base})`,
      "refs/heads",
    ],
    cwd,
    10_000,
  );
  if (batch.ok) {
    for (const line of batch.stdout.split("\n")) {
      const [name, pair] = line.split(FS);
      const parsed = name && pair ? parseCounts(pair) : null;
      if (name && parsed) counts.set(name, parsed);
    }
    return counts;
  }
  // Older Git: count the most recent branches one by one.
  await Promise.all(
    names.slice(0, 40).map(async (name) => {
      const answer = await run(
        ["rev-list", "--left-right", "--count", `refs/heads/${base}...refs/heads/${name}`],
        cwd,
      );
      const parsed = answer.ok ? parseCounts(answer.stdout) : null;
      if (parsed) counts.set(name, { ahead: parsed.behind, behind: parsed.ahead });
    }),
  );
  return counts;
}

const EMPTY: GitGraph = {
  isRepo: false,
  base: null,
  current: null,
  branches: [],
  commits: [],
  lanes: 0,
  truncated: false,
};

/** Reads the graph of the repository at `cwd`: its local branches and their `limit` latest commits. */
export async function readGitGraph(cwd: string, limit = GRAPH_COMMITS_DEFAULT): Promise<GitGraph> {
  if (!(await isGitRepo(cwd))) return EMPTY;
  const count = Math.max(1, Math.min(GRAPH_COMMITS_MAX, Math.floor(limit)));
  const [refs, head] = await Promise.all([
    run(
      [
        "for-each-ref",
        "--sort=-committerdate",
        `--count=${BRANCH_MAX}`,
        `--format=%(refname:short)${FS}%(objectname)${FS}%(committerdate:unix)${FS}%(upstream:short)${FS}%(contents:subject)`,
        "refs/heads",
      ],
      cwd,
    ),
    run(["branch", "--show-current"], cwd),
  ]);
  const current = head.ok ? head.stdout.trim() || null : null;
  const rows = refs.ok
    ? refs.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name = "", hash = "", time = "0", upstream = "", subject = ""] = line.split(FS);
          return { name, hash, time: Number.parseInt(time, 10) || 0, upstream, subject };
        })
    : [];
  const local = new Set(rows.map((row) => row.name));
  const base = await findBase(cwd, local);
  const kindOf = (name: string): BranchKind => branchKind(name, base);

  const [log, counts] = await Promise.all([
    run(
      [
        "log",
        "--branches",
        "HEAD",
        "--topo-order",
        `-n`,
        String(count + 1),
        `--format=%H${FS}%P${FS}%an${FS}%ct${FS}%s${FS}%D${RS}`,
      ],
      cwd,
      15_000,
    ),
    base
      ? distances(
          cwd,
          base,
          rows.map((row) => row.name),
        )
      : Promise.resolve(new Map<string, { ahead: number; behind: number }>()),
  ]);
  const raw = log.ok ? parseLog(log.stdout, local) : [];
  const truncated = raw.length > count;
  const shown = raw.slice(0, count);
  const order = [
    ...rows.filter((row) => row.name === base),
    ...rows.filter((row) => row.name === current && row.name !== base),
    ...rows.filter((row) => row.name !== base && row.name !== current),
  ];
  const owners = assignOwners(shown, order);
  const baseRow = rows.find((row) => row.name === base);
  const laid = layoutGraph(
    shown,
    owners,
    kindOf,
    baseRow ? { hash: baseRow.hash, branch: baseRow.name } : undefined,
  );

  return {
    isRepo: true,
    base,
    current,
    branches: rows.map((row) => {
      const distance = row.name === base ? undefined : counts.get(row.name);
      return {
        name: row.name,
        kind: kindOf(row.name),
        current: row.name === current,
        head: row.hash.slice(0, 7),
        time: row.time,
        subject: row.subject,
        upstream: row.upstream || null,
        ahead: distance?.ahead ?? null,
        behind: distance?.behind ?? null,
      };
    }),
    commits: laid.commits,
    lanes: laid.lanes,
    truncated,
  };
}
