import type { ApiResponse } from "../../shared/api.js";
import type { GitGraph, GraphBranch } from "./git.js";
import { type MockRequest, response } from "./mock-response.js";

/**
 * The commit graph in the preview bridge: a made-up history per project, replayed as branches,
 * commits and merges, then laid out by the backend's own layout (src/core/git/graph-layout.ts).
 */
type Layout = typeof import("../../../../../src/core/git/graph-layout.js");
let layout: Promise<Layout> | null = null;
const loadLayout = (): Promise<Layout> => {
  layout ??= import("../../../../../src/core/git/graph-layout.js");
  return layout;
};

/** Fixed clock for the samples: 2026-10-13 12:00 UTC. */
const NOW = 1_791_892_800;
const AUTHORS = ["gulliby", "BAKED", "gulliby", "Claude"];

interface Raw {
  hash: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
}

/** Replays a history: `commit` on a branch (created from `from` the first time), `merge` into one. */
function history(steps: readonly (readonly string[])[]): {
  commits: Raw[];
  heads: Map<string, string>;
} {
  const commits: Raw[] = [];
  const heads = new Map<string, string>();
  steps.forEach((step, i) => {
    const [op, branch = "main", subject = "", from = "main"] = step;
    const hash = ((i + 1) * 2_654_435_761).toString(16).padStart(8, "0").slice(-8).repeat(5);
    const time = NOW - (steps.length - i) * 2_700;
    const author = AUTHORS[i % AUTHORS.length] ?? "gulliby";
    const head = heads.get(branch) ?? heads.get(from);
    if (op === "merge") {
      const source = heads.get(from);
      commits.push({
        hash,
        parents: [head, source].filter((p): p is string => !!p),
        author: "gulliby",
        time,
        subject,
      });
      if (step[4] === "delete") heads.delete(from);
    } else {
      commits.push({ hash, parents: head ? [head] : [], author, time, subject });
    }
    heads.set(branch, hash);
  });
  return { commits: commits.reverse(), heads };
}

const BAKED_STEPS: readonly (readonly string[])[] = [
  ["commit", "main", "Initial import of the BAKED agent"],
  ["commit", "main", "Run the main agent through providers"],
  ["commit", "feature/desktop-git-menu", "Show the Git menu in the desktop app"],
  ["commit", "main", "Settings schema for the desktop"],
  ["commit", "feature/desktop-git-menu", "Confirm push and hard reset in the desktop"],
  ["commit", "bugfix/stash-pop", "Keep untracked files when popping a stash"],
  [
    "merge",
    "main",
    "Merge pull request #712 from Gulliby-development/feature/desktop-git-menu",
    "feature/desktop-git-menu",
    "delete",
  ],
  ["commit", "baked/wf/0426730c-05b2-4dfb-b10b-b9a17c64f8bf", "Plan: status filter for runs"],
  ["commit", "main", "Recover interrupted runs"],
  ["commit", "feature/cross-os-tests-win", "Run the suite on Windows runners"],
  ["commit", "baked/wf/0426730c-05b2-4dfb-b10b-b9a17c64f8bf", "Implement the status filter"],
  ["commit", "bugfix/stash-pop", "Test stash pop with untracked files"],
  [
    "merge",
    "main",
    "Merge pull request #731 from Gulliby-development/bugfix/stash-pop",
    "bugfix/stash-pop",
  ],
  ["commit", "feature/sizing-steps", "Size each workflow step by its files"],
  ["commit", "feature/cross-os-tests-win", "Use path.win32 in the sandbox tests"],
  ["commit", "trial-15", "Trial: quick preset on a todo app"],
  ["commit", "main", "Show token usage per run"],
  ["commit", "feature/sizing-steps", "Explain step sizes in the plan view"],
  ["commit", "bugfix/lsp-console-windows", "Hide the LSP console window on Windows"],
  [
    "merge",
    "feature/cross-os-tests-win",
    "Merge branch 'main' into feature/cross-os-tests-win",
    "main",
  ],
  ["commit", "baked/wf/cac57e34-f539-4acd-89f1-ab2278da8e71", "Research: commit graph layouts"],
  ["commit", "main", "Coordinator suggests a workflow for big tasks"],
  ["commit", "trial-14", "Trial: sdd preset on a Go service", "trial-15"],
  ["commit", "bugfix/correction-checks", "Re-run checks after a correction"],
  ["commit", "baked/wf/cac57e34-f539-4acd-89f1-ab2278da8e71", "Plan: lanes, merges and colours"],
  [
    "merge",
    "main",
    "Merge pull request #760 from Gulliby-development/feature/sizing-steps",
    "feature/sizing-steps",
    "delete",
  ],
  ["commit", "feature/cross-os-tests-win", "Normalise line endings in snapshots"],
  ["commit", "bugfix/lsp-console-windows", "Cover the hidden console in a test"],
  ["commit", "main", "Release 0.3.0"],
  ["commit", "feature/desktop-git-graph", "Draw the commit graph in the Git section"],
  ["commit", "feature/desktop-git-graph", "Colour branches by kind"],
  ["commit", "main", "Show more for long branch lists"],
];

