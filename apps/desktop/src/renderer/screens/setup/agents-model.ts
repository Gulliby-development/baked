/**
 * The pure part of the Agents section (#832): which station of the workflow line each agent
 * lands on, the words for a plan, and a free workflow ID. Kept apart from React for tests.
 */
import type { AgentStage, ConvertResult, ProjectAgent } from "../../client/agents.js";

/** The stations an agent can fill, in the order a run reaches them. */
export const STATIONS: { stage: Exclude<AgentStage, "skip">; label: string; does: string }[] = [
  { stage: "research", label: "Research", does: "reads the code first" },
  { stage: "specify", label: "Specify", does: "writes the requirements" },
  { stage: "plan", label: "Plan", does: "splits the work into tasks" },
  { stage: "implement", label: "Implement", does: "builds each task" },
  { stage: "review", label: "Review", does: "reviews the change" },
];

export const STAGE_LABEL: Record<AgentStage, string> = {
  research: "Research",
  specify: "Specify",
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  skip: "Not used",
};

export type Choices = Record<string, AgentStage>;

/** The stage each agent starts with: BAKED's suggestion. */
export const suggested = (agents: readonly ProjectAgent[]): Choices =>
  Object.fromEntries(agents.map((a) => [a.key, a.stage]));

/** The agents on each station, and those left out. */
export function placement(
  agents: readonly ProjectAgent[],
  choices: Choices,
): { byStage: Record<AgentStage, ProjectAgent[]>; unused: ProjectAgent[] } {
  const byStage = {
    research: [],
    specify: [],
    plan: [],
    implement: [],
    review: [],
    skip: [],
  } as Record<AgentStage, ProjectAgent[]>;
  for (const agent of agents) byStage[choices[agent.key] ?? agent.stage].push(agent);
  return { byStage, unused: byStage.skip };
}

/** Why the choices cannot be converted, or null: one agent per station except Review. */
export function choiceProblem(agents: readonly ProjectAgent[], choices: Choices): string | null {
  const { byStage } = placement(agents, choices);
  if (STATIONS.every((s) => byStage[s.stage].length === 0))
    return "Put at least one agent on a station.";
  for (const station of STATIONS) {
    if (station.stage === "review") continue;
    const names = byStage[station.stage].map((a) => a.name);
    if (names.length > 1)
      return `${station.label} takes one agent; ${names.join(" and ")} are both on it.`;
  }
  return null;
}

/** "Plan ← architect · Review ← security-auditor". */
export function planSummary(agents: readonly ProjectAgent[], choices: Choices): string {
  const { byStage } = placement(agents, choices);
  return STATIONS.flatMap((s) => byStage[s.stage].map((a) => `${s.label} ← ${a.name}`)).join(" · ");
}

/** `agents`, or `agents-2` and so on when a workflow already has the ID. */
export function freeId(taken: readonly string[], base = "agents"): string {
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

export const isWorkflowId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id);

/** The tools the agents come from: "Claude Code" or "Claude Code and GitHub Copilot". */
export function origins(agents: readonly ProjectAgent[]): string {
  const labels = [...new Set(agents.map((a) => a.sourceLabel))];
  return labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The files a conversion would remove: the converted agents that are whole files. */
export function removable(agents: readonly ProjectAgent[], choices: Choices): ProjectAgent[] {
  return agents.filter((a) => a.removable && (choices[a.key] ?? a.stage) !== "skip");
}

/** One line on what the conversion did. */
export function resultLine(result: ConvertResult): string {
  const used = result.profiles.length + result.gates.length;
  const removed = result.removed.length
    ? ` and removed ${plural(result.removed.length, "agent file")}`
    : "";
  return `Workflow ${result.workflowId} now runs ${plural(used, "agent")} as its steps${removed}.`;
}
