import {
  CROSS_PLATFORM_OUTCOME,
  crossPlatformCriterionRequired,
  platformsWithoutCi,
} from "./cross-platform.js";
import { isLayoutCriterion, type Spec } from "./schemas.js";

/**
 * A criterion the host's own rules make the spec author write although the request may not name
 * it. The specify rule that asks for it and the analysis rule that keeps it out of scope findings
 * both read this table, so the two prompts cannot contradict each other again (#1765: md-site,
 * bench round 52, ran specify three times, plan and analyze four times, 740k tokens, because
 * analysis raised the required 1280 px criterion as scope the request does not ask for).
 * Each entry states its condition through one predicate, `required`, which the scheduler's filter
 * and the analysis input both read, so a criterion cannot get a different condition in each prompt
 * (#1831: the table said "the request names other operating systems" while the specify note also
 * excluded a request that turns CI down, and analysis demanded what the author was told not to write).
 */
export interface HostRequiredCriterion {
  /** When the host requires it, as the prompts say it. */
  condition: string;
  /** What the criterion states, as the prompts say it. */
  outcome: string;
  /** Whether a criterion's or requirement's text is this criterion. */
  matches: (text: string) => boolean;
  /**
   * Whether the host requires it for this request and workspace, as far as the host can tell
   * before planning; `condition` says the same in words and the prompts read it.
   */
  required: (request: string, root: string) => boolean;
}

const OPERATING_SYSTEMS = [/\bwindows\b/i, /\bmac\s?os\b|\bos x\b|\bdarwin\b/i, /\blinux\b/i];
const CI_MATRIX = /\bmatrix\b|\bruns-on\b|\.github\/workflows|\bci workflow\b/i;

export const VIEWPORT_CRITERION: HostRequiredCriterion = {
  condition:
    "the request adds or changes pages of a graphical or web user interface (a new product with one, or an update whose work changes markup or styles)",
  outcome: "those pages fit a 1280 px wide viewport without horizontal scrolling",
  matches: isLayoutCriterion,
  // Whether the work changes pages is the reader's call from the request and the spec.
  required: () => true,
};

export const CROSS_PLATFORM_CRITERION: HostRequiredCriterion = {
  condition:
    "extra.crossPlatform says the host requires one (the request names CI or other operating systems, or the project already runs CI, and the request does not turn CI down)",
  outcome: CROSS_PLATFORM_OUTCOME,
  matches: (text) =>
    OPERATING_SYSTEMS.filter((os) => os.test(text)).length >= 2 || CI_MATRIX.test(text),
  required: crossPlatformCriterionRequired,
};

export const HOST_REQUIRED_CRITERIA: readonly HostRequiredCriterion[] = [
  VIEWPORT_CRITERION,
  CROSS_PLATFORM_CRITERION,
];

/** The analysis rule: what the host requires is never scope the request does not ask for. */
export const HOST_REQUIRED_ANALYSIS_RULE = `The host's own rules make the spec author add these criteria although the request may not name them: ${HOST_REQUIRED_CRITERIA.map((c) => `when ${c.condition}, a criterion that ${c.outcome}`).join("; ")}. Such a criterion, and the requirement it serves, is never a scope finding; only a defect in its wording or method is a finding. When extra.crossPlatform says the request wants no CI, the host requires no criterion about other operating systems, and a spec without one is never a finding.`;

const SPEC_ID = /\b[A-Z]{1,5}-\d+\b/g;

/**
 * The ids of the spec's criteria and requirements that are host-required: a requirement or
 * criterion whose text matches one of `required`, a criterion that serves only such requirements,
 * and a requirement all of whose criteria are such criteria.
 */
export function hostRequiredIds(
  spec: Pick<Spec, "criteria" | "requirements">,
  required: readonly HostRequiredCriterion[],
): Set<string> {
  const is = (text: string) => required.some((c) => c.matches(text));
  const requirements = new Set(
    (spec.requirements ?? []).filter((r) => is(r.text)).map((r) => r.id),
  );
  const ids = new Set(requirements);
  for (const c of spec.criteria)
    if (
      is(`${c.given}\n${c.when}\n${c.then}`) ||
      (c.requirementIds.length && c.requirementIds.every((id) => requirements.has(id)))
    )
      ids.add(c.id);
  for (const requirement of spec.requirements ?? []) {
    const own = spec.criteria.filter((c) => c.requirementIds.includes(requirement.id));
    if (own.length && own.every((c) => ids.has(c.id))) ids.add(requirement.id);
  }
  return ids;
}

/**
 * Whether a blocking scope finding objects only to host-required criteria: every spec id it cites
 * is one, or it cites none and its own text describes one.
 */
export function objectsToHostRequired(
  finding: { kind: string; blocking: boolean; refs: readonly string[]; description: string },
  ids: ReadonlySet<string>,
  required: readonly HostRequiredCriterion[],
): boolean {
  if (!finding.blocking || finding.kind !== "scope") return false;
  const cited = new Set(
    [...finding.refs, finding.description].flatMap((text) => text.match(SPEC_ID) ?? []),
  );
  if (cited.size) return [...cited].every((id) => ids.has(id));
  return required.some((c) => c.matches(finding.description));
}

/**
 * Whether a blocking scope or coverage finding asks for a criterion about other operating systems
 * (or a CI matrix) that the host does not require because the request turns CI down (#1831:
 * hdrlens freshness, cookies and front, "The request says 'Keep the project cross-platform ...'.
 * FR-008 only requires checks to 'pass on this host'"). The inverse of `objectsToHostRequired`.
 */
export function asksUnrequiredPlatforms(
  finding: { kind: string; blocking: boolean; description: string },
  request: string,
  root: string,
): boolean {
  return (
    finding.blocking &&
    (finding.kind === "scope" || finding.kind === "coverage") &&
    platformsWithoutCi(request, root) &&
    CROSS_PLATFORM_CRITERION.matches(finding.description)
  );
}
