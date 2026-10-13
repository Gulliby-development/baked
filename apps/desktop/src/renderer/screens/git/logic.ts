import type {
  BranchKind,
  GitAction,
  GitGraph,
  GitOverview,
  GraphBranch,
} from "../../client/git.js";

/** The Git actions that ask first: push changes the remote, the others can lose work. */
export type Confirmable = "push" | "force-push" | "reset-hard";

export interface ConfirmText {
  title: string;
  confirmLabel: string;
  danger: boolean;
  body: (view: GitOverview) => string;
}

const branch = (view: GitOverview): string => view.branch ?? "HEAD";

/** The questions, worded like the terminal Git menu's confirmations. */
export const CONFIRMS: Record<Confirmable, ConfirmText> = {
  push: {
    title: "Push to the remote?",
    confirmLabel: "Push",
    danger: false,
    body: (view) =>
      view.upstream
        ? `Sends ${view.ahead} commit${view.ahead === 1 ? "" : "s"} of ${branch(view)} to ${view.upstream}.`
        : `${branch(view)} has no upstream branch; Git refuses the push unless push.autoSetupRemote is set.`,
  },
  "force-push": {
    title: "Force-push to the remote?",
    confirmLabel: "Force push",
    danger: true,
    body: (view) =>
      `git push --force-with-lease overwrites ${view.upstream ?? "the remote branch"}. Other contributors' commits may be discarded; the lease refuses only when the remote moved since your last fetch.`,
  },
  "reset-hard": {
    title: "Reset the working tree?",
    confirmLabel: "Reset hard",
    danger: true,
    body: (view) => {
      const count = new Set([...view.staged, ...view.modified]).size;
      return `git reset --hard HEAD discards the uncommitted changes of ${count} tracked file${count === 1 ? "" : "s"}. Untracked files are kept.`;
    },
  },
};

export interface ChangeGroup {
  label: string;
  tone?: "warn" | "err";
  files: string[];
}

/** The changed files by kind, conflicts first; empty groups are left out. */
export function changeGroups(view: GitOverview): ChangeGroup[] {
  const groups: ChangeGroup[] = [
    { label: "conflict", tone: "err", files: view.conflicts },
    { label: "staged", files: view.staged },
    { label: "modified", tone: "warn", files: view.modified },
    { label: "untracked", files: view.untracked },
  ];
  return groups.filter((group) => group.files.length > 0);
}

/** Whether an action can move HEAD to another branch, which the project list shows. */
export function isBranchChange(action: GitAction): boolean {
  return action.action === "create-branch" || action.action === "switch-branch";
}

// --- Commit graph and branch list -----------------------------------------------------------------

/** The colour block of each branch kind, as a fill utility and as the CSS colour for SVG strokes. */
export const KIND_BG: Record<BranchKind, string> = {
  main: "bg-main",
  feature: "bg-fill-ok",
  bugfix: "bg-fill-err",
  run: "bg-fill-info",
  other: "bg-fill-warn",
};
export const KIND_COLOR: Record<BranchKind, string> = {
  main: "var(--fill-accent)",
  feature: "var(--fill-ok)",
  bugfix: "var(--fill-err)",
  run: "var(--fill-info)",
  other: "var(--fill-warn)",
};
export const KIND_LABEL: Record<BranchKind, string> = {
  main: "main",
  feature: "feature",
  bugfix: "bugfix",
  run: "workflow run",
  other: "other",
};
export const KINDS: BranchKind[] = ["main", "feature", "bugfix", "run", "other"];

/** How many branches the list shows at first and adds per "Show more". */
export const BRANCH_PAGE = 10;

/** The name split before its last `/`, so the list can dim `feature/` and stress the rest. */
export function branchParts(name: string): { prefix: string; rest: string } {
  const cut = name.lastIndexOf("/");
  return cut === -1
    ? { prefix: "", rest: name }
    : { prefix: name.slice(0, cut + 1), rest: name.slice(cut + 1) };
}

/**
 * The branches the list shows: the current branch first, then the others in their order (most
 * recent first), those matching `filter` only, cut at `shown`.
 */
export function visibleBranches(
  branches: readonly GraphBranch[],
  filter: string,
  shown: number,
): { items: GraphBranch[]; matching: number } {
  const needle = filter.trim().toLowerCase();
  const matching = branches
    .filter((branch) => !needle || branch.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.current) - Number(a.current));
  return { items: matching.slice(0, shown), matching: matching.length };
}

/** Plain branch names as list rows, for a backend without the graph. */
export function plainBranches(view: GitOverview): GraphBranch[] {
  return view.branches.map((name) => ({
    name,
    kind: name === "main" || name === "master" ? "main" : kindByPrefix(name),
    current: name === view.branch,
    head: "",
    time: 0,
    subject: "",
    upstream: null,
    ahead: null,
    behind: null,
  }));
}

function kindByPrefix(name: string): BranchKind {
  if (name.startsWith("feature/")) return "feature";
  if (/^(bugfix|fix|hotfix)\//.test(name)) return "bugfix";
  if (name.startsWith("baked/")) return "run";
  return "other";
}

/** "now", "5 min", "3 h", "2 d", "4 wk", "7 mo", "2 y": short enough for a graph row. */
export function ago(seconds: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - seconds);
  if (diff < 60) return "now";
  const steps: [number, string][] = [
    [60, "min"],
    [3_600, "h"],
    [86_400, "d"],
    [604_800, "wk"],
    [2_592_000, "mo"],
    [31_536_000, "y"],
  ];
  let label = "min";
  let size = 60;
  for (const [step, name] of steps) {
    if (diff >= step) {
      size = step;
      label = name;
    }
  }
  return `${Math.floor(diff / size)} ${label}`;
}

/** The commits a branch's own line runs through, for the graph to light up when it is picked. */
export function lineage(graph: GitGraph, branch: string | null): Set<string> | null {
  if (!branch) return null;
  return new Set(graph.commits.filter((commit) => commit.branch === branch).map((c) => c.hash));
}
