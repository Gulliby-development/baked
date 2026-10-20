import { isLayoutCriterion, type Spec } from "./schemas.js";

/**
 * A criterion the host's own rules make the spec author write although the request may not name
 * it. The specify rule that asks for it and the analysis rule that keeps it out of scope findings
 * both read this table, so the two prompts cannot contradict each other again (#1765: md-site,
 * bench round 52, ran specify three times, plan and analyze four times, 740k tokens, because
 * analysis raised the required 1280 px criterion as scope the request does not ask for).
 */
export interface HostRequiredCriterion {
  /** When the host requires it, as the prompts say it. */
  condition: string;
  /** What the criterion states, as the prompts say it. */
  outcome: string;
  /** Whether a criterion's or requirement's text is this criterion. */
  matches: (text: string) => boolean;
}

const OPERATING_SYSTEMS = [/\bwindows\b/i, /\bmac\s?os\b|\bos x\b|\bdarwin\b/i, /\blinux\b/i];
const CI_MATRIX = /\bmatrix\b|\bruns-on\b|\.github\/workflows|\bci workflow\b/i;

export const VIEWPORT_CRITERION: HostRequiredCriterion = {
  condition:
    "the request adds or changes pages of a graphical or web user interface (a new product with one, or an update whose work changes markup or styles)",
  outcome: "those pages fit a 1280 px wide viewport without horizontal scrolling",
  matches: isLayoutCriterion,
};

export const CROSS_PLATFORM_CRITERION: HostRequiredCriterion = {
  condition:
    "extra.crossPlatform asks for one (the request names CI or other operating systems, or the project already runs CI)",
  outcome: "the product's tests pass on Windows, macOS and Linux",
  matches: (text) =>
    OPERATING_SYSTEMS.filter((os) => os.test(text)).length >= 2 || CI_MATRIX.test(text),
};

export const HOST_REQUIRED_CRITERIA: readonly HostRequiredCriterion[] = [
  VIEWPORT_CRITERION,
  CROSS_PLATFORM_CRITERION,
];

/** The analysis rule: what the host requires is never scope the request does not ask for. */
export const HOST_REQUIRED_ANALYSIS_RULE = `The host's own rules make the spec author add these criteria although the request may not name them: ${HOST_REQUIRED_CRITERIA.map((c) => `when ${c.condition}, a criterion that ${c.outcome}`).join("; ")}. Such a criterion, and the requirement it serves, is never a scope finding; only a defect in its wording or method is a finding.`;

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
