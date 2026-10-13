import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { git } = await import("../src/renderer/client/git.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
const { CONFIRMS, changeGroups, isBranchChange, visibleBranches, branchParts, ago, BRANCH_PAGE } = await import(
  "../src/renderer/screens/git/logic.ts"
);
delete scope.window;

describe("git client", () => {
  test("reads the overview and runs the menu actions", async () => {
    const view = await git.overview("baked");
    expect(view).toMatchObject({ isRepo: true, branch: "main", isDirty: true });

    const committed = await git.run("baked", { action: "commit", message: "Ship the Git menu", stageAll: true });
    expect(committed.ok).toBe(true);
    expect(committed.overview.isDirty).toBe(false);
    expect(committed.overview.log[0]?.subject).toBe("Ship the Git menu");

    const pushed = await git.run("baked", { action: "push" });
    expect(pushed).toMatchObject({ ok: true, message: "Push complete." });
    expect(pushed.overview.ahead).toBe(0);

    const created = await git.run("baked", { action: "create-branch", name: "feature/try" });
    expect(created.overview.branch).toBe("feature/try");
    const bad = await git.run("baked", { action: "create-branch", name: "-x" });
    expect(bad.ok).toBe(false);
    const back = await git.run("baked", { action: "switch-branch", name: "main" });
    expect(back.overview.branch).toBe("main");

    const popped = await git.run("baked", { action: "stash-pop" });
    expect(popped.overview.stashes).toEqual([]);
    expect((await git.run("baked", { action: "stash", message: "later" })).overview.stashes[0]).toContain("later");
  });

  test("destructive actions need confirm", async () => {
    // A caller that forgets the confirmation is refused, as the backend does.
    const unconfirmed = { action: "reset-hard" } as unknown as Parameters<typeof git.run>[1];
    await expect(git.run("docs", unconfirmed)).rejects.toBeInstanceOf(ApiError);
    expect((await git.run("docs", { action: "reset-hard", confirm: true })).ok).toBe(true);
  });

  test("has its own project section", () => {
    expect(parseRoute(projectHref("baked", "git"))).toEqual({ name: "project", key: "baked", section: "git", id: null });
  });
});

describe("git section logic", () => {
  const base = {
    isRepo: true, branch: "main", upstream: "origin/main", isDirty: true, staged: ["a"], modified: ["a", "b"],
    untracked: ["c"], conflicts: ["d"], ahead: 2, behind: 0, branches: ["main"], stashes: [], log: [], busy: false,
  };

  test("groups changes with conflicts first and leaves empty groups out", () => {
    expect(changeGroups(base).map((g) => g.label)).toEqual(["conflict", "staged", "modified", "untracked"]);
    expect(changeGroups({ ...base, conflicts: [], untracked: [] }).map((g) => g.label)).toEqual(["staged", "modified"]);
  });

  test("confirmations say what will happen", () => {
    expect(CONFIRMS.push.body(base)).toContain("2 commits of main to origin/main");
    expect(CONFIRMS["reset-hard"].body(base)).toContain("2 tracked files");
    expect(CONFIRMS["force-push"].danger).toBe(true);
    expect(CONFIRMS.push.danger).toBe(false);
  });

  test("only branch actions refresh the project list", () => {
    expect(isBranchChange({ action: "switch-branch", name: "x" })).toBe(true);
    expect(isBranchChange({ action: "pull" })).toBe(false);
  });
});

describe("git graph", () => {
  test("the preview graph keeps main in lane 0 and colours branches by kind", async () => {
    const graph = await git.graph("baked", 150);
    expect(graph.base).toBe("main");
    const head = graph.commits.find((c) => c.refs.some((r) => r.kind === "head"));
    expect(head).toMatchObject({ lane: 0, kind: "main", branch: "main" });
    const kinds = new Set(graph.branches.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(["bugfix", "feature", "main", "other", "run"]);
    expect(graph.branches.length).toBeGreaterThan(BRANCH_PAGE);
  });

  test("the list shows ten branches, the current first, and filters the rest", () => {
    const branches = Array.from({ length: 14 }, (_, i) => ({
      name: i === 5 ? "main" : `feature/b${i}`,
      kind: "feature" as const,
      current: i === 5,
      head: "",
      time: 0,
      subject: "",
      upstream: null,
      ahead: null,
      behind: null,
    }));
    const first = visibleBranches(branches, "", BRANCH_PAGE);
    expect(first.items).toHaveLength(10);
    expect(first.items[0]?.name).toBe("main");
    expect(first.matching).toBe(14);
    expect(visibleBranches(branches, "B1", BRANCH_PAGE).items.map((b) => b.name)).toEqual([
      "feature/b1",
      "feature/b10",
      "feature/b11",
      "feature/b12",
      "feature/b13",
    ]);
    expect(branchParts("baked/wf/123")).toEqual({ prefix: "baked/wf/", rest: "123" });
  });

  test("ages read short", () => {
    const now = 1_000_000_000_000;
    expect(ago(now / 1000 - 30, now)).toBe("now");
    expect(ago(now / 1000 - 300, now)).toBe("5 min");
    expect(ago(now / 1000 - 3 * 3600, now)).toBe("3 h");
    expect(ago(now / 1000 - 2 * 86_400, now)).toBe("2 d");
  });
});
