/**
 * The project's Git menu over `/v1/git*` (`git` capability, docs/desktop/api.md "Git"). The
 * actions are those of the terminal Git menu in src/core/git/menu.ts; an older backend answers
 * 404 and the section shows "needs a newer BAKED".
 */
import { call } from "./api.js";
import { GIT_CAPABILITY } from "./capabilities.js";
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
}

export type GitAction =
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

export const git = {
  overview: (key: string) =>
    withCapability(key, GIT_CAPABILITY, () => call<GitOverview>(key, "GET", "/v1/git")),
  run: (key: string, action: GitAction) =>
    call<GitActionAnswer>(key, "POST", "/v1/git/actions", action),
};
