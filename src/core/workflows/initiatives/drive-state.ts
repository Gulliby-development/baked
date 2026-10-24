/**
 * Whether an initiative has work a drive would do and nothing is driving it (#2024). A decision
 * answered with `baked workflow answer` continues only its run; the initiative advances inside a
 * drive, so after the run stops the initiative sits idle until someone drives it again. This is
 * the one rule every surface reads: `show` and `GET /v1/initiatives/:id` (`drive`), the answer of
 * a decision on a feature run (`initiative.next`), the TUI status and the desktop status.
 */
import type { InitiativeView } from "./service.js";

/** Next steps a drive takes by itself, without a person. */
export const DRIVABLE_NEXT: readonly InitiativeView["next"]["kind"][] = [
  "decompose",
  "finish_decompose",
  "start",
  "rebase",
  "drive",
  "complete",
];

/** The words an idle initiative shows in place of its status. */
export const IDLE_TEXT = "idle: waiting for a drive";

export interface InitiativeDriveState {
  /**
   * `driving`: a drive in this process, or a live process executing one of its runs, advances it.
   * `idle`: work is ready and nothing advances it until a drive starts.
   */
  state: "driving" | "idle";
  /** `driving`, or `idle: waiting for a drive`. */
  text: string;
  /** The command that continues an idle initiative; null while it is driven. */
  command: string | null;
}

/** The command that advances the initiative. */
export const driveCommand = (initiativeId: string): string =>
  `baked workflow initiative drive ${initiativeId}`;

/**
 * The drive state of an initiative, or null when a drive has nothing to do: it waits for a person
 * (a decision, a blocker, a paused initiative) or it is finished. `driving` says whether a drive or
 * a run execution is advancing it now.
 */
export function initiativeDriveState(
  view: Pick<InitiativeView, "initiativeId" | "status" | "next">,
  driving: boolean,
): InitiativeDriveState | null {
  if (view.status !== "active" && view.status !== "decomposing") return null;
  if (!DRIVABLE_NEXT.includes(view.next.kind)) return null;
  return driving
    ? { state: "driving", text: "driving", command: null }
    : { state: "idle", text: IDLE_TEXT, command: driveCommand(view.initiativeId) };
}
