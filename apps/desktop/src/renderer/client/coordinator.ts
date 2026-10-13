import { call } from "./api.js";
import type { SessionDetail, SessionWorktree } from "./chat.js";

/**
 * The project coordinator over `/v1/coordinator*` (docs/desktop/api.md, "Project coordinator").
 * Shapes mirror `src/core/chat/coordinator.ts`.
 */

export type LaunchedKind = "session" | "run" | "initiative";

/** The task a launched item belongs to: an issue (`owner/name#N`) or a local task. */
export interface FlowTask {
  ref: string;
  url?: string;
  state: "open" | "closed" | "local";
}

export interface LaunchedEntry {
  kind: LaunchedKind;
  id: string;
  /** A name a person reads instead of the id: the session's title, the run's request. */
  title?: string;
  why: string;
  status: string;
  /** For a feature of the initiative `id`: the feature, tracked on its own task. */
  feature?: string;
  task?: FlowTask;
}

/** The brief's lists a person edits; `launched` comes from launches. */
export const BRIEF_LISTS = ["decisions", "conventions", "openQuestions"] as const;
export type BriefList = (typeof BRIEF_LISTS)[number];

export interface ProjectBrief {
  revision: number;
  updatedAt: number;
  decisions: string[];
  conventions: string[];
  openQuestions: string[];
  launched: LaunchedEntry[];
}

/** A launched entry as it is now, with whether it still runs and its tokens. */
export interface LaunchedView extends LaunchedEntry {
  active: boolean;
  tokens: number;
  /** A launched session's own worktree and branch. */
  worktree?: SessionWorktree;
}

export const coordinator = {
  /** The project's coordinator session, created on first use. */
  open: (key: string) => call<SessionDetail>(key, "POST", "/v1/coordinator", {}),
  brief: (key: string) => call<ProjectBrief>(key, "GET", "/v1/coordinator/brief"),
  /** Saves the brief; a 409 `STALE_REVISION` means the coordinator changed it meanwhile. */
  saveBrief: (
    key: string,
    brief: Omit<ProjectBrief, "revision" | "updatedAt">,
    expectedRevision: number,
  ) =>
    call<ProjectBrief>(key, "PUT", "/v1/coordinator/brief", {
      decisions: brief.decisions,
      conventions: brief.conventions,
      openQuestions: brief.openQuestions,
      launched: brief.launched,
      expectedRevision,
    }),
  launched: (key: string) =>
    call<{ launched: LaunchedView[] }>(key, "GET", "/v1/coordinator/launched"),
};
