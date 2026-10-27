import { canonical } from "../specs/hash.js";
import type { ReproOutcome } from "../verification/repro.js";
import { type Repro, ReproSchema, type RunPolicy, type Spec } from "./schemas.js";
import { recordWouldStop, stopMode } from "./stop-reasons.js";
import type { WorkflowStore } from "./store.js";
import { isTestPath } from "./test-integrity.js";
import type { Task } from "./types.js";

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
 *
 * A reviewer's own `repeatOf` link is also accepted on one file when either finding names no
 * symbol (#2098): a finding on a test file rarely has one, so R67 ampwhy F4 (a test method,
 * `repeatOf: F2`) and F2 (`ReaderNumericTest.java`, no symbol) were a chain of one. A repeat
 * chain on a test file is no symbol rewrite: its corrective is the test sweep
 * (`corrective: "test-sweep"`), and it has no battery. The same holds when one finding names a
 * class and the other a member of it (#2137): ewvet scanner F1 (`Scanner`) and F1-3..F1-6
 * (`Scanner.IsEncodingToken`, each `repeatOf: F1`) were chains of one.
 *
 * A family also joins across files (#2334): two findings of one family on two test files, or on
 * any two files when the reviewer links them with `repeatOf`. R74 callmend cmd F1
 * (`stream_command_spec.rb`), F1-2 (`check_command_spec.rb`, `repeatOf: F1`) and F1-3
 * (`cli_spec.rb`, `repeatOf: F1-2`), all `literal-test-inputs`, were chains of one each, one
 * spec file per round. Such a chain's record names its files, and its corrective may write and
 * sweeps each of them.
 *
 * A corrective that changed no file and whose finding then comes back (`repeatOf` it, or the same
 * claim on the same file) is the `repeat_without_change` would-stop (`unchangedRepeats`, shadow):
 * no further session can change what the last one left alone, and the next step is a decision on
 * the owner or the scope.
 *
 * A corrective whose edit puts back lines the previous corrective of the same file removed is the
 * `corrective_restores_removed` would-stop (`restoredRemovals`, shadow, #2277): two host gates ask
 * for opposite changes, and the next step is a spec conflict, not a third corrective. R72 evalpin
 * foundation: T008 removed `#[allow(unused_variables)]` for the integrity guard, T009 put it back
 * for `cargo clippy -D warnings`, and five correctives ran before the conflict opened.
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
/** A corrective that restored what the previous one removed (#2277): `chains/restores/<task>.json`. */
export const CHAIN_RESTORES_DIR = "chains/restores/";

/**
 * A leading declaration keyword a reviewer may copy with the name (`struct reader`, `impl Reader`,
 * `def read`): no part of the qualified name.
 */
const DECLARATION_KEYWORD =
  /^(?:(?:pub|public|private|protected|internal|static|async|export|abstract|final|override|open)\s+)*(?:struct|class|enum|union|impl|trait|interface|protocol|extension|module|namespace|object|record|contract|type|def|defp|fn|func|function|fun|sub|proc|method|let|var|const|val)\s+/;

/**
 * The qualified name of a symbol a reviewer reported as its segments, outermost first (#2137):
 * `Parser.parseInline()` is `Parser`, `parseInline`. The separators of every supported language's
 * qualified names split it: `.` (C#, Java, Kotlin, Python, Go, TypeScript and most others), `::`
 * (Rust, C++, PHP static members, Ruby constants, Bash namespaced functions), `#` (Ruby and Scala
 * instance methods), `:` (Lua methods), `->` (C struct pointers, PHP instance members), `\` (PHP
 * namespaces), `/`, and `$` between two names (R6 and Reference Class methods, #1500). An
 * Elixir arity (`read/1`), a call or signature (`read(buf)`), type
 * arguments (`Reader<T>`), a Go receiver (`(*Reader).Read`), an Objective-C message
 * (`-[Reader read:]`), a PowerShell type literal (`[Reader]::Read`) and a leading declaration
 * keyword (`struct reader`) are dropped. A language
 * whose qualified names use another spelling adds it here and a row to `CONTAINER_MEMBER` in
 * `tests/workflow-scenario-finding-chain.test.ts`.
 */
export const symbolPath = (symbol: string | null | undefined): string[] => {
  let text = (symbol ?? "").trim();
  const message = /^[-+]\s*\[([^\]]*)\]$/.exec(text);
  if (message?.[1]) text = message[1];
  text = text
    .replace(/^\(\s*\*?\s*([\w.]+)\s*\)\s*\./, "$1.")
    .replace(/^\[([\w.]+)\]/, "$1")
    .replace(DECLARATION_KEYWORD, "")
    .replace(/\(.*$/s, "");
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/(?<=\w)<[\w\s,:.&*'?[\]]*>/g, "");
  }
  return text
    .replace(/\/\d+$/, "")
    .split(/::|->|(?<=\w)\$(?=\w)|[.:#/\\\s]+/)
    .filter(Boolean);
};

/** The last name of a symbol a reviewer reported: `Parser.parseInline()` is `parseInline`. */
export const symbolKey = (symbol: string | null | undefined): string =>
  symbolPath(symbol).at(-1) ?? "";

/**
 * Whether one symbol contains the other (#2137): the shorter qualified name is a run of the longer
 * one's segments that ends before its last (`Scanner` and `Scanner.IsEncodingToken`, `Reader` and
 * `Reader::read`, `Scanner` and `Ewvet.Scan.Scanner.IsEncodingToken`). For a reviewer's own link a
 * finding on a class and one on its member are one place, as a finding without a symbol is.
 */
export const containsSymbol = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => {
  const left = symbolPath(a);
  const right = symbolPath(b);
  const [outer, inner] = left.length <= right.length ? [left, right] : [right, left];
  if (!outer.length || outer.length === inner.length) return false;
  for (let i = 0; i + outer.length < inner.length; i++)
    if (outer.every((segment, j) => inner[i + j] === segment)) return true;
  return false;
};

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

/** One named family on two named files. */
const linkedFamily = (a: ChainFinding, b: ChainFinding): boolean =>
  a.family !== null && a.family === b.family && a.file !== null && b.file !== null;

/**
 * The family half of the chain key (#2048): one family on one file, or on two test files (#2334),
 * where a class of test code spreads one spec file per round.
 */
const sameFamily = (a: ChainFinding, b: ChainFinding): boolean =>
  linkedFamily(a, b) &&
  (a.file === b.file ||
    (a.file !== null && b.file !== null && isTestPath(a.file) && isTestPath(b.file)));

/** The chain key: the same file and either the same symbol or the same family (#2048). */
const sameSpot = (a: ChainFinding, b: ChainFinding): boolean =>
  (symbolKey(a.symbol) !== "" &&
    symbolKey(a.symbol) === symbolKey(b.symbol) &&
    (!a.file || !b.file || a.file === b.file)) ||
  sameFamily(a, b);

/**
 * Whether the reviewer's `repeatOf` link between `a` and `b` joins a chain (#2098): the chain key,
 * one family on any two files (#2334), or the same named file when either finding names no symbol
 * or one symbol contains the other (a class and its member, `containsSymbol`, #2137). The host's
 * own links (`familyLink`) keep the key; a link between two unrelated symbols without a shared
 * family stays unjoined.
 */
const explicitLink = (a: ChainFinding, b: ChainFinding): boolean =>
  sameSpot(a, b) ||
  linkedFamily(a, b) ||
  (a.file !== null &&
    a.file === b.file &&
    (symbolKey(a.symbol) === "" ||
      symbolKey(b.symbol) === "" ||
      containsSymbol(a.symbol, b.symbol)));

/**
 * The latest finding recorded before `current` of `start`'s family and file (or test files,
 * `sameFamily`) that a correction
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
 * `repeatOf` path while each link is on the same spot (`explicitLink`: the key, one family across
 * files, or one file when either names no symbol, #2098, #2334), and, where that path ends, the
 * latest earlier addressed finding of its family on its file or test files (`familyLink`). A
 * finding without a symbol, a family or a same-file `repeatOf` is a chain of one.
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
      linked && explicitLink(linked, start) ? linked : familyLink(all, current, start, seen);
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
 * A side branch is a reviewer's link, so it joins as `findingChain` joins one (`explicitLink`).
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
        explicitLink(finding, head)
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

/**
 * Whether a battery's case outcomes reopen the chain's corrective before the review. A case that
 * crashes inside the chain's file is inconclusive here; `edgeCrashDecision` records it (#2136).
 */
export type BatteryRule = (statuses: readonly ReproOutcome["status"][]) => "pass" | "reopen";
export const batteryDecision: BatteryRule = (statuses) =>
  statuses.includes("reproduced") ? "reopen" : "pass";

/**
 * Whether a case of a chain's sibling probe joins the battery (#1969). The host runs each case as a
 * repro whose actual is its expected value: `reproduced` is a case the code already gets right,
 * `refuted` one that ran and printed something else (a member of the class), `inconclusive` one
 * that could not show either (a crash, a program no check starts), which is left out. Whether an
 * inconclusive case crashed inside the chain's own file is `edgeCrashDecision`'s (#2136, shadow).
 */
export type FamilyRule = (status: ReproOutcome["status"]) => "join" | "skip";
export const familyDecision: FamilyRule = (status) => (status === "refuted" ? "join" : "skip");

/**
 * A crash record of a chain case (#2136): the output's tail and `edgeCrashDecision` on it against
 * the chain's file, in shadow. Absent on records before #2136.
 */
export interface CaseCrash {
  outputTail?: string;
  crash?: "finding" | "pass";
}

/** What `chains/family/<task>.json` records: each probed case's outcome and whether it joined. */
export interface FamilyRecord {
  schemaVersion: 1;
  taskId: string;
  findingId: string;
  file: string | null;
  symbol: string;
  /** The chain's cases the probe was shown, by finding id. */
  shown: string[];
  cases: ({
    status: ReproOutcome["status"];
    reason: string;
    /** A joined case is a finding with this record as its evidence and `repeatOf` the finding. */
    decision: "join" | "skip";
  } & CaseCrash)[];
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
  /** The files of the chain's findings, oldest first, when they are not all `file` (#2334). */
  files?: string[];
  chain: { id: string; repeatOf: string | null; repro: boolean }[];
  length: number;
  threshold: number;
  policy: "on" | "off";
  decision: "rewrite" | "patch";
  /**
   * The corrective a rewrite decision opens when it is not a symbol rewrite (#2098): a chain on a
   * test file sweeps the test files (`testSweepStep`) and has no battery. Absent: a rewrite.
   */
  corrective?: "test-sweep";
}

/** Whether a recorded chain decision rewrites code against a battery (not a test sweep, #2098). */
export const rewritesSymbol = (record: ChainRecord | null | undefined): record is ChainRecord =>
  record?.decision === "rewrite" && record.corrective !== "test-sweep";

/**
 * What a chain's prose names: its symbol, or its file for a chain of reviewer links whose findings
 * name no symbol (#2098).
 */
export const chainSubject = (record: Pick<ChainRecord, "symbol" | "file">): string =>
  record.symbol || record.file || "the reported code";

/** What `chains/battery/<id>.json` records: each case's outcome and what the host did. */
export interface BatteryRecord {
  schemaVersion: 1;
  snapshotId: string | null;
  cases: ({
    taskId: string;
    findingId: string;
    file: string | null;
    symbol: string;
    status: ReproOutcome["status"];
    reason: string;
  } & CaseCrash)[];
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

/** The artifact path of a task's recorded changes, which holds `changed`: the paths it changed. */
export const taskDiffPath = (taskId: string): string => `tasks/${taskId}/diff.json`;

/** A finding that came back after a corrective that changed no file (#2137). */
export interface UnchangedRepeat {
  findingId: string;
  /** The earlier finding it repeats: its `repeatOf`, or the same claim on the same file. */
  earlierId: string;
  /** The corrective of the earlier finding. */
  taskId: string;
  /** The paths that corrective changed, across its sessions: empty. */
  changed: string[];
  /** The finding's chain, oldest first (`findingChain`). */
  chain: string[];
}

const claimKey = (claim: string): string => claim.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The findings of a round that repeat an earlier finding whose corrective changed no file (#2137):
 * the earlier one is the finding's `repeatOf`, else the latest earlier finding on the same file
 * with the same claim (case and spacing folded). `changedOf` gives a corrective's changed paths
 * over all its sessions, or null when it recorded none (still running, never ran): only a recorded
 * empty change counts. ewvet scanner T010 reported "I made no edits in this task" after three
 * sessions (252k tokens), was marked implemented, and review found F1 again.
 */
export function unchangedRepeats(
  all: ReadonlyMap<string, ChainFinding>,
  findings: readonly Pick<FindingLike, "id">[],
  changedOf: (taskId: string) => readonly string[] | null,
): UnchangedRepeat[] {
  const order = [...all.keys()];
  const repeats: UnchangedRepeat[] = [];
  for (const own of findings) {
    const finding = all.get(own.id);
    if (!finding) continue;
    const linked = finding.repeatOf ? all.get(finding.repeatOf) : undefined;
    const sameClaim = (): ChainFinding | undefined =>
      order
        .slice(0, order.indexOf(finding.id))
        .map((id) => all.get(id) as ChainFinding)
        .filter(
          (f) =>
            f.file !== null &&
            f.file === finding.file &&
            f.repairTaskId !== null &&
            claimKey(f.claim) !== "" &&
            claimKey(f.claim) === claimKey(finding.claim),
        )
        .at(-1);
    const earlier = linked ?? sameClaim();
    const taskId = earlier?.repairTaskId;
    if (!earlier || !taskId || taskId === finding.repairTaskId) continue;
    const changed = changedOf(taskId);
    if (changed === null || changed.length) continue;
    repeats.push({
      findingId: finding.id,
      earlierId: earlier.id,
      taskId,
      changed: [],
      chain: findingChain(all, finding).map((f) => f.id),
    });
  }
  return repeats;
}

/** A task's changed paths over all its recorded sessions, or null when it recorded none. */
export function taskChangedPaths(
  store: WorkflowStore,
  runId: string,
  taskId: string,
): string[] | null {
  const rows = store.artifacts(runId).filter((a) => a.logical_path === taskDiffPath(taskId));
  if (!rows.length) return null;
  const changed = new Set<string>();
  for (const row of rows) {
    try {
      const body = JSON.parse(store.readArtifact(runId, row.id)) as { changed?: unknown };
      if (!Array.isArray(body.changed)) return null;
      for (const path of body.changed) if (typeof path === "string") changed.add(path);
    } catch {
      return null;
    }
  }
  return [...changed].sort();
}

/**
 * Records the `repeat_without_change` would-stop for each finding of a round that repeats one
 * whose corrective changed no file (#2137), once per corrective, with the corrective's changed
 * paths, the finding ids and the chain. Shadow: the corrective is opened as before.
 */
export function recordUnchangedRepeats(
  store: WorkflowStore,
  runId: string,
  policy: Pick<RunPolicy, "stopModes" | "costForecast">,
  findings: readonly FindingLike[],
): UnchangedRepeat[] {
  if (!findings.length) return [];
  const mode = stopMode(policy, "repeat_without_change");
  if (mode === "enforce") return [];
  const repeats = unchangedRepeats(chainFindings(store, runId, findings), findings, (taskId) =>
    taskChangedPaths(store, runId, taskId),
  );
  for (const repeat of repeats)
    recordWouldStop(store, runId, {
      reason: "repeat_without_change",
      mode,
      key: `task-${repeat.taskId}`,
      summary: `${repeat.findingId} repeats ${repeat.earlierId} after ${repeat.taskId} changed no file: another session would start from the same files, and the finding needs a decision on its owner or scope`,
      inputs: { ...repeat },
    });
  return repeats;
}

export function chainRecord(
  taskId: string,
  finding: ChainFinding,
  chain: readonly ChainFinding[],
  policy: "on" | "off",
  decide: ChainRule = chainRewriteDecision,
): ChainRecord {
  const symbols = [...new Set(chain.map((f) => symbolKey(f.symbol)).filter(Boolean))];
  const files = [...new Set(chain.flatMap((f) => (f.file ? [f.file] : [])))];
  const decision = decide(chain.length, policy);
  return {
    schemaVersion: 1,
    taskId,
    findingId: finding.id,
    file: finding.file,
    // A finding without a symbol takes its chain's latest one (#2098).
    symbol: symbolKey(finding.symbol) || (symbols.at(-1) ?? ""),
    family: finding.family,
    ...(symbols.length > 1 ? { symbols } : {}),
    ...(files.length > 1 ? { files } : {}),
    chain: chain.map((f) => ({ id: f.id, repeatOf: f.repeatOf, repro: f.repro !== undefined })),
    length: chain.length,
    threshold: CHAIN_REWRITE_AT,
    policy,
    decision,
    ...(decision === "rewrite" && finding.file && isTestPath(finding.file)
      ? { corrective: "test-sweep" as const }
      : {}),
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
  if (!finding || record.corrective === "test-sweep") return [];
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
 * chain (#2048) spans symbols or files (#2334): it names the class, every symbol and every file,
 * and the code of that class in those files is rewritten.
 */
export const rewriteStep = (
  symbol: string,
  ids: readonly string[],
  family?: {
    name: string;
    file: string | null;
    symbols: readonly string[];
    files?: readonly string[];
  },
): string => {
  const files = family?.files ?? [];
  if (family && files.length > 1) {
    const places = family.symbols.length ? `${family.symbols.join(", ")} and their siblings` : "";
    return `\nThis finding is case ${ids.length} of the defect class ${family.name} in ${files.join(", ")} (${ids.join(", ")}${family.symbols.length ? `, on ${family.symbols.join(", ")}` : ""}), each found after the last was patched. Do not patch this case: name the rule the class breaks, rewrite every place of those files that handles it${places ? ` (${places})` : ""} from the algorithm its spec rows or a named reference algorithm give, and make every case of the battery in your input pass.`;
  }
  return family && family.symbols.length > 1
    ? `\nThis finding is case ${ids.length} of the defect class ${family.name}${family.file ? ` in ${family.file}` : ""} (${ids.join(", ")}, on ${family.symbols.join(", ")}), each found after the last was patched. Do not patch this case: name the rule the class breaks, rewrite every place of that file that handles it (${family.symbols.join(", ")} and their siblings) from the algorithm its spec rows or a named reference algorithm give, and make every case of the battery in your input pass.`
    : `\nThis finding is case ${ids.length} of one defect class on ${symbol} (${ids.join(", ")}), each found after the last was patched. Do not patch this case: rewrite ${symbol} from the algorithm its spec rows or a named reference algorithm give, and make every case of the battery in your input pass.`;
};

/** The lines a unified patch removes and adds, by the path of each file it changes. */
export function patchLines(patch: string): Map<string, { removed: string[]; added: string[] }> {
  const files = new Map<string, { removed: string[]; added: string[] }>();
  const lines = patch.split("\n");
  let current: { removed: string[]; added: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A file's header is a `---` line followed by its `+++` line; a removed line that starts with
    // `--` (an SQL or Lua comment) is not followed by one.
    const next = lines[i + 1] ?? "";
    if (line.startsWith("--- ") && next.startsWith("+++ ")) {
      const to = next.slice(4).trim();
      const from = line.slice(4).trim();
      const path = (to === "/dev/null" ? from : to).replace(/^[ab]\//, "");
      current = files.get(path) ?? { removed: [], added: [] };
      files.set(path, current);
      i++;
      continue;
    }
    if (!current || line.startsWith("@@")) continue;
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return files;
}

/** A line worth comparing: not blank and more than punctuation (`}`, `end`, `)`). */
const meaningful = (line: string): boolean => /[\p{L}\p{N}]/u.test(line) && line.trim().length >= 4;

/** A corrective's recorded edit: its task, the findings it corrected and its patch. */
export interface CorrectiveEdit {
  taskId: string;
  findingIds: readonly string[];
  patch: string;
}

/** Lines a corrective put back that the previous corrective of the same file removed (#2277). */
export interface RestoredRemoval {
  taskId: string;
  findingIds: string[];
  path: string;
  /** The previous corrective of the file, which removed the lines. */
  earlierTaskId: string;
  earlierFindingIds: string[];
  /** The restored lines, trimmed, in the order the later corrective added them. */
  lines: string[];
}

/**
 * The files on which `current` puts back lines that the latest earlier corrective of the same file
 * removed (lines compared trimmed; a line that corrective moved, removing and adding it, is no
 * removal). `earlier` holds the run's earlier correctives, oldest first.
 */
export function restoredRemovals(
  current: CorrectiveEdit,
  earlier: readonly CorrectiveEdit[],
): RestoredRemoval[] {
  const out: RestoredRemoval[] = [];
  const edits = earlier.map((edit) => ({ edit, files: patchLines(edit.patch) }));
  for (const [path, { added }] of patchLines(current.patch)) {
    const previous = edits.filter(({ files }) => files.has(path)).at(-1);
    const changed = previous?.files.get(path);
    if (!previous || !changed) continue;
    const kept = new Set(changed.added.map((line) => line.trim()));
    const removed = new Set(
      changed.removed
        .map((line) => line.trim())
        .filter((line) => meaningful(line) && !kept.has(line)),
    );
    const lines = [
      ...new Set(added.map((line) => line.trim()).filter((line) => removed.has(line))),
    ];
    if (!lines.length) continue;
    out.push({
      taskId: current.taskId,
      findingIds: [...current.findingIds],
      path,
      earlierTaskId: previous.edit.taskId,
      earlierFindingIds: [...previous.edit.findingIds],
      lines,
    });
  }
  return out;
}

/** A task's patches over all its recorded sessions, joined, or null when it recorded none. */
function taskPatch(store: WorkflowStore, runId: string, taskId: string): string | null {
  const rows = store.artifacts(runId).filter((a) => a.logical_path === taskDiffPath(taskId));
  if (!rows.length) return null;
  return rows
    .map((row) => {
      try {
        const body = JSON.parse(store.readArtifact(runId, row.id)) as { patch?: unknown };
        return typeof body.patch === "string" ? body.patch : "";
      } catch {
        return "";
      }
    })
    .join("\n");
}

/** The edits of the graph's correctives before `taskId` and of `taskId` itself, from the run's diffs. */
function correctiveEdits(
  store: WorkflowStore,
  runId: string,
  tasks: readonly Task[],
  taskId: string,
): { current: CorrectiveEdit | null; earlier: CorrectiveEdit[] } {
  const correctives = tasks.filter((t) => t.origin !== "planned");
  const at = correctives.findIndex((t) => t.id === taskId);
  if (at < 0) return { current: null, earlier: [] };
  const edit = (task: Task): CorrectiveEdit | null => {
    const patch = taskPatch(store, runId, task.id);
    return patch === null ? null : { taskId: task.id, findingIds: task.findingIds, patch };
  };
  const earlier = correctives
    .slice(0, at)
    .map(edit)
    .filter((e): e is CorrectiveEdit => e !== null);
  return { current: edit(correctives[at] as Task), earlier };
}

/**
 * Records the `corrective_restores_removed` would-stop for each file on which a corrective put back
 * what the previous corrective of the file removed (#2277), once per corrective and file, and the
 * decision in `chains/restores/<task>.json` for the replay. Shadow: the run goes on as before.
 */
export function recordRestoredRemovals(
  store: WorkflowStore,
  runId: string,
  policy: Pick<RunPolicy, "stopModes" | "costForecast">,
  tasks: readonly Task[],
  taskId: string,
): RestoredRemoval[] {
  const mode = stopMode(policy, "corrective_restores_removed");
  if (mode === "enforce") return [];
  const { current, earlier } = correctiveEdits(store, runId, tasks, taskId);
  if (!current) return [];
  const restored = restoredRemovals(current, earlier);
  if (!restored.length) return [];
  const path = `${CHAIN_RESTORES_DIR}${taskId}.json`;
  if (!store.artifacts(runId).some((row) => row.logical_path === path))
    store.transaction(() =>
      store.artifact(
        runId,
        CHAIN_KIND,
        path,
        canonical({ schemaVersion: 1, taskId, mode, restored }),
      ),
    );
  for (const item of restored)
    recordWouldStop(store, runId, {
      reason: "corrective_restores_removed",
      mode,
      key: `task-${item.taskId}-${item.path}`,
      summary: `${item.taskId} put back in ${item.path} what ${item.earlierTaskId} removed (${item.lines.slice(0, 3).join(" | ")}): the findings of the two correctives ask for opposite changes, and the next step is a spec conflict naming both`,
      inputs: { ...item },
    });
  return restored;
}

/** The restores a run's correctives would record on the current rule, for the replay (#2277). */
export function replayRestoredRemovals(
  store: WorkflowStore,
  runId: string,
  tasks: readonly Task[],
): RestoredRemoval[] {
  return tasks
    .filter((t) => t.origin !== "planned")
    .flatMap((task) => {
      const { current, earlier } = correctiveEdits(store, runId, tasks, task.id);
      return current ? restoredRemovals(current, earlier) : [];
    });
}
