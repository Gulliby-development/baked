import type { ReproOutcome } from "../verification/repro.js";
import { type Repro, ReproSchema, type Spec } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/**
 * Finding chains (#1959): a review that finds one defect class on one symbol one case at a time
 * links each finding to the last with `repeatOf`. R62 md-site spent 73 percent of 11.6M tokens on
 * a six-finding chain on `findDelimitedInline`, each corrective patching the reported input. With
 * `chainRewrite: "on"` the corrective of a chain that reaches `CHAIN_REWRITE_AT` findings rewrites
 * the symbol against the chain's whole battery of repros, and the host runs that battery before
 * the next review round.
 *
 * A chain's key is its file and either the symbol or the defect class (#2048): a reviewer names the
 * class of each finding in `family` ("decimal-context-precision"), and a finding of one family on
 * one file joins the latest earlier finding of that family and file that a correction already
 * addressed, whatever its symbol and its `repeatOf`. R66 expenses-py F2 (`build_report`) and F3
 * (`_share`), both Decimal context precision in report.py, were a chain of one each, and F3's
 * corrective cost 641k tokens; R65 md-site F1 (`findDestinationEnd`) and F3 (`renderInline`) were
 * the same with nested inline constructs.
 */

/** Findings in a `repeatOf` chain on one file and symbol at which the next corrective rewrites it. */
export const CHAIN_REWRITE_AT = 2;
/** Repros one battery holds: the host's battery of a chain and one `run_repro` call. */
export const BATTERY_CASES = 16;
/** The artifact kind of the chain decisions, kept in bench traces for the replay. */
export const CHAIN_KIND = "finding-chain";
/** The decision of each corrective whose findings form a chain: `chains/tasks/<task>.json`. */
export const CHAIN_TASKS_DIR = "chains/tasks/";
/** The host's battery runs before a review round: `chains/battery/<id>.json`. */
export const CHAIN_BATTERY_DIR = "chains/battery/";
/** The sibling probe of a rewrite corrective (#1969): `chains/family/<task>.json`. */
export const CHAIN_FAMILY_DIR = "chains/family/";

