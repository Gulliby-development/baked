/**
 * The project's Git menu over `/v1/git*` (`git` capability, docs/desktop/api.md "Git"). The
 * actions are those of the terminal Git menu in src/core/git/menu.ts; an older backend answers
 * 404 and the section shows "needs a newer BAKED". The commit graph (`git-graph` capability) is laid
 * out by src/core/git/graph-layout.ts; without it the section lists the recent commits instead.
 */
import { call } from "./api.js";
import { GIT_CAPABILITY, GIT_GRAPH_CAPABILITY } from "./capabilities.js";
import { withCapability } from "./setup.js";

export interface GitLogEntry {
  hash: string;
  subject: string;
  /** Relative, as Git prints it ("2 hours ago"). */
  date: string;
}

export interface GitOverview {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  isDirty: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicts: string[];
  ahead: number;
  behind: number;
  branches: string[];
  stashes: string[];
  log: GitLogEntry[];
  /** A workflow run holds the workspace; actions are refused until it finishes. */
  busy: boolean;
  /**
   * Whether worktree runs can use the folder: `ready`, `missing` (no Git), `no-commit`, or
   * `nested` (inside another repository). Absent on older backends.
   */
  setup?: GitSetup;
}

export type GitSetup = "ready" | "missing" | "no-commit" | "nested";

/** Initialize Git can bring the folder to `ready`. */
export const canInitGit = (view: Pick<GitOverview, "isRepo" | "setup">): boolean =>
  view.setup === "missing" || view.setup === "no-commit" || (!view.setup && !view.isRepo);

export type GitAction =
  | { action: "init" }
  | { action: "commit"; message: string; stageAll?: boolean }
  | { action: "push" | "pull" | "stash-pop" }
  | { action: "stash"; message?: string }
  | { action: "create-branch" | "switch-branch"; name: string }
  | { action: "force-push" | "reset-hard"; confirm: true };

export interface GitActionAnswer {
  ok: boolean;
  message: string;
  output: string;
  overview: GitOverview;
}

/** How a branch is coloured: the base branch, `feature/`, `bugfix/`, BAKED run branches, others. */
export type BranchKind = "main" | "feature" | "bugfix" | "run" | "other";

export interface GraphRef {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
  branchKind: BranchKind;
}

/** Half a row of a lane: from lane `from` to lane `to`. */
export interface GraphEdge {
  from: number;
  to: number;
  kind: BranchKind;
  branch: string | null;
}

export interface GraphCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  time: number;
  subject: string;
  refs: GraphRef[];
  lane: number;
  kind: BranchKind;
  branch: string | null;
  /** Segments from the top of the row to the node's height. */
  up: GraphEdge[];
  /** Segments from the node's height to the bottom of the row. */
  down: GraphEdge[];
}

export interface GraphBranch {
  name: string;
  kind: BranchKind;
  current: boolean;
  head: string;
  time: number;
  subject: string;
  upstream: string | null;
  /** Commits ahead of and behind the base branch; null for the base or when unknown. */
  ahead: number | null;
  behind: number | null;
}

export interface GitGraph {
  isRepo: boolean;
  base: string | null;
  current: string | null;
  branches: GraphBranch[];
  commits: GraphCommit[];
  lanes: number;
  truncated: boolean;
}

export const git = {
  overview: (key: string) =>
    withCapability(key, GIT_CAPABILITY, () => call<GitOverview>(key, "GET", "/v1/git")),
  graph: (key: string, limit: number) =>
    withCapability(key, GIT_GRAPH_CAPABILITY, () =>
      call<GitGraph>(key, "GET", `/v1/git/graph?limit=${limit}`),
    ),
  run: (key: string, action: GitAction) =>
    call<GitActionAnswer>(key, "POST", "/v1/git/actions", action),
};
