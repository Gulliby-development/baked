import type { z } from "zod";
import {
  withCommandDependencies,
  withModuleDependencies,
  withReadDependencies,
} from "./plan-consistency.js";
import type { ResearchSchema, Spec, TaskGraph } from "./schemas.js";
import { withTestDependencies } from "./sizing.js";

type Research = z.infer<typeof ResearchSchema>;

/**
 * Helpers for the analysis and clarification loop. Runs of bench round 02 spent about 30 of 48
 * operator actions on it: findings that only counted tasks or files, answers that left the
 * research the analyzer reads unchanged, and non-blocking findings that failed the stage.
 */

/** Counts the host computes from the task graph; models are told not to compare them. */
export function hostCounts(graph: TaskGraph): { tasks: number; files: number } {
  return {
    tasks: graph.tasks.length,
    files: new Set(graph.tasks.flatMap((task) => task.writes.map((write) => write.path))).size,
  };
}

const SPLIT_PART =
  /Sizing split this task by file: write only .*? belong to the other parts of (T\d+)\./;

/**
 * The tasks the host split by file after planning (`splitTestTasks`), keyed by the planned task:
 * the first part keeps the planned ID, the others are new IDs that plan.md cannot name.
 */
export function hostSplitParts(graph: TaskGraph): Record<string, string[]> {
  const parts: Record<string, string[]> = {};
  for (const task of graph.tasks) {
    const original = SPLIT_PART.exec(task.description)?.[1];
    if (!original) continue;
    parts[original] = [...(parts[original] ?? []), task.id];
  }
  return parts;
}

