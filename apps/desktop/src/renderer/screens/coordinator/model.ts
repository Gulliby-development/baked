import type { ChatMessage, LaunchNote } from "../../client/chat.js";
import type {
  BriefList,
  FlowTask,
  LaunchedEntry,
  ProjectBrief,
  RunProgress,
} from "../../client/coordinator.js";
import type { StageLook } from "../../components/WorkflowStages.js";
import { projectHref } from "../../router.js";

/** What Edit on a split card puts into the composer: the change goes back to the coordinator. */
export const SPLIT_EDIT_PREFIX = "Change the split: ";

export const BRIEF_TITLES: Record<BriefList, string> = {
  decisions: "Decisions",
  conventions: "Conventions",
  openQuestions: "Open questions",
};

/** The longest brief line the server takes. */
export const BRIEF_LINE_MAX = 1000;

/** The coordinator message that hands an ordinary chat's request over. */
export function handOffText(title: string, messages: readonly ChatMessage[]): string {
  const ask = [...messages].reverse().find((m) => m.role === "user" && m.content.trim());
  const request = ask?.content.trim() ?? "";
  return request
    ? `Take over this request from the chat "${title}":\n\n${request}`
    : `Take over the work of the chat "${title}".`;
}

/** Where a launched item opens in the app. */
export function launchedHref(key: string, entry: Pick<LaunchedEntry, "kind" | "id">): string {
  const section = entry.kind === "session" ? "chat" : entry.kind === "run" ? "runs" : "initiatives";
  return projectHref(key, section, entry.id);
}

/** A task as the panel names it: `#N` for an issue, `local task` otherwise. */
export function taskLabel(task: FlowTask): string {
  if (task.state === "local") return "local task";
  const number = /#(\d+)$/.exec(task.ref)?.[1];
  return number ? `#${number}${task.state === "closed" ? " (closed)" : ""}` : task.ref;
}

/** The brief with one list replaced: lines trimmed, empty ones dropped, each cut to the limit. */
export function withList(
  brief: ProjectBrief,
  list: BriefList,
  lines: readonly string[],
): ProjectBrief {
  return {
    ...brief,
    [list]: lines.map((line) => line.trim().slice(0, BRIEF_LINE_MAX)).filter(Boolean),
  };
}

export type LaunchTone = "ok" | "warn" | "err" | "busy" | "";

/** The dot of a launched item: waiting for a person, running, failed or finished. */
export function launchedTone(view: { status: string; active: boolean }): LaunchTone {
  if (/^waiting/.test(view.status)) return "warn";
  if (/^(failed|cancelled|deleted|blocked)/.test(view.status)) return "err";
  if (view.active) return "busy";
  return /^(completed|done)/.test(view.status) ? "ok" : "";
}

/** The tone of a notice: a merged task and a finished item are good news, the rest by status. */
export function noteTone(note: LaunchNote): LaunchTone {
  if (note.event === "task-closed") return "ok";
  return launchedTone({ status: note.status, active: !/^(completed|done)/.test(note.status) });
}

const KIND_LABELS: Record<LaunchNote["kind"], string> = {
  session: "Session",
  run: "Run",
  initiative: "Initiative",
};

/** The small label above a launched item's name: its kind, or the feature's initiative. */
export function launchKind(item: Pick<LaunchNote, "kind" | "id" | "feature">): string {
  return item.feature ? `Feature of ${item.id}` : (KIND_LABELS[item.kind] ?? item.kind);
}

/** A session's id is a UUID nobody reads; its first block is enough to tell two apart. */
const shortId = (id: string): string =>
  /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? id.slice(0, 8) : id;

/** A launched item's name: its title, the feature, or a short id when it has neither. */
export function launchName(item: Pick<LaunchNote, "id" | "feature" | "title">): string {
  return item.title ?? item.feature ?? shortId(item.id);
}

/** Why the item was launched, unless that only repeats its name. */
export function launchWhy(item: Pick<LaunchNote, "why" | "title">): string {
  return item.title && item.why.startsWith(item.title) ? "" : item.why;
}

/** How each stage of a launched run looks; a run that stopped marks the stage it stopped in. */
export function stageLooks(progress: RunProgress, active: boolean): StageLook[] {
  return progress.stages.map((stage) => {
    switch (stage.status) {
      case "completed":
        return "done";
      case "skipped":
      case "invalidated":
        return "skipped";
      case "failed":
        return "failed";
      case "waiting":
        return "waiting";
      case "running":
        return active ? "current" : "failed";
      case "interrupted":
        return active && stage.id === progress.stage ? "current" : "failed";
      default:
        return active && stage.id === progress.stage ? "current" : "ahead";
    }
  });
}

/** The stage a launched run is at, as one short line: `Stage 2 of 5: plan · tasks 3/7`. */
export function stageLine(progress: RunProgress): string {
  const index = progress.stage ? progress.stages.findIndex((s) => s.id === progress.stage) : -1;
  const done = progress.stages.filter((s) => s.status === "completed").length;
  const where =
    index >= 0
      ? `Stage ${index + 1} of ${progress.stages.length}: ${progress.stage}`
      : `${done} of ${progress.stages.length} stages done`;
  return progress.tasks.total
    ? `${where} · tasks ${progress.tasks.done}/${progress.tasks.total}`
    : where;
}

/** The prefix the coordinator's `message_session` puts before what it sends a launched session. */
const COORDINATOR_PREFIX = "Message from the project coordinator:\n\n";

/** The text of a message the coordinator sent this session, or null for the person's own. */
export function fromCoordinator(content: string): string | null {
  return content.startsWith(COORDINATOR_PREFIX) ? content.slice(COORDINATOR_PREFIX.length) : null;
}
