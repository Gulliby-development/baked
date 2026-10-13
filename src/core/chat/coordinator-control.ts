/**
 * Stopping and closing what the project coordinator launched. Stopping interrupts a session's
 * turn, cancels a run, or pauses an initiative (an initiative has no cancel); closing marks the
 * brief's entry closed, so it is no longer followed or counted toward `coordinator.maxActive`, and
 * archives a launched session out of the ordinary session list. The coordinator's tools ask the
 * person before cancelling a run or pausing an initiative; the front ends ask on their own.
 */
import { tool } from "ai";
import { z } from "zod";
import { BriefStore, type LaunchedEntry, launchedKey } from "./coordinator.js";
import { liveState, type ProjectLauncher } from "./coordinator-launch.js";
import type { ProjectStateSource } from "./project-state.js";
import { ChatError, type ChatService, type ChatSession } from "./sessions.js";

export const CONTROL_TOOLS = ["stop_launched", "close_launched"] as const;

/** Which launched item an action is for; `feature` names one feature of an initiative. */
export const LaunchedRefSchema = z.strictObject({
  kind: z.enum(["session", "run", "initiative"]),
  id: z.string().trim().min(1).max(200),
  feature: z.string().trim().min(1).max(200).optional(),
});
export type LaunchedRef = z.infer<typeof LaunchedRefSchema>;

function entryOf(store: BriefStore, ref: LaunchedRef): LaunchedEntry {
  const key = launchedKey(ref);
  const entry = store.read().launched.find((e) => launchedKey(e) === key);
  if (!entry)
    throw new ChatError(
      "NOT_FOUND",
      `The coordinator launched no ${ref.kind} ${ref.id}${ref.feature ? ` feature ${ref.feature}` : ""}`,
    );
  return entry;
}

const label = (ref: LaunchedRef): string =>
  ref.feature ? `feature ${ref.feature} of initiative ${ref.id}` : `${ref.kind} ${ref.id}`;

const PAUSED = /^paused/;

/**
 * What a front end offers for a launched item: stop while it runs, close once it is finished or
 * paused (a paused run or initiative holds nothing), nothing once it is closed.
 */
export function launchControl(item: {
  status: string;
  active: boolean;
  closed?: true;
}): "stop" | "close" | null {
  if (item.closed) return null;
  return item.active && !PAUSED.test(item.status) ? "stop" : "close";
}

/** What stopping the item does, for the coordinator's confirmation and the front ends. */
export function stopEffect(ref: LaunchedRef): string {
  if (ref.kind === "session") return `Stop the running turn of session ${ref.id}`;
  if (ref.kind === "run") return `Cancel workflow run ${ref.id}; a cancelled run cannot resume`;
  return `Pause initiative ${ref.id} and its running feature runs`;
}

/**
 * Stops a launched item: interrupts a session's turn, cancels a run, or pauses an initiative (a
 * feature's whole initiative). Returns what happened.
 */
export async function stopLaunched(
  chat: ChatService,
  coordinatorId: string,
  state: ProjectStateSource | null,
  launcher: Pick<ProjectLauncher, "cancelRun" | "pauseInitiative"> | null,
  ref: LaunchedRef,
): Promise<string> {
  const entry = entryOf(new BriefStore(chat.workspace, coordinatorId), ref);
  if (entry.closed) throw new ChatError("INVALID_REQUEST", `${label(ref)} is closed`);
  if (!liveState(chat, state, entry).active)
    throw new ChatError("INVALID_REQUEST", `${label(ref)} is not running`);
  if (entry.kind === "session") {
    if (!chat.get(entry.id).interrupt())
      throw new ChatError("INVALID_REQUEST", `Session ${entry.id} has no running turn`);
    return `Stopped the turn of session ${entry.id}`;
  }
  if (entry.kind === "run") {
    if (!launcher?.cancelRun)
      throw new ChatError("INVALID_REQUEST", "This front end cannot cancel workflow runs");
    await launcher.cancelRun(entry.id);
    return `Cancelled run ${entry.id}`;
  }
  if (!launcher?.pauseInitiative)
    throw new ChatError("INVALID_REQUEST", "This front end cannot pause initiatives");
  await launcher.pauseInitiative(entry.id);
  return `Paused initiative ${entry.id}; it resumes from its Initiatives screen`;
}

