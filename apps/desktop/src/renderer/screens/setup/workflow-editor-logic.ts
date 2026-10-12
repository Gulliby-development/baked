import type { GateTarget, Outcome, ProblemGroup, StageView } from "../../client/workflow-editor.js";

const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "passed",
  failed: "failed",
  changes_requested: "changes requested",
};
export const outcomeLabel = (outcome: Outcome): string => OUTCOME_LABEL[outcome];

/** A stable key for a gate list: the stage's own gates, or a transition. */
export const targetKey = (target: GateTarget): string =>
  target.kind === "stage" ? `stage:${target.stageId}` : `transition:${target.id}`;

/**
 * The problems to show on a stage's card: those of the stage and of its outgoing transitions,
 * each transition message prefixed with the transition it names.
 */
export function problemsFor(groups: readonly ProblemGroup[], stage: StageView): string[] {
  const transitions = new Set(
    stage.targets.flatMap((t) => (t.target.kind === "transition" ? [t.target.id] : [])),
  );
  return groups.flatMap((g) => {
    if (g.owner === `stage ${stage.id}`) return g.messages;
    const id = g.owner.startsWith("transition ") ? g.owner.slice("transition ".length) : null;
    return id && transitions.has(id) ? g.messages.map((m) => `${id}: ${m}`) : [];
  });
}
