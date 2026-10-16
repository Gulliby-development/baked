import type { ApiResponse } from "../../shared/api.js";
import type { GitAction, GitOverview } from "./git.js";
import { type MockRequest, response } from "./mock-routes.js";

/**
 * The Git section in the preview bridge: a small repository per project whose status, branches
 * and stashes change as the actions run. Push and pull pretend the remote answered.
 */
function repo(branch: string, extra: Partial<GitOverview> = {}): GitOverview {
  return {
    isRepo: true,
    branch,
    upstream: `origin/${branch}`,
    isDirty: false,
    staged: [],
    modified: [],
    untracked: [],
    conflicts: [],
    ahead: 0,
    behind: 0,
    branches: [branch, "main"].filter((b, i, all) => all.indexOf(b) === i),
    stashes: [],
    log: [
      { hash: "4f2c1aa", subject: "Show the Git menu in the desktop app", date: "2 hours ago" },
      { hash: "9b03e7d", subject: "Settings schema for the desktop", date: "5 hours ago" },
      { hash: "17ac5e2", subject: "Recover interrupted runs", date: "1 day ago" },
    ],
    busy: false,
    setup: "ready",
    ...extra,
  };
}

const REPOS: Record<string, GitOverview> = {
  baked: repo("main", {
    isDirty: true,
    staged: ["src/core/git/menu.ts"],
    modified: ["docs/desktop/app.md", "apps/desktop/src/renderer/screens/git/GitSection.tsx"],
    untracked: ["tests/git-menu.test.ts"],
    ahead: 1,
    branches: ["main", "feature/desktop-git-menu", "bugfix/stash-pop"],
    stashes: ["stash@{0}: On main: try a smaller commit form"],
  }),
  docs: repo("main", { behind: 2 }),
  site: repo("feature/pricing", { upstream: null }),
  client: repo("main"),
};

let stashCount = 0;

function apply(state: GitOverview, request: GitAction): { ok: boolean; message: string } {
  switch (request.action) {
    case "init":
      if (state.isRepo && state.setup !== "no-commit")
        return { ok: false, message: "The project folder already has Git with a commit." };
      Object.assign(state, repo("main", { upstream: null, setup: "ready" }));
      state.log = [
        { hash: "a1b2c3d", subject: "Baseline before BAKED worktree runs", date: "just now" },
      ];
      return {
        ok: true,
        message: "Initialized Git with 12 files (a1b2c3d) and wrote a .gitignore.",
      };
    case "commit": {
      const message = request.message.trim();
      if (!message) return { ok: false, message: "Commit message cannot be empty" };
      if (!state.isDirty)
        return { ok: false, message: "Commit failed: nothing to commit, working tree clean" };
      const subject = message.split("\n")[0] ?? message;
      state.log.unshift({
        hash: Math.random().toString(16).slice(2, 9),
        subject,
        date: "just now",
      });
      // Like the terminal form: everything when asked or when nothing was staged.
      if (request.stageAll || state.staged.length === 0) {
        state.modified = [];
        state.untracked = [];
      }
      state.staged = [];
      state.isDirty = state.modified.length + state.untracked.length > 0;
      if (state.upstream) state.ahead += 1;
      return { ok: true, message: `Committed: ${message.split("\n")[0]}` };
    }
    case "push":
    case "force-push":
      if (!state.upstream) {
        return {
          ok: false,
          message: `Push failed: fatal: The current branch ${state.branch} has no upstream branch.`,
        };
      }
      state.ahead = 0;
      return {
        ok: true,
        message: request.action === "push" ? "Push complete." : "Force push complete.",
      };
    case "pull":
      state.behind = 0;
      return { ok: true, message: "Pull complete." };
    case "stash": {
      if (!state.isDirty && state.staged.length === 0)
        return { ok: false, message: "Stash failed: No local changes to save" };
      stashCount += 1;
      const label =
        request.message?.trim() || `WIP on ${state.branch}: ${state.log[0]?.hash ?? ""}`;
      state.stashes.unshift(`stash@{0}: On ${state.branch}: ${label}`);
      state.stashes = state.stashes.map((line, i) =>
        line.replace(/^stash@\{\d+\}/, `stash@{${i}}`),
      );
      state.staged = [];
      state.modified = [];
      state.untracked = [];
      state.isDirty = false;
      return { ok: true, message: "Changes stashed." };
    }
    case "stash-pop": {
      if (state.stashes.length === 0)
        return { ok: false, message: "Stash pop failed: No stash entries found." };
      state.stashes.shift();
      state.stashes = state.stashes.map((line, i) =>
        line.replace(/^stash@\{\d+\}/, `stash@{${i}}`),
      );
      state.modified = [`notes/stash-${stashCount}.md`];
      state.isDirty = true;
      return { ok: true, message: "Stash popped." };
    }
    case "reset-hard":
      state.staged = [];
      state.modified = [];
      state.isDirty = state.untracked.length > 0;
      return { ok: true, message: "Reset complete." };
    case "create-branch": {
      const name = request.name.trim();
      if (!/^[\w./-]+$/.test(name) || name.startsWith("-") || name.includes(".."))
        return { ok: false, message: `Not a valid branch name: ${name}` };
      if (state.branches.includes(name))
        return {
          ok: false,
          message: `Branch failed: fatal: a branch named '${name}' already exists`,
        };
      state.branches.unshift(name);
      state.branch = name;
      state.upstream = null;
      state.ahead = 0;
      state.behind = 0;
      return { ok: true, message: `Switched to new branch '${name}'` };
    }
    case "switch-branch": {
      if (!state.branches.includes(request.name))
        return { ok: false, message: `No local branch ${request.name}` };
      state.branch = request.name;
      state.upstream = `origin/${request.name}`;
      return { ok: true, message: `Switched to branch '${request.name}'` };
    }
  }
}

const DESTRUCTIVE = new Set(["force-push", "reset-hard"]);

export function gitRoutes({ key, method, path, body }: MockRequest): ApiResponse | undefined {
  if (path !== "/v1/git" && path !== "/v1/git/actions") return undefined;
  const state = REPOS[key];
  if (!state) return response(404, { error: { code: "NOT_FOUND", message: `No project ${key}` } });
  if (path === "/v1/git")
    return method === "GET" ? response(200, structuredClone(state)) : undefined;
  if (method !== "POST") return undefined;
  const request = body as GitAction;
  if (DESTRUCTIVE.has(request.action) && !("confirm" in request && request.confirm))
    return response(400, {
      error: {
        code: "INVALID_REQUEST",
        message: `${request.action} discards work; send confirm: true to run it`,
      },
    });
  const result = apply(state, request);
  return response(200, { ...result, output: "", overview: structuredClone(state) });
}
