/**
 * Which host tools a task's implementer is offered, decided from the task alone (#2643). One table
 * for the executor's grant, the planner, spec author and analysis instructions, and the plan check
 * that refuses task text naming a tool the task will not get. R87 slackbar T005 (a planned code
 * task) was told to "use the accepted non-persistent run_probe": three implementer sessions of
 * 1.33M tokens each reported the tool missing, and the run blocked.
 *
 * The executor adds the conditions that are not the task's (the profile allows the tool, the run
 * has a check program to start, the findings carry repros); a task this table refuses a tool never
 * gets it, whatever those say. A new host tool whose grant depends on the task adds its row here.
 */
import { writesDocumentation } from "../verification/repro.js";
import type { Task } from "./types.js";

/** The fields of a task its tool grant reads. */
export type ToolGrantTask = Pick<Task, "origin" | "writes" | "findingIds">;

export interface TaskToolRow {
  name: string;
  /** Whether a task of this shape is offered the tool. */
  offered: (task: ToolGrantTask) => boolean;
  /** Who has the tool, for the planning instructions and the plan check's remedy. */
  holders: string;
}

export const TASK_TOOLS: readonly TaskToolRow[] = [
  {
    name: "run_probe",
    // A planned task that writes documentation runs the examples it documents (#716).
    offered: (task) => task.origin !== "planned" || writesDocumentation(task.writes),
    holders: "a correction of a failing check or a finding, or a task that writes documentation",
  },
  {
    name: "run_repro",
    // A correction runs the repros of its findings the way the host checks them at submit (#1283).
    offered: (task) => task.origin !== "planned" && task.findingIds.length > 0,
    holders: "a correction of review findings",
  },
  {
    name: "write_test",
    offered: () => false,
    holders: "the acceptance writer",
  },
];

/** The host tools of `TASK_TOOLS` a task is offered. */
export function toolsOfferedTo(task: ToolGrantTask): Set<string> {
  return new Set(TASK_TOOLS.filter((row) => row.offered(task)).map((row) => row.name));
}

/** A planned code task: what the planner writes for an implementer. */
const PLANNED_CODE: ToolGrantTask = {
  origin: "planned",
  writes: [{ path: "src/main", action: "create" }],
  findingIds: [],
};

/**
 * One sentence for the planner, spec author and analysis instructions: the tools a planned code
 * task does not have, and where a case that test rows cannot hold goes instead.
 */
export function plannedTaskToolsRule(): string {
  const missing = TASK_TOOLS.filter((row) => !row.offered(PLANNED_CODE));
  return `A planned task that writes code is not offered these host tools: ${missing.map((row) => `${row.name} (only ${row.holders})`).join("; ")}. Never write a task, check or verification that needs one of them; put a case that test rows cannot hold (raw bytes on standard input, a signal, a timing) in a test row that starts the program, a check the plan documents, or an open question.`;
}

/** Whether a text tells its reader to use a tool, by the tool's name. */
function names(text: string, tool: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Plan problems of a task whose text names a host tool the task will not be offered (#2643): its
 * implementer would end unfinished on the missing tool, attempt after attempt. On by default: it
 * only refuses a plan the planner can correct in place.
 */
export function taskToolProblems(graph: {
  tasks: readonly (ToolGrantTask & Pick<Task, "id" | "title" | "description" | "rationale">)[];
}): string[] {
  return graph.tasks.flatMap((task) => {
    const text = [task.title, task.description, task.rationale].join("\n");
    const offered = toolsOfferedTo(task);
    const missing = TASK_TOOLS.filter((row) => !offered.has(row.name) && names(text, row.name));
    if (!missing.length) return [];
    return [
      `Task ${task.id} tells its implementer to use ${missing.map((row) => row.name).join(", ")}, which it will not be offered (${missing.map((row) => `${row.name} only for ${row.holders}`).join("; ")}). Take the tool out of the task's title, description and rationale, and put the case it was for in a test row that starts the program, a check the plan documents, or an open question in the plan's Risks.`,
    ];
  });
}
