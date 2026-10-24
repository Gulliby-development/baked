import type { AgentProfile } from "../../workflows/schemas.js";

/**
 * What the test-integrity guard (#631) tells the agents, appended to their instructions. It lives
 * here rather than in the instruction strings of builtin.ts so that edits to those strings and to
 * these rules do not collide; the profile registry applies them to the built-in profiles.
 */
const RULES: Record<string, string> = {
  planner:
    'Tests that already exist are read-only for implementers: a task that must modify or delete one gives that write a reason ("reason": why the test must change, such as a behavior the request removes), which the approval shows.',
  "quick-planner":
    "Existing tests are read-only for implementers: a write that modifies or deletes one needs a reason saying why the test must change.",
  implementer:
    'Make the code pass the tests; never delete, skip or weaken a test or an assertion, special-case test inputs, or add suppressions (ts-ignore, eslint-disable, any, type: ignore) to get green. The host checks your diff for these and sends them back. When the spec and a test (or a criterion) cannot both hold, submit outcome spec_conflict, with the test, the requirement and why in summary and unresolved, and each side in conflictSides with its exact words: a criterion or requirement by its id in ref, quoting the spec; the request, quoting its exact words (an example it gives counts); a test by its path in ref. The host checks each quote: when a criterion contradicts what the request states, the request wins without asking; otherwise a person decides. When one side is something the platform cannot do at all (a value a protocol, runtime or library cannot carry or represent), write "platform limit" in summary and name the nearest feasible behavior; under clarification assume the run takes that behavior without asking. When you implement that nearest feasible behavior yourself instead, submit implemented and list each limit in platformLimits, with the claim and the probe or check that showed it, so later reviews do not ask for it again.',
};

export function withTestIntegrityRules(profiles: readonly AgentProfile[]): AgentProfile[] {
  return profiles.map((profile) => {
    const rule = RULES[profile.id];
    return rule
      ? { ...profile, instructions: `${profile.instructions.trimEnd()} ${rule}` }
      : profile;
  });
}
