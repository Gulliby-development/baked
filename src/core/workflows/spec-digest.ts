import { z } from "zod";
import { canonical } from "../specs/hash.js";
import type { AgentProfile, RunPolicy, Spec } from "./schemas.js";
import type { HostTool } from "./types.js";

/**
 * A compact spec for the stages that judge a plan or code against it (#1019). Analyze, review and
 * converge resent the whole spec on every step; a spec whose criteria carry the request's
 * examples as tables (stmtsplit R18: 43 criteria, 53.6 KB) made planning most of a run's cost.
 * Above `SPEC_DIGEST_BYTES` those stages get one line per given, when and then, with the full
 * criterion behind the `read_criterion` host tool, which every provider calls like any other tool.
 */

/** The host tool that returns criteria of the run's spec in full. */
export const READ_CRITERION = "read_criterion";
/** Spec size (canonical JSON bytes) above which the judging stages get the digest. */
export const SPEC_DIGEST_BYTES = 24_000;
/** Characters of a given, when or then kept on its digest line. */
export const DIGEST_LINE_CHARS = 160;
/** Criteria one `read_criterion` call returns at most. */
export const READ_CRITERION_MAX_IDS = 12;

/** Whether a profile judges the plan or the code against the spec: analyze, review, converge. */
export function judgesSpec(profile: Pick<AgentProfile, "context" | "output">): boolean {
  return (
    profile.output === "analysis" ||
    profile.context === "review" ||
    profile.context === "convergence"
  );
}

/**
 * Whether this attempt gets the digest: a judging profile that may call `read_criterion`, a policy
 * that leaves `specDigest` on, and a spec above the threshold. Small specs keep their full text.
 */
export function digestsSpec(
  spec: Spec | null | undefined,
  profile: Pick<AgentProfile, "context" | "output" | "allowedTools">,
  policy: Pick<RunPolicy, "specDigest">,
): spec is Spec {
  return (
    !!spec &&
    policy.specDigest !== "off" &&
    judgesSpec(profile) &&
    profile.allowedTools.includes(READ_CRITERION) &&
    Buffer.byteLength(canonical(spec)) > SPEC_DIGEST_BYTES
  );
}

/**
 * Whether a shortened context (#1244) may send the digest: as `digestsSpec`, at any spec size.
 */
export function mayDigestSpec(
  spec: Spec | null | undefined,
  profile: Pick<AgentProfile, "context" | "output" | "allowedTools">,
  policy: Pick<RunPolicy, "specDigest">,
): spec is Spec {
  return (
    !!spec &&
    policy.specDigest !== "off" &&
    judgesSpec(profile) &&
    profile.allowedTools.includes(READ_CRITERION)
  );
}

/** The first line of a text, cut to `DIGEST_LINE_CHARS`; `cut` tells whether anything was left out. */
function oneLine(text: string): { line: string; cut: boolean } {
  const first = text.split("\n").find((part) => part.trim()) ?? "";
  const trimmed = first.trim();
  const short =
    trimmed.length > DIGEST_LINE_CHARS ? `${trimmed.slice(0, DIGEST_LINE_CHARS - 1)}…` : trimmed;
  return { line: short, cut: short !== text.trim() };
}

/**
 * The spec with every criterion's given, when and then on one line each. A criterion whose text
 * was cut (more lines, an examples table) is marked `full: false`; its whole text comes from
 * `read_criterion`. Everything else in the spec is kept as it is.
 */
export function specDigest(spec: Spec): Record<string, unknown> {
  const criteria = spec.criteria.map((criterion) => {
    const given = oneLine(criterion.given);
    const when = oneLine(criterion.when);
    const then = oneLine(criterion.then);
    return {
      id: criterion.id,
      requirementIds: criterion.requirementIds,
      given: given.line,
      when: when.line,
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the acceptance-criterion contract.
      then: then.line,
      method: criterion.method,
      ...(criterion.property ? { property: criterion.property } : {}),
      full: !(given.cut || when.cut || then.cut),
    };
  });
  return {
    ...spec,
    criteria,
    digest: `This is a digest of spec.json: each criterion's given, when and then is cut to its first line, and criteria with full: false hold more (examples, tables, exact values). Call ${READ_CRITERION} with their ids before you judge them on those details.`,
  };
}

const ReadCriterionInput = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(READ_CRITERION_MAX_IDS) })
  .strict();

/** `read_criterion`: the criteria of the run's spec with these ids, as spec.json holds them. */
export function readCriterionTool(spec: Spec): HostTool {
  return {
    description: `Return acceptance criteria of the run's spec.json in full (given, when, then with every example), by id. Up to ${READ_CRITERION_MAX_IDS} ids per call.`,
    inputSchema: ReadCriterionInput,
    execute: async (input) => {
      const { ids } = ReadCriterionInput.parse(input);
      const byId = new Map(spec.criteria.map((criterion) => [criterion.id, criterion]));
      const missing = ids.filter((id) => !byId.has(id));
      return {
        criteria: ids.flatMap((id) => byId.get(id) ?? []),
        ...(missing.length
          ? { unknown: missing, known: spec.criteria.map((criterion) => criterion.id) }
          : {}),
      };
    },
  };
}