const MORE_BRANCHES = [
  "feature/packages-popup",
  "feature/diagnostics-redesign",
  "feature/agent-context-screen",
  "bugfix/queue-stuck-pr",
  "feature/memory-share-runs",
  "bugfix/tray-badge-mac",
  "feature/coordinator-first",
  "experiment/vim-keys",
  "feature/workflow-runs-conveyor",
  "bugfix/compact-overflow",
  "feature/permission-modes",
  "feature/context-size-picker",
];

const SMALL_STEPS: readonly (readonly string[])[] = [
  ["commit", "main", "Start the docs site"],
  ["commit", "main", "Write the getting started guide"],
  ["commit", "feature/pricing", "Add the pricing page"],
  ["commit", "main", "Fix broken links"],
  ["commit", "feature/pricing", "Compare plans in a table"],
];

const graphs = new Map<string, Promise<GitGraph>>();

async function build(key: string): Promise<GitGraph> {
  const core = await loadLayout();
  const steps = key === "baked" ? BAKED_STEPS : SMALL_STEPS;
  const { commits, heads } = history(steps);
  const base = "main";
  const current = key === "site" ? "feature/pricing" : "main";
  const byTime = [...heads.entries()].sort(
    (a, b) =>
      (commits.find((c) => c.hash === b[1])?.time ?? 0) -
      (commits.find((c) => c.hash === a[1])?.time ?? 0),
  );
  const local = new Set(heads.keys());
  const mainHead = heads.get(base) ?? "";
  const originMain = commits.find((c) => c.hash === mainHead)?.parents[0] ?? mainHead;
  const raw = commits.map((commit) => {
    const names = byTime.filter(([, hash]) => hash === commit.hash).map(([name]) => name);
    const decoration = [
      ...names.map((name) => (name === current ? `HEAD -> ${name}` : name)),
      ...(key === "baked" && commit.hash === originMain ? ["origin/main"] : []),
      ...(commit.subject === "Release 0.3.0" ? ["tag: v0.3.0"] : []),
    ].join(", ");
    return { ...commit, refs: core.parseRefs(decoration, local) };
  });
  const order = [
    ...byTime.filter(([name]) => name === base),
    ...byTime.filter(([name]) => name !== base),
  ].map(([name, hash]) => ({ name, hash }));
  const owners = core.assignOwners(raw, order);
  const kindOf = (name: string) => core.branchKind(name, base);
  const laid = core.layoutGraph(raw, owners, kindOf, { hash: mainHead, branch: base });
  const mainAncestors = new Set<string>();
  const walk = (hash: string | undefined) => {
    for (let h = hash; h && !mainAncestors.has(h); ) {
      mainAncestors.add(h);
      const c = commits.find((x) => x.hash === h);
      c?.parents.slice(1).forEach(walk);
      h = c?.parents[0];
    }
  };
  walk(mainHead);
  const branches: GraphBranch[] = byTime.map(([name, hash], i) => {
    const tip = commits.find((c) => c.hash === hash);
    const ahead = name === base ? null : 1 + (i % 4);
    return {
      name,
      kind: kindOf(name),
      current: name === current,
      head: hash.slice(0, 7),
      time: tip?.time ?? NOW,
      subject: tip?.subject ?? "",
      upstream: name.startsWith("baked/") || name.startsWith("trial") ? null : `origin/${name}`,
      ahead,
      behind: name === base ? null : (i * 3) % 11,
    };
  });
  if (key === "baked")
    MORE_BRANCHES.forEach((name, i) => {
      branches.push({
        name,
        kind: kindOf(name),
        current: false,
        head: (0x1a2b3c4 + i * 0x101).toString(16).slice(0, 7),
        time: NOW - 86_400 * (3 + i * 2),
        subject: `Older work on ${name.split("/").pop()}`,
        upstream: `origin/${name}`,
        ahead: 1 + (i % 3),
        behind: 20 + i * 7,
      });
    });
  return {
    isRepo: true,
    base,
    current,
    branches,
    commits: laid.commits,
    lanes: laid.lanes,
    truncated: false,
  };
}

export async function gitGraphRoutes({
  key,
  method,
  path,
}: MockRequest): Promise<ApiResponse | undefined> {
  if (path !== "/v1/git/graph" || method !== "GET") return undefined;
  let found = graphs.get(key);
  if (!found) {
    found = build(key);
    graphs.set(key, found);
  }
  return response(200, structuredClone(await found));
}