/** What a finding says about the split itself: a part plan.md does not list, or parts that overlap. */
const SPLIT_TOPIC =
  /\b(?:not (?:listed|named|mentioned|described|present|included) in (?:the )?plan(?:\.md)?|(?:missing|absent) from (?:the )?plan(?:\.md)?|plan(?:\.md)? (?:does not|doesn't|never) (?:list|name|mention|describe|include)|not in (?:the )?plan(?:\.md)?|no counterpart|(?:check|test|verif|cover|assert)\w* the same|duplicat\w*|overlap\w*|redundant)\b/i;
/** A finding that says implementing the work fails or contradicts a criterion or requirement. */
const FAILS_CRITERION =
  /\b(?:fails?|failing|violat\w*|contradict\w*|breaks?|conflicts? with|cannot (?:both )?(?:hold|pass|satisfy|meet))\b[^.;]*?\b(?:AC|FR|NFR)-\d+|\b(?:AC|FR|NFR)-\d+\b[^.;]*?\b(?:fails?|is violated|is contradicted|cannot (?:hold|pass))\b/i;

/**
 * A finding about a task the host split: every task it names belongs to one split, at least one
 * is a part plan.md cannot list, and it is about the split itself (cronsay 15eb3204: "T009 is not
 * in plan.md" and "T005 and T009 check the same thing" sent the run back to plan four times). A
 * finding that only names a part is not enough: mdtoc-update 20f81464 F-001 ("AC-007 whitelists
 * four changed files, but FR-005 and task T005 require edits in tests/cli.test.ts, so implementing
 * the request fails AC-007") was demoted because T005 was a split part, and the run implemented a
 * contradictory spec and blocked at converge after 1.19M tokens (#1142).
 */
export function isHostSplitNit(
  finding: { refs: readonly string[]; description: string },
  parts: Record<string, string[]>,
): boolean {
  if (!SPLIT_TOPIC.test(finding.description) || FAILS_CRITERION.test(finding.description))
    return false;
  const named = new Set(
    [...finding.refs, finding.description].flatMap((text) => text.match(/\bT\d{3,}\b/g) ?? []),
  );
  if (!named.size) return false;
  return Object.entries(parts).some(
    ([original, ids]) =>
      ids.some((id) => id !== original && named.has(id)) &&
      [...named].every((id) => ids.includes(id)),
  );
}

/**
 * The `dependsOn` edges of the stored graph that the host adds whatever the planner wrote: a
 * module index after the module files, a reader after the writer of its read hint, a test after
 * the code sharing its criterion, a docs task that runs the program after its entry points. The planner cannot remove them, so the analyzer must not ask
 * for that (bench round 10, dirdrift: one dependency finding came back in 4 of 7 analysis passes).
 */
export function hostDependencyEdges(
  graph: TaskGraph,
  spec?: Pick<Spec, "requirements" | "criteria">,
): Array<{ task: string; dependsOn: string }> {
  const bare = { ...graph, tasks: graph.tasks.map((task) => ({ ...task, dependsOn: [] })) };
  const derived = withTestDependencies(
    withCommandDependencies(withReadDependencies(withModuleDependencies(bare)), spec),
  );
  return derived.tasks.flatMap((task) => {
    const stored = graph.tasks.find((t) => t.id === task.id)?.dependsOn ?? [];
    return task.dependsOn
      .filter((dep) => stored.includes(dep))
      .map((dependsOn) => ({ task: task.id, dependsOn }));
  });
}

/**
 * A dependency finding about edges the host owns: it is about dependencies and every task it
 * names is joined to another named task by a host edge.
 */
export function isHostEdgeNit(
  finding: { refs: readonly string[]; description: string },
  edges: ReadonlyArray<{ task: string; dependsOn: string }>,
  taskIds: readonly string[],
): boolean {
  const text = [...finding.refs, finding.description].join(" ");
  if (!/depend|edge|order/i.test(text)) return false;
  const named = taskIds.filter((id) =>
    new RegExp(
      `(?:^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
    ).test(text),
  );
  if (named.length < 2) return false;
  const joined = (id: string) =>
    edges.some(
      (e) =>
        (e.task === id && named.includes(e.dependsOn)) ||
        (e.dependsOn === id && named.includes(e.task)),
    );
  return named.every(joined);
}

const COUNT = /\b\d+\s+(?:distinct\s+|unique\s+|code\s+)?(?:tasks?|files?)\b/gi;
const COUNT_CONTEXT =
  /\b(says|states|claims|lists|shows|counts|reports|declares|mentions|has|have|contains|totals?)\b/i;

/**
 * A finding whose substance is a task or file count mismatch ("plan says 8 tasks, graph has 9").
 * The host knows both numbers, so such a finding is a note: at least two counts and no other
 * defect named (no requirement, criterion or task ID that is not part of the count).
 */
export function isCountNit(description: string): boolean {
  const counts = description.match(COUNT) ?? [];
  if (counts.length < 2 || !COUNT_CONTEXT.test(description)) return false;
  const numbers = new Set(counts.map((count) => count.match(/\d+/)?.[0]));
  if (numbers.size < 2) return false;
  const rest = description.replace(COUNT, " ");
  return !/\b(FR|NFR|AC|SC)-\d+/.test(rest) && !/\bT\d{3,}\b/.test(rest);
}

/** The verification methods the spec schema allows (schemas.ts). */
export const VERIFICATION_METHODS = ["automated", "manual", "post-release"] as const;

const OTHER_METHOD =
  /\b(inspection|demonstration|analysis|review|reviewer[- ]inspection|visual[- ]inspection)\b[\s'"`]*(?:verification\s+)?method\b|\b(?:method|verification)\s+(?:to\s+|of\s+|=\s*|:\s*)?['"`]?(inspection|demonstration|review|reviewer[- ]inspection|visual[- ]inspection)\b/i;

/**
 * A finding that asks for a verification method the spec schema cannot hold ("set both to the
 * schema's inspection method"). The spec author cannot satisfy it, so it returns the spec until a
 * person settles it (#1065, indentree: 4 returns and 2 questions). Automated already covers the
 * reviewer reading a file.
 */
export function asksUnsupportedMethod(description: string): boolean {
  const match = description.match(OTHER_METHOD);
  if (!match) return false;
  const named = (match[1] ?? match[2] ?? "").toLowerCase();
  return !(VERIFICATION_METHODS as readonly string[]).includes(named);
}

/**
 * Marks research statements as superseded by an answer to an analysis clarification, so the
 * analyzer stops reading the fact the answer contradicts. The statement names the finding the
 * person answered and the answer; the research text it contradicts is left in place, flagged as
 * stale by the new fact at the top.
 */
export function supersedeResearch(
  research: Research,
  findings: readonly { id?: unknown; description?: unknown }[],
  answers: Readonly<Record<string, string>>,
): Research {
  const facts = Object.entries(answers).map(([key, answer]) => {
    const finding = findings.find((f) => f.id === key);
    const about =
      finding && typeof finding.description === "string"
        ? ` to "${finding.description.slice(0, 300)}"`
        : "";
    return {
      statement: `Superseded by the user's answer${about} (${key}): ${answer.slice(0, 1000)}. Any earlier research statement that contradicts this answer is stale; do not raise it again.`,
      paths: [],
    };
  });
  return { ...research, facts: [...facts, ...research.facts] };
}

const RESTRICTS =
  /\b(restrict\w*|narrow\w*|exclud\w*|limit(?:s|ed|ing|ation)?|reject\w*|out[- ]of[- ]scope|outOfScope|unrequested|not requested|stricter|only (?:supports?|accepts?|allows?))\b/i;
const DROPS =
  /\b(omits?|omitted|drops?|dropped|missing|uncovered|not covered|no (?:task|criterion|requirement|test) (?:covers?|implements?|exercises?)|does not (?:cover|implement|mention))\b/i;
/**
 * A drop that is the effect of the spec's own exclusion ("assumptions exclude inputs outside the
 * stated test domains, which drops required rejection cases"): the fix is deleting the exclusion,
 * so the finding is a restriction the request settles, not a request clause the spec left out
 * (#1159, cfgtrace a657dc4d: one intervention under assume).
 */
const EXCLUSION_DROPS =
  /\b(?:exclu\w*|restrict\w*|narrow\w*|limit(?:s|ed|ing)?|out[- ]of[- ]scope|outOfScope)\b[^.;]*?(?:,\s*|\s+)(?:which|that|thereby|so (?:it|they|this)|and (?:so|thus))\s+(?:\w+\s+){0,2}?(?:drops?|dropped|omits?|omitted|removes?|removed|loses?|lost)\b/gi;
/** Wording of a finding that says the spec adds something the request never asked for. */
const ADDS =
  /\b(?:(?:request|brief|prompt|user)\s+(?:does not|doesn't|did not|never)\s+(?:ask|request|require|mention|state|contain|include|name)\w*|not (?:asked|requested|required|mentioned|stated) (?:for )?(?:by|in) the (?:request|brief)|absent from the (?:request|brief)|beyond (?:the|what the) (?:request|brief)|invent\w*|added scope|scope (?:creep|expansion))\b/i;

/**
 * A scope finding that says the spec adds a restriction (a domain, a rejected form, an exclusion)
 * the request does not state. The request is authoritative for it: the spec author removes the
 * restriction, and one that survives is recorded as an assumption rather than asked about
 * (bench round 06: input domains from the spec author's profile raised such findings in 5 of 10
 * runs and 3 waited for a person whose answer was always the request's own wording). The host's
 * own coverage finding and findings that name a dropped request clause still ask. A finding that
 * says the spec adds a requirement the request never asked for (bench round 14: a CI matrix on
 * Windows, macOS and Linux in 3 of 3 controls, two clarification requests under assume) is the
 * same case: the request wins and the addition is removed.
 */
/**
 * Wording of a finding that sets the spec against what the request itself states ("the request
 * allows it", "the brief's explicit ban"): the request settles it.
 */
const SETTLES =
  /\b(?:request|brief)(?:'s)?\s+(?:explicitly\s+|clearly\s+)?(?:allows?|permits?|states?|says|specifies|requires?|asks?|names?|bans?|forbids?|excludes?|includes?|defines?|accepts?|treats?)\b|\b(?:request|brief)'s\s+(?:explicit|stated)\b/i;

/**
 * An `inconsistency` finding whose one side is the request (cfgtrace 832775c7, bench round 15: a
 * spec assumption excludes `tests/**`, the request allows it). It is not a defect between two
 * artifacts to fix both ways: the request wins, like a restriction it lacks.
 */
/** Whether a conflict report names what the request itself states as one of its sides. */
export const namesRequestSide = (text: string): boolean => SETTLES.test(text);

/**
 * A documentation task's report that the rule for examples (run the command, never invent its
 * output) stands against a worked example the request gives (#992, dirdrift 120a6a97: "FR-001 needs
 * the five-line worked example in the README, but the implementer instruction forbids writing
 * example output from the spec").
 */
const EXAMPLE_RULE =
  /\b(?:example|sample)[- ]output\b|\bworked\s+example\b|\b(?:request|brief|spec)'s\b[^.]*\bexamples?\b|\boutput\s+(?:block|example)\b|\bexample\b[^.]*\b(?:from the (?:spec|request|brief)|run_probe|probe)\b/i;
export const namesExampleRule = (text: string): boolean => EXAMPLE_RULE.test(text);

export function requestSettles(finding: {
  id?: string;
  kind: string;
  blocking: boolean;
  description: string;
}): boolean {
  return (
    finding.blocking &&
    finding.kind === "inconsistency" &&
    !(finding.id ?? "").startsWith("COVERAGE") &&
    SETTLES.test(finding.description)
  );
}

export function restrictsRequest(finding: {
  id?: string;
  kind: string;
  blocking: boolean;
  description: string;
}): boolean {
  if (requestSettles(finding)) return true;
  return (
    finding.blocking &&
    finding.kind === "scope" &&
    !(finding.id ?? "").startsWith("COVERAGE") &&
    (RESTRICTS.test(finding.description) || ADDS.test(finding.description)) &&
    // "The request does not mention CI" names the request, not a clause the spec drops.
    !DROPS.test(
      finding.description.replace(new RegExp(ADDS.source, "gi"), " ").replace(EXCLUSION_DROPS, " "),
    )
  );
}

/** What the host tells the spec author when a scope finding names a restriction the request lacks. */
export const REQUEST_NOTE =
  'The request is authoritative. These findings name restrictions the request does not state (input limits, rejected forms, excluded cases) or requirements, criteria and tasks the request does not ask for (such as CI, a platform matrix or release automation), or contradict what the request states. Delete every such restriction or addition, and change whatever contradicts the request to what it states, from the spec and the plan, with the criteria and tasks that only serve it; a domain you want to keep may be recorded only as a non-narrowing assumption ("<domain> Assumed: <value>, because <reason>."), never as out of scope, a rejected form or an exclusion. Do not trade one restriction for another.';

/** Whether a blocking finding may be settled by a recorded assumption instead of a person. */
export function assumable(finding: { kind: string; blocking: boolean }): boolean {
  // A scope finding says the spec drops what the request asked for; only the person decides that.
  // An inconsistency is a concrete defect in the artifacts (two things that cannot both hold, often
  // with a reproduction), not an open decision: assuming it away only moves it to review, where it
  // returned as a repair loop (md-site: a path collision between two generated files).
  return finding.kind !== "scope" && finding.kind !== "inconsistency";
}

/** Whether a blocking finding is a defect the analysis must see fixed rather than assumed. */
export function persistentDefect(finding: {
  kind: string;
  blocking: boolean;
  description?: string;
}): boolean {
  return (
    finding.blocking &&
    finding.kind === "inconsistency" &&
    !requestSettles({ ...finding, description: finding.description ?? "" })
  );
}

/** What the host tells the spec author when a defect survived the assumption reroute. */
export const DEFECT_NOTE =
  "These findings are concrete inconsistencies that already survived one correction. Do not assume them away and do not weaken the spec to hide them: change the artifacts so that both statements hold (rename, split or reorder), or state in the spec which side is wrong and remove it.";

/**
 * The assumptions the analysis recorded, as known risks for the agents that review the result: an
 * assumption nobody verified is where a defect that analysis could not settle is most likely to be.
 */
export function knownRisks(artifact: string | null): {
  note: string;
  assumed: { id: string; kind: string; refs: string[]; description: string }[];
} | null {
  if (!artifact) return null;
  try {
    const parsed = JSON.parse(artifact) as {
      assumed?: { id?: unknown; kind?: unknown; refs?: unknown; description?: unknown }[];
    };
    const assumed = (parsed.assumed ?? []).flatMap((item) =>
      typeof item.description === "string"
        ? [
            {
              id: String(item.id ?? ""),
              kind: String(item.kind ?? ""),
              refs: Array.isArray(item.refs) ? item.refs.map(String) : [],
              description: item.description.slice(0, 600),
            },
          ]
        : [],
    );
    return assumed.length
      ? {
          note: "The analysis could not settle these findings and recorded them as assumptions. Check the result against each of them first; a failure here is a finding, not an accepted risk.",
          assumed,
        }
      : null;
  } catch {
    return null;
  }
}