/**
 * Closes a launched item, or with `reopen` brings it back. A closed session is archived. Closing
 * an initiative closes its feature entries too. Refuses an item that is still active, unless it
 * is paused.
 */
export async function closeLaunched(
  chat: ChatService,
  coordinatorId: string,
  state: ProjectStateSource | null,
  ref: LaunchedRef,
  reopen = false,
): Promise<LaunchedEntry[]> {
  const store = new BriefStore(chat.workspace, coordinatorId);
  const entry = entryOf(store, ref);
  if (!reopen) {
    const live = liveState(chat, state, entry);
    // A paused run or initiative holds nothing until someone resumes it, so it may be closed.
    if (live.active && !PAUSED.test(live.status))
      throw new ChatError(
        "INVALID_REQUEST",
        `${label(ref)} is still ${live.status}; stop it before closing it`,
      );
  }
  const matches = (e: LaunchedEntry): boolean =>
    e.kind === ref.kind &&
    e.id === ref.id &&
    (ref.feature === undefined || e.feature === ref.feature);
  const change = (e: LaunchedEntry): LaunchedEntry => {
    if (!matches(e)) return e;
    const { closed: _, ...open } = e;
    return reopen ? open : { ...open, closed: true };
  };
  let launched: LaunchedEntry[] = [];
  // The model may be editing the brief too; retry once on a revision race.
  for (let attempt = 0; ; attempt++) {
    const brief = store.read();
    launched = brief.launched.map(change);
    try {
      store.write({ ...brief, launched }, brief.revision);
      break;
    } catch (err) {
      if (attempt > 0) throw err;
    }
  }
  if (entry.kind === "session") {
    try {
      await chat.get(entry.id).setArchived(!reopen);
    } catch (err) {
      // A deleted session has nothing to archive.
      if (!(err instanceof ChatError && err.code === "NOT_FOUND")) throw err;
    }
  }
  return launched.filter(matches);
}

const Input = LaunchedRefSchema.extend({
  why: z.string().trim().min(1).max(500).describe("One line on why, for the user"),
});

/** The coordinator's tools for stopping and closing what it launched. */
export function controlTools(
  chat: ChatService,
  coordinator: ChatSession,
  state: ProjectStateSource | null,
  launcher: ProjectLauncher | null,
) {
  const result = async (run: () => Promise<string>) => {
    try {
      return { success: true, output: await run() };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  return {
    stop_launched: tool({
      description:
        "Stop something you launched that is still active: interrupt a session's turn, cancel a workflow run (it cannot resume), or pause an initiative. The user is asked before a run is cancelled or an initiative paused. Give kind and id as in the brief's launched list.",
      inputSchema: Input,
      execute: async ({ why, ...ref }: z.infer<typeof Input>) =>
        result(async () => {
          if (ref.kind !== "session" && !(await coordinator.confirm(`${stopEffect(ref)}: ${why}`)))
            return `The user kept ${label(ref)} running`;
          return stopLaunched(chat, coordinator.id, state, launcher, ref);
        }),
    }),
    close_launched: tool({
      description:
        "Close a launched item that is finished or no longer needed: it leaves the active list, stops counting toward your limits, and a closed session leaves the user's session list (it still opens from here). Stop an active item first.",
      inputSchema: LaunchedRefSchema,
      execute: async (ref: LaunchedRef) =>
        result(async () => {
          await closeLaunched(chat, coordinator.id, state, ref);
          return `Closed ${label(ref)}`;
        }),
    }),
  };
}
