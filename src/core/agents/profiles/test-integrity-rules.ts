import type { AgentProfile } from "../../workflows/schemas.js";

/**
 * What the test-integrity guard (#631) tells the agents, appended to their instructions. It lives
 * here rather than in the instruction strings of builtin.ts so that edits to those strings and to
 * these rules do not collide.
 */
const RULES: Record<string, string> = {
  planner:
    'Tests that already exist are read-only for implementers: a task that must modify or delete one gives that write a reason ("reason": why the test must change, such as a behavior the request removes), which the approval shows.',
  "quick-planner":
    "Existing tests are read-only for implementers: a write that modifies or deletes one needs a reason saying why the test must change.",
  implementer:
    "Make the code pass the tests; never delete, skip or weaken a test or an assertion, special-case test inputs, or add suppressions (ts-ignore, eslint-disable, any, type: ignore) to get green. The host checks your diff for these and sends them back. When the spec and a test (or a criterion) cannot both hold, submit outcome spec_conflict, with the test, the requirement and why in summary and unresolved; a person decides.",
};

export function withTestIntegrityRules(profiles: AgentProfile[]): AgentProfile[] {
  return profiles.map((profile) => {
    const rule = RULES[profile.id];
    return rule
      ? { ...profile, instructions: `${profile.instructions.trimEnd()} ${rule}` }
      : profile;
  });
}