/** The last name of a symbol a reviewer reported: `Parser.parseInline()` is `parseInline`. */
export const symbolKey = (symbol: string | null | undefined): string =>
  (symbol ?? "")
    .replace(/\(.*$/s, "")
    .split(/[.:#\s]+/)
    .filter(Boolean)
    .at(-1) ?? "";

export interface ChainFinding {
  id: string;
  file: string | null;
  symbol: string | null;
  /** The defect class the reviewer named (#2048), or null. */
  family: string | null;
  repeatOf: string | null;
  /** The corrective task the run gave the finding, or null while none has corrected it. */
  repairTaskId: string | null;
  claim: string;
  severity: string;
  status: string;
  requirementIds: string[];
  criterionIds: string[];
  repro?: Repro;
}

type FindingLike = {
  id: string;
  file?: string | null;
  symbol?: string | null;
  family?: string | null;
  repeatOf?: string | null;
  claim?: string;
  severity?: string;
  requirementIds?: string[];
  criterionIds?: string[];
  repro?: unknown;
};

/**
 * A family label as the key compares it: lower case, every run of other characters than letters
 * and digits one hyphen (`Decimal context precision` is `decimal-context-precision`), null when
 * nothing is left.
 */
export const familyKey = (family: string | null | undefined): string | null =>
  (family ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || null;

const chainFinding = (
  body: FindingLike,
  status: string,
  repairTaskId: string | null,
): ChainFinding => {
  const repro = ReproSchema.safeParse(body.repro);
  return {
    id: body.id,
    file: body.file ?? null,
    symbol: body.symbol ?? null,
    family: familyKey(body.family),
    repeatOf: body.repeatOf ?? null,
    repairTaskId,
    claim: body.claim ?? "",
    severity: body.severity ?? "medium",
    status,
    requirementIds: body.requirementIds ?? [],
    criterionIds: body.criterionIds ?? [],
    ...(repro.success ? { repro: repro.data } : {}),
  };
};

/** The run's findings by id, in the order they were recorded; `extra` overrides stored bodies. */
export function chainFindings(
  store: WorkflowStore,
  runId: string,
  extra: readonly FindingLike[] = [],
): Map<string, ChainFinding> {
  const all = new Map<string, ChainFinding>();
  for (const row of store.findings(runId))
    all.set(
      row.id,
      chainFinding(
        { ...(JSON.parse(row.body_json) as FindingLike), id: row.id },
        row.status,
        row.repair_task_id,
      ),
    );
  for (const finding of extra) {
    const stored = all.get(finding.id);
    all.set(
      finding.id,
      chainFinding(finding, stored?.status ?? "open", stored?.repairTaskId ?? null),
    );
  }
  return all;
}

/** Same file and family, both named: the family half of the chain key (#2048). */
const sameFamily = (a: ChainFinding, b: ChainFinding): boolean =>
  a.family !== null && a.family === b.family && a.file !== null && a.file === b.file;

/** The chain key: the same file and either the same symbol or the same family (#2048). */
const sameSpot = (a: ChainFinding, b: ChainFinding): boolean =>
  (symbolKey(a.symbol) !== "" &&
    symbolKey(a.symbol) === symbolKey(b.symbol) &&
    (!a.file || !b.file || a.file === b.file)) ||
  sameFamily(a, b);

/**
 * The latest finding recorded before `current` of `start`'s family and file that a correction
 * other than `start`'s already addressed (#2048): the case a family chain links to when the
 * reviewer's `repeatOf` does not. A finding of the same round has no corrective yet, so two
 * cases found together are not a chain.
 */
function familyLink(
  all: ReadonlyMap<string, ChainFinding>,
  current: ChainFinding,
  start: ChainFinding,
  seen: ReadonlySet<string>,
): ChainFinding | undefined {
  if (start.family === null) return undefined;
  let found: ChainFinding | undefined;
  for (const finding of all.values()) {
    if (finding.id === current.id) break;
    if (
      !seen.has(finding.id) &&
      sameFamily(finding, start) &&
      finding.repairTaskId !== null &&
      finding.repairTaskId !== start.repairTaskId
    )
      found = finding;
  }
  return found;
}

/**
 * The chain of a finding on its file and symbol or family, oldest first and the finding last: its
 * `repeatOf` path while each link is on the same spot, and, where that path ends, the latest
 * earlier addressed finding of its family on its file (`familyLink`). A finding without a symbol
 * or a family is a chain of one.
 */
export function findingChain(
  all: ReadonlyMap<string, ChainFinding>,
  start: ChainFinding,
): ChainFinding[] {
  const chain = [start];
  const seen = new Set([start.id]);
  let current = start;
  for (;;) {
    const linked =
      current.repeatOf && !seen.has(current.repeatOf) ? all.get(current.repeatOf) : undefined;
    const earlier =
      linked && sameSpot(linked, start) ? linked : familyLink(all, current, start, seen);
    if (!earlier) break;
    chain.unshift(earlier);
    seen.add(earlier.id);
    current = earlier;
  }
  return chain;
}

/**
 * Every finding on the chain's file and symbol or family linked to it by `repeatOf`, in the order
 * they were recorded: the chain and its side branches (R62 md-site F4-2 repeated F3 beside F4).
 */
export function chainMembers(
  all: ReadonlyMap<string, ChainFinding>,
  chain: readonly ChainFinding[],
): ChainFinding[] {
  const head = chain.at(-1);
  if (!head) return [];
  const ids = new Set(chain.map((f) => f.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const finding of all.values())
      if (
        !ids.has(finding.id) &&
        finding.repeatOf &&
        ids.has(finding.repeatOf) &&
        sameSpot(finding, head)
      ) {
        ids.add(finding.id);
        grew = true;
      }
  }
  return [...all.values()].filter((f) => ids.has(f.id));
}

/** Whether the next corrective of a chain of `length` findings rewrites the symbol. */
export type ChainRule = (length: number, policy: "on" | "off") => "rewrite" | "patch";
export const chainRewriteDecision: ChainRule = (length, policy) =>
  policy === "on" && length >= CHAIN_REWRITE_AT ? "rewrite" : "patch";

/** Whether a battery's case outcomes reopen the chain's corrective before the review. */
export type BatteryRule = (statuses: readonly ReproOutcome["status"][]) => "pass" | "reopen";
export const batteryDecision: BatteryRule = (statuses) =>
  statuses.includes("reproduced") ? "reopen" : "pass";

/**
 * Whether a case of a chain's sibling probe joins the battery (#1969). The host runs each case as a
 * repro whose actual is its expected value: `reproduced` is a case the code already gets right,
 * `refuted` one that ran and printed something else (a member of the class), `inconclusive` one
 * that could not show either (a crash, a program no check starts), which is left out.
 */
export type FamilyRule = (status: ReproOutcome["status"]) => "join" | "skip";
export const familyDecision: FamilyRule = (status) => (status === "refuted" ? "join" : "skip");

/** What `chains/family/<task>.json` records: each probed case's outcome and whether it joined. */
export interface FamilyRecord {
  schemaVersion: 1;
  taskId: string;
  findingId: string;
  file: string | null;
  symbol: string;
  /** The chain's cases the probe was shown, by finding id. */
  shown: string[];
  cases: {
    status: ReproOutcome["status"];
    reason: string;
    /** A joined case is a finding with this record as its evidence and `repeatOf` the finding. */
    decision: "join" | "skip";
  }[];
}

/** The observed value of a probed case: its output's last non-empty line, or "" for none. */
export const observedValue = (output: string): string =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/** What `chains/tasks/<task>.json` records: the decision's inputs, without prose. */
export interface ChainRecord {
  schemaVersion: 1;
  taskId: string;
  findingId: string;
  file: string | null;
  symbol: string;
  /** The finding's family (#2048); absent in records before it. */
  family?: string | null;
  /** The symbols of the chain's findings, oldest first, when they are not all `symbol`. */
  symbols?: string[];
  chain: { id: string; repeatOf: string | null; repro: boolean }[];
  length: number;
  threshold: number;
  policy: "on" | "off";
  decision: "rewrite" | "patch";
}

/** What `chains/battery/<id>.json` records: each case's outcome and what the host did. */
export interface BatteryRecord {
  schemaVersion: 1;
  snapshotId: string | null;
  cases: {
    taskId: string;
    findingId: string;
    file: string | null;
    symbol: string;
    status: ReproOutcome["status"];
    reason: string;
  }[];
  decision: "pass" | "reopen";
}

/** The longest chain of reached length among a corrective's findings, or null. */
export function correctiveChain(
  all: ReadonlyMap<string, ChainFinding>,
  findings: readonly FindingLike[],
): { finding: ChainFinding; chain: ChainFinding[] } | null {
  let best: { finding: ChainFinding; chain: ChainFinding[] } | null = null;
  for (const own of findings) {
    const finding = all.get(own.id);
    if (!finding) continue;
    const chain = findingChain(all, finding);
    if (chain.length >= CHAIN_REWRITE_AT && chain.length > (best?.chain.length ?? 0))
      best = { finding, chain };
  }
  return best;
}

export function chainRecord(
  taskId: string,
  finding: ChainFinding,
  chain: readonly ChainFinding[],
  policy: "on" | "off",
  decide: ChainRule = chainRewriteDecision,
): ChainRecord {
  const symbols = [...new Set(chain.map((f) => symbolKey(f.symbol)).filter(Boolean))];
  return {
    schemaVersion: 1,
    taskId,
    findingId: finding.id,
    file: finding.file,
    symbol: symbolKey(finding.symbol),
    family: finding.family,
    ...(symbols.length > 1 ? { symbols } : {}),
    chain: chain.map((f) => ({ id: f.id, repeatOf: f.repeatOf, repro: f.repro !== undefined })),
    length: chain.length,
    threshold: CHAIN_REWRITE_AT,
    policy,
    decision: decide(chain.length, policy),
  };
}

/** The recorded chain decision of a corrective task, or null. */
export function taskChainRecord(
  store: WorkflowStore,
  runId: string,
  taskId: string,
): ChainRecord | null {
  const row = store.latestArtifact(runId, `${CHAIN_TASKS_DIR}${taskId}.json`);
  if (!row) return null;
  try {
    return JSON.parse(store.readArtifact(runId, row.id)) as ChainRecord;
  } catch {
    return null;
  }
}

/** The battery members of a recorded rewrite: the chain as the run's findings hold it now. */
export function batteryOf(
  all: ReadonlyMap<string, ChainFinding>,
  record: ChainRecord,
): ChainFinding[] {
  const finding = all.get(record.findingId);
  if (!finding) return [];
  // A finding the host opened for a battery case carries that case's repro: one row per input.
  const seen = new Set<string>();
  return chainMembers(all, findingChain(all, finding))
    .filter((f) => {
      if (!f.repro || f.status === "refuted") return false;
      const key = JSON.stringify(f.repro);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-BATTERY_CASES);
}

const command = (repro: Repro): string =>
  [repro.executable, ...repro.args].map((arg) => JSON.stringify(arg)).join(" ");

/** The battery as one table for the rewrite's worker: input, expected and actual of each case. */
export function batteryTable(members: readonly ChainFinding[]): {
  findingId: string;
  command: string;
  stdin?: string;
  files?: { name: string; content: string }[];
  expected: string;
  actual: string;
}[] {
  return members.flatMap((f) =>
    f.repro
      ? [
          {
            findingId: f.id,
            command: command(f.repro),
            ...(f.repro.stdin !== undefined ? { stdin: f.repro.stdin } : {}),
            ...(f.repro.files?.length ? { files: f.repro.files } : {}),
            expected: f.repro.expected,
            actual: f.repro.actual,
          },
        ]
      : [],
  );
}

/** The spec rows the chain's findings name, for the rewrite to restate the algorithm from. */
export function chainSpecRows(
  spec: Spec | null | undefined,
  members: readonly ChainFinding[],
): {
  requirements: { id: string; text: string }[];
  criteria: { id: string; given: string; when: string; then: string }[];
} {
  const criterionIds = new Set(members.flatMap((f) => f.criterionIds));
  const criteria = (spec?.criteria ?? []).filter((c) => criterionIds.has(c.id));
  const requirementIds = new Set([
    ...members.flatMap((f) => f.requirementIds),
    ...criteria.flatMap((c) => c.requirementIds),
  ]);
  return {
    requirements: (spec?.requirements ?? [])
      .filter((r) => requirementIds.has(r.id))
      .map((r) => ({ id: r.id, text: r.text })),
    criteria: criteria.map((c) => ({
      id: c.id,
      given: c.given,
      when: c.when,
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the versioned acceptance-criterion contract.
      then: c.then,
    })),
  };
}

/** What the rewrite's worker is told under `battery` in its input. */
export const BATTERY_NOTE =
  "Earlier corrections patched this symbol one reported case at a time, and review found the next case of the same input class each round. This task rewrites the symbol instead of patching it. First restate its algorithm from the spec rows here, or from a named reference algorithm for its input class (for Markdown inline emphasis, CommonMark's delimiter-run stack; for CSV, RFC 4180; for decimals, exact arithmetic on integers), in a comment above it. Then rewrite the symbol to that algorithm and make every case of the battery pass, not only the last one: run_repro takes the cases as a list. Add one table-driven test with a row per battery case and rows for the neighbouring inputs the algorithm handles (deeper nesting, mixed runs, the empty case). The host runs the whole battery after this task and before the next review, and a case that fails reopens the correction.";

/**
 * The last step of a rewrite corrective's description, in place of the repeat step. A family
 * chain (#2048) spans symbols: it names the class and every symbol, and the code of that class in
 * the file is rewritten.
 */
export const rewriteStep = (
  symbol: string,
  ids: readonly string[],
  family?: { name: string; file: string | null; symbols: readonly string[] },
): string =>
  family && family.symbols.length > 1
    ? `\nThis finding is case ${ids.length} of the defect class ${family.name}${family.file ? ` in ${family.file}` : ""} (${ids.join(", ")}, on ${family.symbols.join(", ")}), each found after the last was patched. Do not patch this case: name the rule the class breaks, rewrite every place of that file that handles it (${family.symbols.join(", ")} and their siblings) from the algorithm its spec rows or a named reference algorithm give, and make every case of the battery in your input pass.`
    : `\nThis finding is case ${ids.length} of one defect class on ${symbol} (${ids.join(", ")}), each found after the last was patched. Do not patch this case: rewrite ${symbol} from the algorithm its spec rows or a named reference algorithm give, and make every case of the battery in your input pass.`;
