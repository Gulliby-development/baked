/**
 * The Git menu over the local API (`/v1/git`): the project's status, branches, stashes and recent
 * commits, and the actions of the terminal Git menu. Core logic lives in src/core/git/menu.ts.
 * Writes wait for each other, are refused while a workflow run holds the workspace, and the
 * destructive ones (force push with lease, hard reset) need `confirm: true`, the API's form of
 * the terminal's confirmation prompt.
 */
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import {
  BRANCH_NAME_MAX,
  COMMIT_MESSAGE_MAX,
  DESTRUCTIVE_GIT_ACTIONS,
  type GitMenuAction,
  readGitOverview,
  runGitMenuAction,
  STASH_MESSAGE_MAX,
} from "../git/menu.js";
import { isGitRepo } from "../git/status.js";
import { leaseOwnerAlive } from "../workflows/leases.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RouteContext } from "./route-context.js";

export interface GitRouteContext extends RouteContext {
  workspace: string;
  config: AppConfig;
  store: WorkflowStore;
  /** Chains the server's Git writes so two never run at once. */
  queue: { tail: Promise<unknown> };
}

const Confirm = { confirm: z.boolean().optional() };
const Name = z.string().min(1).max(BRANCH_NAME_MAX);
const ActionBody = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("commit"),
    message: z.string().min(1).max(COMMIT_MESSAGE_MAX),
    stageAll: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("push") }),
  z.strictObject({ action: z.literal("pull") }),
  z.strictObject({
    action: z.literal("stash"),
    message: z.string().max(STASH_MESSAGE_MAX).optional(),
  }),
  z.strictObject({ action: z.literal("stash-pop") }),
  z.strictObject({ action: z.literal("create-branch"), name: Name }),
  z.strictObject({ action: z.literal("switch-branch"), name: Name }),
  z.strictObject({ action: z.literal("force-push"), ...Confirm }),
  z.strictObject({ action: z.literal("reset-hard"), ...Confirm }),
]);

function workspaceHeld(store: WorkflowStore): boolean {
  return (["execution", "mutation"] as const).some((resource) => {
    const lease = store.lease(resource);
    return lease !== null && leaseOwnerAlive(lease) !== false;
  });
}

/** The request without `confirm` and unset optional fields, as `runGitMenuAction` takes it. */
function toAction(body: z.infer<typeof ActionBody>): GitMenuAction {
  switch (body.action) {
    case "commit":
      return {
        action: "commit",
        message: body.message,
        ...(body.stageAll !== undefined ? { stageAll: body.stageAll } : {}),
      };
    case "stash":
      return { action: "stash", ...(body.message !== undefined ? { message: body.message } : {}) };
    case "create-branch":
    case "switch-branch":
      return { action: body.action, name: body.name };
    default:
      return { action: body.action };
  }
}

/** Answers a Git request, or returns null when the path is not a Git endpoint. */
export async function gitRoute(ctx: GitRouteContext): Promise<Response | null> {
  const { path, workspace } = ctx;
  if (path === "/v1/git") {
    ctx.only("GET");
    return ctx.json(200, { ...(await readGitOverview(workspace)), busy: workspaceHeld(ctx.store) });
  }
  if (path !== "/v1/git/actions") return null;
  ctx.only("POST");
  const body = ActionBody.parse(await ctx.readJson());
  if (DESTRUCTIVE_GIT_ACTIONS.includes(body.action) && !("confirm" in body && body.confirm))
    ctx.fail(400, "INVALID_REQUEST", `${body.action} discards work; send confirm: true to run it`);
  const step = ctx.queue.tail.then(async () => {
    if (!(await isGitRepo(workspace)))
      ctx.fail(409, "NOT_A_REPOSITORY", "The project folder is not a Git repository");
    if (workspaceHeld(ctx.store))
      ctx.fail(
        409,
        "WORKSPACE_BUSY",
        "A workflow run holds the workspace. Pause it, or use Git after it finishes.",
      );
    return runGitMenuAction(workspace, toAction(body), {
      coAuthor: ctx.config.coAuthorCommits !== false,
    });
  });
  ctx.queue.tail = step.catch(() => undefined);
  const result = await step;
  return ctx.json(200, {
    ...result,
    overview: { ...(await readGitOverview(workspace)), busy: workspaceHeld(ctx.store) },
  });
}
