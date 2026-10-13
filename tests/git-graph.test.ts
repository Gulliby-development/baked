import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignOwners,
  branchKind,
  type GraphCommit,
  graphText,
  layoutGraph,
  mergedBranch,
  type RawCommit,
  readGitGraph,
} from "../src/core/git/graph.js";

function raw(hash: string, parents: string[], subject = hash): RawCommit {
  return { hash, parents, author: "a", time: 0, subject, refs: [] };
}

function lines(commits: GraphCommit[], lanes: number): string[] {
  return commits.map((commit) => `${graphText(commit, lanes)}  ${commit.hash}`);
}

describe("branchKind", () => {
  it("colours branches by prefix and the base branch as main", () => {
    expect(branchKind("main", "main")).toBe("main");
    expect(branchKind("develop", "develop")).toBe("main");
    expect(branchKind("origin/main", "main")).toBe("main");
    expect(branchKind("feature/pricing", "main")).toBe("feature");
    expect(branchKind("origin/feature/pricing", "main")).toBe("feature");
    expect(branchKind("bugfix/stash-pop", "main")).toBe("bugfix");
    expect(branchKind("fix/x", "main")).toBe("bugfix");
    expect(branchKind("baked/wf/0426730c", "main")).toBe("run");
    expect(branchKind("trial-15", "main")).toBe("other");
  });
});

describe("mergedBranch", () => {
  it("reads the merged branch from GitHub and Git merge messages", () => {
    expect(mergedBranch("Merge pull request #870 from Gulliby-development/feature/run-replay")).toBe(
      "feature/run-replay",
    );
    expect(mergedBranch("Merge branch 'bugfix/b' into main")).toBe("bugfix/b");
    expect(mergedBranch("Merge remote-tracking branch 'origin/main' into feature/x")).toBe(
      "origin/main",
    );
    expect(mergedBranch("Add a graph")).toBeNull();
  });
});

describe("layoutGraph", () => {
  // main: m3 (merge of f2) -> m2 -> m1; feature: f2 -> f1 -> m1.
  const commits = [
    raw("m3", ["m2", "f2"], "Merge branch 'feature/a'"),
    raw("f2", ["f1"]),
    raw("m2", ["m1"]),
    raw("f1", ["m1"]),
    raw("m1", []),
  ];

  it("keeps the base branch in lane 0 and draws the merged branch beside it", () => {
    const owners = assignOwners(commits, [{ name: "main", hash: "m3" }]);
    const { commits: laid, lanes } = layoutGraph(
      commits,
      owners,
      (name) => branchKind(name, "main"),
      { hash: "m3", branch: "main" },
    );
    expect(lanes).toBe(2);
    expect(lines(laid, lanes)).toEqual(["● ╮  m3", "│ ●  f2", "● │  m2", "│ ●  f1", "● ╯  m1"]);
    expect(laid.map((c) => c.kind)).toEqual(["main", "feature", "main", "feature", "main"]);
    // The feature line keeps its colour down to the fork, named from the merge message.
    expect(laid[3]?.branch).toBe("feature/a");
    expect(laid[4]?.up.find((edge) => edge.from === 1)).toMatchObject({ to: 0, kind: "feature" });
  });

  it("holds lane 0 for the base tip when a newer branch tip comes first", () => {
    const withTip = [raw("w1", ["m2"]), raw("m2", ["m1"]), raw("m1", [])];
    const owners = assignOwners(withTip, [
      { name: "main", hash: "m2" },
      { name: "baked/wf/1", hash: "w1" },
    ]);
    const { commits: laid } = layoutGraph(
      withTip,
      owners,
      (name) => branchKind(name, "main"),
      { hash: "m2", branch: "main" },
    );
    expect(laid.map((c) => c.lane)).toEqual([1, 0, 0]);
    expect(laid[0]?.kind).toBe("run");
    expect(laid[0]?.up).toEqual([]);
  });
});

describe("readGitGraph", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  const commit = (file: string, message: string) => {
    writeFileSync(join(dir, file), message);
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "baked-git-graph-"));
    git("init", "-q", "-b", "main");
    commit("m", "one");
    git("checkout", "-q", "-b", "feature/a");
    commit("a", "a1");
    git("checkout", "-q", "main");
    commit("m", "two");
    git("checkout", "-q", "-b", "bugfix/b");
    commit("b", "b1");
    git("checkout", "-q", "main");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lists branches with their distance from the base and lays out every branch", async () => {
    const graph = await readGitGraph(dir);
    expect(graph.isRepo).toBe(true);
    expect(graph.base).toBe("main");
    expect(graph.current).toBe("main");
    expect(graph.commits).toHaveLength(4);
    expect(graph.truncated).toBe(false);
    const byName = new Map(graph.branches.map((b) => [b.name, b]));
    expect(byName.get("main")).toMatchObject({ kind: "main", current: true, ahead: null });
    expect(byName.get("feature/a")).toMatchObject({ kind: "feature", ahead: 1, behind: 1 });
    expect(byName.get("bugfix/b")).toMatchObject({ kind: "bugfix", ahead: 1, behind: 0 });
    const main = graph.commits.find((c) => c.subject === "two");
    expect(main).toMatchObject({ lane: 0, kind: "main", branch: "main" });
    expect(main?.refs.map((ref) => ref.name)).toEqual(["HEAD", "main"]);
  });

  it("cuts the history at the limit and says so", async () => {
    const graph = await readGitGraph(dir, 2);
    expect(graph.commits).toHaveLength(2);
    expect(graph.truncated).toBe(true);
  });

  it("answers an empty graph outside a repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "baked-git-graph-none-"));
    try {
      const graph = await readGitGraph(outside);
      expect(graph).toMatchObject({ isRepo: false, commits: [], branches: [] });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
