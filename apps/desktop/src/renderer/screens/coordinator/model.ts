import type { ChatMessage } from "../../client/chat.js";
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

/** The dot of a launched item: waiting for a person, running, failed or finished. */
export function launchedTone(view: {
  status: string;
  active: boolean;
}): "ok" | "warn" | "err" | "busy" | "" {
  if (/^waiting/.test(view.status)) return "warn";
  if (/^(failed|cancelled|deleted|blocked)/.test(view.status)) return "err";
  if (view.active) return "busy";
  return /^(completed|done)/.test(view.status) ? "ok" : "";
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
