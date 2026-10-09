/**
 * Revision of a started run's definition (V2-11, section 3 of workflow-v2-design.md). A started
 * run keeps the definition it was frozen with; an operator may replace it only when the run's
 * history still fits the new graph. Pure checks; the service applies an accepted revision.
 */
import type { RuntimeState } from "../types.js";
import type { ContractId, Stage, WorkflowV2 } from "./definition.js";

type Position = NonNullable<RuntimeState["position"]>;

/**
 * The reasons a started run cannot move to `next`, or an empty list. `position` is where the run
 * stands under `current`; `held` are the contracts the run already holds outside stage visits
 * (a host spec, a plan from a package revision). `resumeAt` is the stage the run continues from
 * under `next` once the revision is applied.
 */
export function definitionRevisionProblems(
  current: WorkflowV2,
  next: WorkflowV2,
  position: Position,
  held: readonly ContractId[],
  resumeAt: string,
): string[] {
  const problems: string[] = [];
  if (next.id !== current.id)
    problems.push(
      `A revision keeps the workflow ID ${current.id}; start a new run to use ${next.id}`,
    );
  if ([...next.inputs].sort().join() !== [...current.inputs].sort().join())
    problems.push("A revision cannot change the inputs the run started with");
  const before = new Map(current.stages.map((s) => [s.id, s] as const));
  const after = new Map(next.stages.map((s) => [s.id, s] as const));
  const same = (a: Stage, b: Stage): boolean => a.type === b.type && a.produces === b.produces;

  const here = before.get(position.stageId);
  if (position.stageId === "done") problems.push("The run has finished its last stage");
  else if (here) {
    const there = after.get(here.id);
    if (!there) problems.push(`The current stage ${here.id} is not in the revised definition`);
    else if (!same(here, there))
      problems.push(
        `The current stage ${here.id} changes from ${here.type} producing ${here.produces} to ${there.type} producing ${there.produces}`,
      );
  }
  const visited = Object.entries(position.visits)
    .filter(([id, count]) => count > 0 && id !== position.stageId)
    .map(([id]) => id)
    .sort();
  for (const id of visited) {
    const old = before.get(id);
    if (!old) continue;
    const revised = after.get(id);
    if (!revised) problems.push(`The completed stage ${id} is not in the revised definition`);
    else if (!same(old, revised))
      problems.push(
        `The completed stage ${id} changes from ${old.type} producing ${old.produces} to ${revised.type} producing ${revised.produces}`,
      );
  }
  if (position.total > next.limits.maxStageVisits)
    problems.push(
      `The run has already made ${position.total} stage visits, more than maxStageVisits ${next.limits.maxStageVisits}`,
    );
  if (!after.has(resumeAt)) {
    problems.push(`The run would resume at ${resumeAt}, which the revised definition lacks`);
    return problems;
  }

  // Contracts the run already produced, plus what every path from the resume stage produces
  // before a stage, must cover what that stage consumes.
  const produced = new Set<string>([
    ...current.inputs,
    ...held,
    ...(here && position.outcome ? [here.produces] : []),
    ...visited.flatMap((id) => {
      const stage = before.get(id);
      return stage ? [stage.produces] : [];
    }),
  ]);
  const outgoing = new Map<string, WorkflowV2["transitions"]>();
  for (const t of next.transitions) outgoing.set(t.from, [...(outgoing.get(t.from) ?? []), t]);
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id) || !after.has(id)) return;
    seen.add(id);
    for (const t of outgoing.get(id) ?? []) if (!t.loop) walk(t.to);
    order.push(id);
  };
  walk(resumeAt);
  order.reverse();
  const available = new Map<string, Set<string>>([[resumeAt, produced]]);
  for (const id of order) {
    const stage = after.get(id) as Stage;
    const out = new Set([...(available.get(id) ?? []), stage.produces]);
    for (const t of outgoing.get(id) ?? []) {
      if (t.loop || t.to === "done") continue;
      const known = available.get(t.to);
      available.set(t.to, known ? new Set([...known].filter((c) => out.has(c))) : out);
    }
  }
  for (const id of order)
    for (const needed of (after.get(id) as Stage).consumes)
      if (!available.get(id)?.has(needed))
        problems.push(
          `${id} consumes ${needed}, which the run has not produced and some path from ${resumeAt} does not produce`,
        );
  return problems;
}
