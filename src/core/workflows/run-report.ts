/**
 * One Markdown report of a run: what was asked and done, tasks, checks, acceptance criteria,
 * findings, decisions, token usage by stage and model, and the run's artifacts. Delivery uses it
 * as the pull request body; `baked workflow report` and the local API return it.
 */

import type { z } from "zod";
import { modelVendor } from "../llm/model-vendor.js";
import {
  type BaselineCount,
  CHECK_BASELINE_PATH,
  commandKey,
  testCount,
} from "../verification/output-counts.js";
import { settledConflicts } from "./conflict-decisions.js";
import { type CostForecast, forecastProgress } from "./cost-forecast.js";
import { type DependencyResult, QUALITY_DEPENDENCIES } from "./quality/dependencies.js";
import {
  type DuplicationResult,
  metricDeltas,
  QUALITY_DUPLICATION,
} from "./quality/duplication.js";
import { QUALITY_MUTATION_BASELINE } from "./quality/harden.js";
import { type MutationResult, QUALITY_MUTATION } from "./quality/mutation.js";
import { type PropertiesResult, QUALITY_PROPERTIES } from "./quality/properties.js";
import { QUALITY_RULES, type RulesResult } from "./quality/rules.js";
import { QUALITY_SAST, type SastResult } from "./quality/sast.js";
import {
  type Critique,
  ReportSchema,
  type ReviewSchema,
  type RunPolicy,
  TaskSchema,
} from "./schemas.js";
import type { SpecAmendment } from "./spec-amendment.js";
import type { ArtifactRow, CriticOutcomeRow, WorkflowStore } from "./store.js";
import type { Check } from "./types.js";
import { type RunUsageReport, runUsage, toolBackendLine, toolTokensLine } from "./usage.js";
import { HOST_SPEC_OUTCOME, parseRunDefinition } from "./v2/runtime.js";
import { changesOf, type FileChange, readRoutingSummary } from "./view.js";

/** GitHub refuses pull request bodies over 65,536 characters; delivery keeps a margin. */
export const PULL_REQUEST_BODY_LIMIT = 60_000;

export interface RunReportOptions {
  /** Upper bound on the report's length in characters; long lists are shortened to fit. */
  maxChars?: number;
  /** Markdown appended as the last section, kept whole when the report is shortened. */
  appendix?: string;
}

type Review = z.infer<typeof ReviewSchema>;
type Finding = Review["findings"][number];

const PROMPT_CHARS = 2_000;
/** Row caps tried in turn until the report fits `maxChars`. */
const ROW_CAPS = [Number.POSITIVE_INFINITY, 100, 30, 10, 3];

/** A Markdown table cell: one line, pipes escaped. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value)
    .replace(/\r?\n+/g, " ")
    .replaceAll("|", "\\|")
    .trim();
}
const code = (value: string): string => `\`${value.replaceAll("`", "'")}\``;
const count = (n: number): string => n.toLocaleString("en-US");

function table(head: string[], rows: (string | number | null)[][], cap: number): string[] {
  if (!rows.length) return [];
  const shown = rows.slice(0, cap);
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...shown.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ...(rows.length > shown.length ? ["", `_${rows.length - shown.length} more not shown._`] : []),
  ];
}
function list(items: string[], cap: number): string[] {
  const shown = items.slice(0, cap);
  return [
    ...shown,
    ...(items.length > shown.length ? [`- _${items.length - shown.length} more not shown._`] : []),
  ];
}
function quote(text: string, limit: number): string[] {
  const trimmed = text.trim();
  const cut = trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed;
  return cut.split("\n").map((line) => (line ? `> ${line}` : ">"));
}
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

const testsCell = (tests: TestsCount | null): string =>
  !tests
    ? ""
    : tests.before === null
      ? String(tests.after)
      : `${tests.before} → ${tests.after} (${signed(tests.after - tests.before)})`;

/**
 * How many files a task may write. A correction whose first attempt was limited to where its
 * findings point shows that number first (#1285): its full scope is only for a later attempt.
 */
const writesCell = (t: {
  writes: string[];
  narrowed: string[] | null;
  widened: boolean;
}): string =>
  t.narrowed
    ? `${t.narrowed.length} of ${t.writes.length} first${t.widened ? ", then all" : ""}`
    : String(t.writes.length);

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Tests a check ran on its last passing run, against the same command before any change when
 * the run measured a baseline (#1251): an update's added tests can be compared with a brief.
 */
interface TestsCount {
  after: number;
  before: number | null;
}

interface TaskDiff {
  changed: string[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}
interface ReportChange {
  path: string;
  action: FileChange["action"];
  spec: boolean;
  edits: number | null;
  status: string | null;
}
/**
 * The journal's file changes, plus files only a task diff records (tools that write outside the
 * effect journal, ignored files); a file both list keeps the journal's entry.
 */
function fileChanges(journal: FileChange[], diffs: TaskDiff[]): ReportChange[] {
  const byPath = new Map<string, ReportChange>();
  for (const c of journal)
    byPath.set(c.path, {
      path: c.path,
      action: c.action,
      spec: c.source === "spec",
      edits: c.edits,
      status: c.drifted ? `${c.status}, changed since` : c.status,
    });
  const first = new Map<string, string | null>();
  const last = new Map<string, string | null>();
  for (const diff of diffs)
    for (const path of diff.changed) {
      if (!first.has(path)) first.set(path, diff.before[path] ?? null);
      last.set(path, diff.after[path] ?? null);
    }
  for (const [path, after] of last) {
    if (byPath.has(path)) continue;
    const before = first.get(path) ?? null;
    if (before === after) continue;
    byPath.set(path, {
      path,
      action: before === null ? "created" : after === null ? "deleted" : "modified",
      spec: false,
      edits: null,
      status: null,
    });
  }
  return [...byPath.values()].sort(
    (a, b) => Number(a.spec) - Number(b.spec) || a.path.localeCompare(b.path),
  );
}
/** Runtime bookkeeping: attempt outputs, state, baselines; the report lists only their count. */
const internalArtifact = (path: string): boolean => /^(internal|attempts|baselines)\//.test(path);

/** Stages in the order their first attempt started; attempts are stored in no order. */
function stagesInRunOrder(store: WorkflowStore, usage: RunUsageReport): RunUsageReport {
  const started = new Map(store.attempts(usage.runId).map((a) => [a.id, a.started_at]));
  const first = new Map<string, number>();
  for (const attempt of usage.attempts) {
    const at = started.get(attempt.attemptId) ?? Number.POSITIVE_INFINITY;
    first.set(attempt.stage, Math.min(first.get(attempt.stage) ?? at, at));
  }
  const order = (stage: string) => first.get(stage) ?? Number.POSITIVE_INFINITY;
  return {
    ...usage,
    stages: [...usage.stages].sort(
      (a, b) => order(a.stage) - order(b.stage) || a.stage.localeCompare(b.stage),
    ),
  };
}

/** Facts read once from the store; rendering at several row caps reuses them. */
/**
 * The repro cell of a finding: what its repro showed, or for a correctness finding without one,
 * why none was given or that the claim is unverified.
 */
function reproColumn(body: Partial<Finding>, outcomes: Map<string, string>): string | null {
  if (body.repro) return (body.id && outcomes.get(body.id)) || "attached";
  if (body.kind !== "correctness") return null;
  return body.noRepro ? `none: ${body.noRepro}` : "unverified";
}

function collect(store: WorkflowStore, runId: string) {
  return store.readTransaction(() => {
    const run = store.run(runId);
    const state = store.state(runId);
    const definition = (() => {
      try {
        return parseRunDefinition(run.definition_json).definition.id;
      } catch {
        return null;
      }
    })();
    const report = (() => {
      const parsed = ReportSchema.safeParse(parse(state.report, null));
      return parsed.success ? parsed.data : null;
    })();
    const latestArtifacts = new Map<string, ArtifactRow>();
    const taskDiffs = new Map<string, ArtifactRow>();
    const critiques: CritiqueRecord[] = [];
    const selections: SelectionRecord[] = [];
    const candidates: CandidateRecord[] = [];
    // What the host's run of each finding's repro showed, by finding id.
    const reproOutcomes = new Map<string, string>();
    const readQuietly = (id: string): string | null => {
      try {
        return store.readArtifact(runId, id);
      } catch {
        return null;
      }
    };
    const amendments: SpecAmendment[] = [];
    for (const artifact of store.artifacts(runId)) {
      if (/^tasks\/[^/]+\/selection\.json$/.test(artifact.logical_path)) {
        const record = parse<SelectionRecord | null>(readQuietly(artifact.id), null);
        if (record) selections.push(record);
      }
      if (/^tasks\/[^/]+\/candidates\/\d+\.json$/.test(artifact.logical_path)) {
        const record = parse<CandidateRecord | null>(readQuietly(artifact.id), null);
        if (record) candidates.push(record);
      }
      if (artifact.logical_path.startsWith("amendments/")) {
        const record = parse<SpecAmendment | null>(readQuietly(artifact.id), null);
        if (record) amendments.push(record);
      }
      if (/^tasks\/[^/]+\/critique\.json$/.test(artifact.logical_path))
        critiques.push(
          parse<CritiqueRecord>(
            (() => {
              try {
                return store.readArtifact(runId, artifact.id);
              } catch {
                return null;
              }
            })(),
            { taskId: artifact.logical_path.split("/")[1] ?? "", attempt: 0 },
          ),
        );
      latestArtifacts.set(artifact.logical_path, artifact);
      if (/^tasks\/[^/]+\/diff\.json$/.test(artifact.logical_path))
        taskDiffs.set(artifact.logical_path, artifact);
      if (artifact.logical_path.startsWith("reviews/repro-")) {
        const record = parse<{ outcomes?: Record<string, { status?: unknown }> }>(
          (() => {
            try {
              return store.readArtifact(runId, artifact.id);
            } catch {
              return null;
            }
          })(),
          {},
        );
        for (const [id, outcome] of Object.entries(record.outcomes ?? {}))
          if (typeof outcome?.status === "string") reproOutcomes.set(id, outcome.status);
      }
    }
    const checks = new Map<
      string,
      { status: string; validity: string; runs: number; ms: number; tests: TestsCount | null }
    >();
    // The evidence of each check's last passing run, whose output carries its test count.
    const lastPassed = new Map<string, string>();
    for (const row of store.checkDetails(runId)) {
      const known = checks.get(row.check_id);
      checks.set(row.check_id, {
        status: row.status,
        validity: row.validity,
        runs: (known?.runs ?? 0) + 1,
        ms: (known?.ms ?? 0) + row.duration_ms,
        tests: null,
      });
      if (row.status === "passed") lastPassed.set(row.check_id, row.artifact_id);
    }
    const baseline = parse<{ counts?: Record<string, BaselineCount[]> }>(
      (() => {
        const row = latestArtifacts.get(CHECK_BASELINE_PATH);
        return row ? readQuietly(row.id) : null;
      })(),
      {},
    );
    for (const [id, artifactId] of lastPassed) {
      const record = parse<{ definition?: Check; output?: string } | null>(
        readQuietly(artifactId),
        null,
      );
      const now = record?.output ? testCount(record.output) : null;
      const entry = checks.get(id);
      if (!now || !entry || !record?.definition) continue;
      const before = baseline.counts?.[commandKey(record.definition)]?.find(
        (count) => count.kind === "tests" && count.tool === now.tool,
      );
      entry.tests = { after: now.count, before: before?.count ?? null };
    }
    const readJson = <T>(path: string): T | null => {
      const row = latestArtifacts.get(path);
      if (!row) return null;
      try {
        return parse<T | null>(store.readArtifact(runId, row.id), null);
      } catch {
        return null;
      }
    };
    return {
      run,
      state,
      quality: {
        duplication: readJson<DuplicationResult>(QUALITY_DUPLICATION),
        rules: readJson<RulesResult>(QUALITY_RULES),
        dependencies: readJson<DependencyResult>(QUALITY_DEPENDENCIES),
        sast: readJson<SastResult>(QUALITY_SAST),
        properties: readJson<PropertiesResult>(QUALITY_PROPERTIES),
        mutation: readJson<MutationResult>(QUALITY_MUTATION),
        mutationBefore: readJson<MutationResult>(QUALITY_MUTATION_BASELINE),
      },
      workflowId: definition,
      policy: parse<Partial<RunPolicy>>(run.policy_json, {}),
      report,
      tasks: store.tasks(runId).map((row) => {
        const task = TaskSchema.safeParse(parse(row.definition_json, null));
        return {
          id: row.id,
          status: row.status,
          title: task.success ? task.data.title : null,
          // A correction that started from a clean context after repeated failures.
          origin:
            task.success && state?.freshTasks?.[row.id]
              ? `${task.data.origin}, fresh context`
              : task.success
                ? task.data.origin
                : null,
          writes: task.success ? task.data.writes.map((w) => w.path) : [],
          narrowed: state?.narrowedCorrections?.[row.id] ?? null,
          widened: state?.widenedCorrections?.includes(row.id) ?? false,
        };
      }),
      checks: [...checks].map(([id, c]) => ({ id, ...c })),
      changes: fileChanges(
        changesOf(store, runId),
        [...taskDiffs.values()].map((a) =>
          parse<TaskDiff>(
            (() => {
              try {
                return store.readArtifact(runId, a.id);
              } catch {
                return null; // A redacted diff leaves the effect journal as the only record.
              }
            })(),
            { changed: [], before: {}, after: {} },
          ),
        ),
      ),
      findings: store.findings(runId).map((row) => {
        const body = parse<Partial<Finding>>(row.body_json, {});
        return { id: row.id, status: row.status, body, repro: reproColumn(body, reproOutcomes) };
      }),
      requests: store.requests(runId),
      routing: readRoutingSummary(store, runId),
      critiques,
      selections,
      candidates,
      amendments,
      settled: settledConflicts(store, runId),
      outcomes: store.criticOutcomes(runId),
      usage: stagesInRunOrder(store, runUsage(store, runId)),
      forecasts: forecastProgress(store, runId),
      forecastStopped: store.artifacts(runId).some((a) => a.kind === "cost-forecast"),
      artifacts: [...latestArtifacts.values()].filter((a) => !internalArtifact(a.logical_path)),
      internalArtifacts: [...latestArtifacts.values()].filter((a) =>
        internalArtifact(a.logical_path),
      ).length,
    };
  });
}
type Facts = ReturnType<typeof collect>;

/**
 * The cost forecast of a capped run (#1246): what it projected at the first and the last count of
 * finished tasks, against the cap, and whether it stopped the run; null when it never forecast.
 */
function forecastLine(forecasts: CostForecast[], stopped: boolean): string | null {
  const first = forecasts[0];
  const last = forecasts.at(-1);
  if (!first || !last) return null;
  const at = (f: CostForecast) =>
    `about $${f.projectedUsd.toFixed(2)} at ${String(f.measuredTasks)} finished tasks (${f.ratio.toFixed(1)} times their price)`;
  const ceiling =
    last.ceilingUsd > last.capUsd
      ? `the $${last.ceilingUsd.toFixed(2)} ceiling ($${last.capUsd.toFixed(2)} cap and its tolerance)`
      : `the $${last.capUsd.toFixed(2)} cap`;
  return `Cost forecast: ${forecasts.length > 1 ? `${at(first)}, then ${at(last)}` : at(last)}, against ${ceiling}; ${stopped ? "it stopped the run for a decision" : "it did not stop the run"}.`;
}
/** A stored `tasks/TASK/critique.json`: a critique, or the error of a critic that failed. */
interface CritiqueRecord {
  taskId: string;
  attempt: number;
  critique?: Critique;
  error?: string;
}

/** A stored `tasks/TASK/selection.json` of a best-of-N task (#642). */
interface SelectionRecord {
  taskId: string;
  candidates: number;
  winner: number | null;
  method: string;
  reason: string;
  oracle: boolean;
  selectedPassed: boolean;
}
/** A stored `tasks/TASK/candidates/N.json`. */
interface CandidateRecord {
  taskId: string;
  index: number;
  outcome: string;
  failedChecks: string[];
  changedLines: number;
  score: number | null;
  selected: boolean;
  error?: string;
}

/** Best-of-N (#642): each candidate's result, the choice and the oracle and selected rates. */
function candidatesSection(facts: Facts, cap: number): string[] {
  const selections = facts.selections;
  const oracle = selections.filter((s) => s.oracle).length;
  const selected = selections.filter((s) => s.selectedPassed).length;
  const of = String(selections.length);
  return [
    `${of} task(s) ran as several candidates. Oracle rate ${String(oracle)}/${of} (some candidate passed its required checks); selected rate ${String(selected)}/${of} (the selected candidate passed them).`,
    "",
    ...table(
      ["Task", "Candidate", "Result", "Failed checks", "Lines", "Score", "Selected"],
      [...facts.candidates]
        .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.index - b.index)
        .map((c) => [
          c.taskId,
          c.index,
          c.error ? `${c.outcome}: ${c.error}` : c.outcome,
          c.failedChecks.join(", ") || null,
          c.changedLines,
          c.score === null ? null : c.score.toFixed(2),
          c.selected ? "yes" : null,
        ]),
      cap,
    ),
    "",
    ...list(
      selections.map((s) => `- ${s.taskId} (${s.method}): ${s.reason}`),
      cap,
    ),
    "",
  ];
}

/** Which models and vendors reviewed the change and which implemented it (#635). */
/**
 * Who reviewed and who implemented. The implementer is read from the attempts of the task steps,
 * the models that wrote the code: a stage route (`--route implement=MODEL`) or a fallback leaves
 * the profile's routed model unused (#1017). The profile's model is named as configured when it
 * differs, and alone before any task ran.
 */
function reviewModels(routing: Facts["routing"], usage: RunUsageReport): string | null {
  if (!routing) return null;
  const models = (targets: string[]) => [
    ...new Set(routing.effective.filter((r) => targets.includes(r.target)).map((r) => r.model)),
  ];
  const named = (list: string[]) =>
    list.map((model) => `${code(model)} (${modelVendor(model)})`).join(", ");
  const review = models(["reviewer", "spec-auditor"]);
  if (!review.length) return null;
  const configured = models(["implementer"]);
  const tokens = new Map<string, number>();
  for (const attempt of usage.attempts)
    if (attempt.model && attempt.stage.startsWith("task-"))
      tokens.set(attempt.model, (tokens.get(attempt.model) ?? 0) + (attempt.usedTokens ?? 0));
  const wrote = [...tokens.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  const differs = wrote.length > 0 && configured.some((model) => !wrote.includes(model));
  const implementation = wrote.length ? wrote : configured;
  return `Reviewed on ${named(review)}${implementation.length ? `; implemented on ${named(implementation)}` : ""}${differs ? ` (configured: ${named(configured)})` : ""}.`;
}

interface QualityFacts {
  duplication: DuplicationResult | null;
  rules: RulesResult | null;
  dependencies: DependencyResult | null;
  sast: SastResult | null;
  properties: PropertiesResult | null;
  mutation: MutationResult | null;
  /** A harden run's score of the module's tests at approval. */
  mutationBefore: MutationResult | null;
}

/**
 * The code quality gates: the duplication ratchet (#638), the anti-slop rules (#639), and the
 * dependency check and SAST (#640), property-based tests (#637) and the mutation gate (#636).
 */
function qualitySection(quality: QualityFacts, cap: number): string[] {
  return [
    ...(quality.duplication ? duplicationSection(quality.duplication, cap) : []),
    ...(quality.rules ? rulesSection(quality.rules, cap) : []),
    ...(quality.dependencies ? dependenciesSection(quality.dependencies, cap) : []),
    ...(quality.sast ? sastSection(quality.sast, cap) : []),
    ...(quality.properties ? propertiesSection(quality.properties, cap) : []),
    ...(quality.mutation ? mutationSection(quality.mutation, cap, quality.mutationBefore) : []),
  ];
}

/** Every dependency the run added, so the pull request shows each one for approval (#640). */
function dependenciesSection(result: DependencyResult, cap: number): string[] {
  if (!result.dependencies.length) return ["New dependencies: none.", ""];
  const blocking = result.dependencies.filter((d) => d.blocking).length;
  const out = [
    `New dependencies: ${result.dependencies.length}${blocking ? `, ${blocking} blocking` : ""}${result.lookups ? "" : " (registry lookups are off)"}.`,
    "",
  ];
  out.push(
    ...table(
      ["Package", "Ecosystem", "Verdict", "Where", "Detail"],
      result.dependencies.map((d) => [
        code(d.name),
        d.ecosystem,
        d.blocking ? `${d.verdict}, blocking` : d.verdict,
        code(`${d.file}:${d.line}`),
        d.detail,
      ]),
      cap,
    ),
    "",
  );
  return out;
}

function propertiesSection(result: PropertiesResult, cap: number): string[] {
  const found = result.criteria.filter((c) => c.status === "found").length;
  const waived = result.criteria.filter((c) => c.status === "waived").length;
  return [
    `Property-based tests: ${found} of ${result.criteria.length} marked criteria have one${waived ? `; ${waived} waived because the project has no property library` : ""}.`,
    "",
    ...table(
      ["Criterion", "Domain", "Status", "Property tests"],
      result.criteria.map((c) => [
        c.id,
        c.domain,
        c.note ? `${c.status}: ${c.note}` : c.status,
        c.tests
          .filter((t) => t.property)
          .map((t) =>
            t.kind === "seeded" || t.kind === "exhaustive"
              ? `${code(t.file)} (${t.kind})`
              : code(t.file),
          )
          .join(", ") || "-",
      ]),
      cap,
    ),
    "",
  ];
}

function mutationSection(
  result: MutationResult,
  cap: number,
  before: MutationResult | null = null,
): string[] {
  const count = (status: string) => result.mutants.filter((m) => m.status === status).length;
  // A timed-out mutant was detected and scores with the killed ones (#1534).
  const timeouts = count("timeout");
  const killed = count("killed") + timeouts;
  const ran = killed + count("survived");
  const blocking = result.mutants.filter((m) => m.blocking).length;
  const extra = [
    ...(count("not-run") ? [`${count("not-run")} not run`] : []),
    ...(count("equivalent") ? [`${count("equivalent")} judged equivalent`] : []),
  ];
  const score = result.score === null ? "no score" : `score ${result.score}%`;
  const engine = result.engine && result.engine !== "built-in" ? `, ${result.engine}` : "";
  const out = [
    `Mutation gate (\`${result.mode}\`${engine}): ${score} (${killed} of ${ran} mutants killed${timeouts ? " or timed out" : ""}${extra.length ? `, ${extra.join(", ")}` : ""})${blocking ? `, ${blocking} blocking` : ""}${result.tests.length ? `; tests: ${result.tests.map(code).join(", ")}` : ""}${result.note ? `; ${result.note}` : ""}.`,
    "",
  ];
  if (before)
    out.push(
      `Mutation score before the run: ${before.score === null ? "none" : `${before.score}%`} -> after: ${result.score === null ? "none" : `${result.score}%`}.`,
      "",
    );
  const survivors = result.mutants.filter(
    (m) => m.status === "survived" || m.status === "equivalent",
  );
  if (survivors.length)
    out.push(
      ...table(
        ["Mutant", "Where", "Mutated line", "Status"],
        survivors.map((m) => [
          m.id,
          code(`${m.file}:${m.line}`),
          m.description ? m.description : code(m.mutated.trim()),
          m.status === "equivalent"
            ? `equivalent: ${(m.equivalence ?? "").slice(0, 200)}`.trim()
            : m.blocking
              ? "survived, blocking"
              : "survived",
        ]),
        cap,
      ),
      "",
    );
  return out;
}

function sastSection(result: SastResult, cap: number): string[] {
  if (!result.ran) return [`Semgrep: not run (${result.note ?? "unknown reason"}).`, ""];
  const blocking = result.findings.filter((f) => f.blocking).length;
  const out = [
    `Semgrep (${code(result.config)}): ${blocking} blocking, ${result.findings.length - blocking} noted on the lines the run added${result.note ? `; ${result.note}` : ""}.`,
    "",
  ];
  if (result.findings.length)
    out.push(
      ...table(
        ["Rule", "Severity", "Where", "Message"],
        result.findings.map((f) => [
          code(f.rule),
          f.blocking ? `${f.severity}, blocking` : f.severity,
          code(`${f.file}:${f.line}`),
          f.message,
        ]),
        cap,
      ),
      "",
    );
  return out;
}

function rulesSection(result: RulesResult, cap: number): string[] {
  const blocking = result.findings.filter((f) => f.blocking).length;
  const out = [
    `Anti-slop rules: ${blocking} blocking, ${result.findings.length - blocking} noted on the lines the run added.`,
    "",
  ];
  if (result.disabled.length)
    out.push(`Turned off for this project: ${result.disabled.map(code).join(", ")}.`, "");
  if (result.astGrep)
    out.push(
      `Project ast-grep rules (${result.astGrep.files.map(code).join(", ")}): ${result.astGrep.ran ? "ran" : "not run"}${result.astGrep.note ? `; ${result.astGrep.note}` : ""}.`,
      "",
    );
  out.push(
    ...table(
      ["Rule", "Severity", "Where", "Line"],
      result.findings.map((f) => [
        code(f.rule),
        f.blocking
          ? `${f.severity}, blocking`
          : f.kept
            ? `${f.severity}, kept after its correction`
            : f.severity,
        code(`${f.file}:${f.line}`),
        code(f.text),
      ]),
      cap,
    ),
  );
  if (result.findings.length) out.push("");
  return out;
}

/** The duplication ratchet's deltas and what it found (#638). */
function duplicationSection(result: DuplicationResult, cap: number): string[] {
  const out: string[] = [];
  if (result.skipped) return [...out, `Duplication ratchet skipped: ${result.skipped}.`, ""];
  const verdict = result.blocking
    ? "blocking"
    : result.clones.length || result.unused.length
      ? "noted"
      : "clean";
  out.push(`Duplication ratchet (\`${result.mode}\`): ${verdict}.`, "");
  out.push(...metricDeltas(result).map((line) => `- ${line}`), "");
  const span = (s: { file: string; startLine: number; endLine: number }) =>
    code(`${s.file}:${s.startLine}-${s.endLine}`);
  out.push(
    ...table(
      ["Added", "Where", "Detail"],
      [
        ...result.clones.map((c) => ["copy", span(c), `copies ${span(c.original)}`]),
        ...result.unused.map((u) => [
          "unused code",
          code(`${u.file}:${u.line}`),
          `${code(u.name)} is used nowhere`,
        ]),
      ],
      cap,
    ),
  );
  if (result.clones.length || result.unused.length) out.push("");
  return out;
}

/** The first line of an unfinished run's summary: its status, reason, stage and task count. */
function unfinished(facts: Facts): string {
  const { run } = facts;
  const status = run.status.charAt(0).toUpperCase() + run.status.slice(1);
  const live = facts.tasks.filter((t) => t.status !== "cancelled");
  const done = live.filter((t) => ["implemented", "verified"].includes(t.status)).length;
  return `**${status}**${run.reason !== "none" ? ` (${run.reason})` : ""}${run.stage_id ? ` at ${code(run.stage_id)}` : ""}${live.length ? `: ${done} of ${live.length} tasks done` : ""}. The run did not complete, so the request is not done.`;
}

function render(facts: Facts, cap: number): string {
  const { run, state, report } = facts;
  const spec = state.spec;
  const title = spec?.title ?? run.feature_id;
  const verdicts = new Map(
    (state.convergence?.coverage ?? []).map((c) => [c.criterionId, c] as const),
  );
  const out: string[] = [`# ${title}`, ""];
  out.push(
    [
      `Run ${code(run.id)}`,
      `feature ${code(run.feature_id)}`,
      ...(facts.workflowId ? [`workflow ${code(facts.workflowId)}`] : []),
      `status **${run.status}**${run.reason !== "none" ? ` (${run.reason})` : ""}`,
      `verification ${state.verificationState.replaceAll("_", " ")}`,
    ].join(" · "),
    "",
  );

  const choice = state.presetChoice;
  if (choice)
    out.push(
      `Workflow proposed from the request: ${code(choice.proposed)}, ${choice.reason} (budget ${choice.budget}, ${choice.confidence} confidence)${choice.overridden ? `; the person chose ${code(choice.chosen)}` : ""}.`,
      "",
    );
  out.push("## Summary", "");
  // The spec outcome is the goal, not the result: a blocked run must not open its summary with it,
  // and a host-made spec only restates the request (741547f0, #1219).
  if (run.status !== "completed") out.push(unfinished(facts), "");
  if (spec && spec.outcome !== HOST_SPEC_OUTCOME) out.push(`Goal: ${spec.outcome}`, "");
  if (report) {
    out.push(report.summary, "");
    out.push(`Recommendation (${report.recommendation.kind}): ${report.recommendation.text}`, "");
  }
  if (!spec && !report) out.push(`Result of BAKED workflow run ${code(run.id)}.`, "");
  out.push("Request:", "", ...quote(state.prompt, PROMPT_CHARS), "");
  if (report?.findings.length) {
    out.push("### Report findings", "");
    out.push(
      ...list(
        report.findings.map(
          (f) =>
            `- **${cell(f.title)}**: ${cell(f.detail)}${f.paths.length ? ` (${f.paths.map(code).join(", ")})` : ""}`,
        ),
        cap,
      ),
      "",
    );
  }

  out.push("## Changes", "");
  if (facts.changes.length) {
    out.push(
      ...table(
        ["File", "Change", "Edits", "Status"],
        facts.changes.map((c) => [
          code(c.path),
          c.spec ? `${c.action} (spec)` : c.action,
          c.edits,
          c.status,
        ]),
        cap,
      ),
      "",
    );
  } else out.push("No files changed.", "");

  if (facts.tasks.length) {
    const done = facts.tasks.filter((t) => ["implemented", "verified"].includes(t.status)).length;
    // A task a later plan revision cancelled is history, not work the run still owes (#1190).
    const cancelled = facts.tasks.filter((t) => t.status === "cancelled").length;
    out.push(
      "## Tasks",
      "",
      `${done} of ${facts.tasks.length - cancelled} done${cancelled ? `; ${cancelled} cancelled by a plan revision` : ""}.`,
      "",
    );
    out.push(
      ...table(
        ["Task", "Title", "Status", "Origin", "Writes"],
        facts.tasks.map((t) => [t.id, t.title, t.status, t.origin, writesCell(t)]),
        cap,
      ),
      "",
    );
  }

  if (facts.selections.length) out.push("## Best-of-N", "", ...candidatesSection(facts, cap));

  out.push("## Checks", "");
  if (facts.checks.length) {
    // The Tests column appears only when some passing run reported a test count.
    const counted = facts.checks.some((c) => c.tests);
    out.push(
      ...table(
        ["Check", "Status", "Validity", "Runs", "Time", ...(counted ? ["Tests"] : [])],
        facts.checks.map((c) => [
          code(c.id),
          c.status,
          c.validity,
          c.runs,
          duration(c.ms),
          ...(counted ? [testsCell(c.tests)] : []),
        ]),
        cap,
      ),
      "",
    );
    const added = facts.checks.flatMap((c) =>
      c.tests && c.tests.before !== null ? [c.tests.after - c.tests.before] : [],
    );
    if (added.length)
      out.push(
        `Tests added against the code the run started from: ${signed(added.reduce((a, b) => a + b, 0))}.`,
        "",
      );
  } else out.push("No checks ran.", "");

  if (Object.values(facts.quality).some(Boolean))
    out.push("## Code quality", "", ...qualitySection(facts.quality, cap));

  if (spec?.criteria.length) {
    out.push("## Acceptance criteria", "");
    out.push(
      ...table(
        ["Criterion", "Verdict", "Method", "Given / when / then"],
        spec.criteria.map((c) => [
          c.id,
          verdicts.get(c.id)?.verdict ?? "not assessed",
          c.method,
          `Given ${c.given}; when ${c.when}; then ${c.then}`,
        ]),
        cap,
      ),
      "",
    );
  }
  if (state.convergence)
    out.push(`Final review: **${state.convergence.verdict.replaceAll("_", " ")}**.`, "");

  const open = facts.findings.filter((f) => f.status === "open" || f.status === "confirmed");
  out.push("## Findings", "");
  const reviewedBy = reviewModels(facts.routing, facts.usage);
  if (reviewedBy) out.push(reviewedBy, "");
  if (facts.findings.length) {
    out.push(`${open.length} open of ${facts.findings.length} recorded.`, "");
    out.push(
      ...table(
        ["Finding", "Status", "Severity", "Kind", "Repro", "Where", "Claim"],
        facts.findings.map((f) => [
          f.id,
          f.status,
          f.body.severity ?? null,
          f.body.kind ?? null,
          f.repro,
          f.body.file ? code(f.body.file) : null,
          f.body.claim ?? null,
        ]),
        cap,
      ),
      "",
    );
  } else out.push("No findings recorded.", "");

  if (facts.critiques.length) {
    out.push(
      "## Critic",
      "",
      "Advice only: each task attempt scored from 0 to 1 by a second model; the lowest rubric item is named.",
      "",
      ...table(
        ["Task", "Attempt", "Score", "Lowest", "Summary", "Outcome"],
        facts.critiques.map((c) => {
          if (!c.critique)
            return [
              c.taskId,
              c.attempt,
              null,
              null,
              `critic failed: ${c.error ?? "unknown"}`,
              null,
            ];
          const lowest = Object.entries(c.critique.rubric).sort(
            ([, a], [, b]) => a.score - b.score,
          )[0];
          return [
            c.taskId,
            c.attempt,
            c.critique.score.toFixed(2),
            lowest ? `${lowest[0]} ${lowest[1].score.toFixed(2)}: ${lowest[1].note}` : null,
            c.critique.summary,
            outcomeOf(
              facts.outcomes.find((o) => o.task_id === c.taskId && o.attempt === c.attempt),
            ),
          ];
        }),
        cap,
      ),
      "",
    );
  }

  if (state.limitations.length) {
    out.push(
      "## Known limitations",
      "",
      `${state.limitations.length} finding(s) were accepted instead of repaired, so the criteria they name may not hold in every case: a stopped convergence accepted by a person or the assume rule, or a low partial finding about test or documentation strength behind verified behavior (notes), or a convergence claim below high severity that its repro did not show (repro gate), or a review finding below high severity left when the review rounds were used up with every required check passing (review round limit), or an automated criterion only another environment can prove (for example another operating system), which the run could not verify.`,
      "",
      ...table(
        ["Finding", "Severity", "Criteria", "Where", "Claim", "Accepted by"],
        state.limitations.map((l) => [
          l.findingId,
          l.severity,
          l.criterionIds.join(", "),
          l.file ? code(l.symbol ? `${l.file}:${l.symbol}` : l.file) : null,
          l.claim,
          l.decidedBy === "assume"
            ? "assume rule (checks passed)"
            : l.decidedBy === "notes"
              ? "notes rule (behavior verified)"
              : l.decidedBy === "critic"
                ? "critic early stop (calibrated score, checks passed)"
                : l.decidedBy === "rule"
                  ? "rule pack (same match after its correction)"
                  : l.decidedBy === "repro"
                    ? "repro gate (claim not reproduced)"
                    : l.decidedBy === "review"
                      ? "review round limit (checks passed, below high)"
                      : "user",
        ]),
        cap,
      ),
      "",
    );
  }

  if (state.reviewNotes.length) {
    const why = {
      inferred: "inferred edge case",
      confidence: "below the confidence threshold",
      severity: "below the blocking severities",
      advisory: "advisory review",
      repro: "repro did not show it",
      owned_by_sibling: "owned by a sibling initiative feature",
    } as const;
    out.push(
      "## Review notes",
      "",
      `${state.reviewNotes.length} review finding(s) started no correction. They are kept here as notes: an edge case the spec does not name (basis inferred), a confidence below the review threshold, a severity below the ones this run repairs, an advisory review, a claim its repro did not show, or a path owned by a sibling initiative feature named in the claim. **Repeats** names the earlier note on the same kind, file and symbol that a later round raised again.`,
      "",
      ...table(
        ["Note", "Review", "Severity", "Kind", "Where", "Claim", "Why not repaired", "Repeats"],
        state.reviewNotes.map((n) => [
          n.findingId,
          n.source,
          n.severity,
          n.kind,
          n.file ? code(n.symbol ? `${n.file}:${n.symbol}` : n.file) : null,
          n.claim,
          why[n.reason],
          n.repeatOf,
        ]),
        cap,
      ),
      "",
    );
  }

  const decided = facts.requests.filter((r) => r.status !== "pending");
  const pending = facts.requests.filter((r) => r.status === "pending");
  const assumptions = spec?.assumptions ?? [];
  if (
    decided.length ||
    pending.length ||
    assumptions.length ||
    facts.amendments.length ||
    facts.settled.length
  ) {
    out.push("## Decisions", "");
    if (decided.length || pending.length)
      out.push(
        ...table(
          ["Request", "Kind", "Decision", "By"],
          [...decided, ...pending].map((r) => [
            r.id,
            r.kind.replaceAll("_", " "),
            r.status,
            r.actor ?? (r.status === "pending" ? "waiting" : null),
          ]),
          cap,
        ),
        "",
      );
    if (assumptions.length)
      out.push(
        "Assumptions:",
        "",
        ...list(
          assumptions.map((a) => `- ${cell(a)}`),
          cap,
        ),
        "",
      );
    // What tasks' conflicts settled and the platform limits finished tasks declared: reviewers
    // were given these, so findings asking for them again are notes (#1519, #1536).
    if (facts.settled.length)
      out.push(
        "Settled conflicts and declared platform limits:",
        "",
        ...list(
          facts.settled.map(
            (c) =>
              `- ${c.taskId}${c.declared ? " (declared limit)" : ""}: ${cell(c.report ? `${c.report} ${c.settled}` : c.settled)}`,
          ),
          cap,
        ),
        "",
      );
    // Review findings that put the spec against the request: the request won (#1034). Findings
    // on a run document after a deliberate departure: the implementation won (#1066).
    const amendmentList = (title: string, amendments: SpecAmendment[]) => {
      if (amendments.length)
        out.push(
          title,
          "",
          ...list(
            amendments.map(
              (a) =>
                `- ${[...a.criterionIds, ...a.requirementIds].join(", ") || "spec"}: ${cell(a.claim)} (finding ${a.findingId})`,
            ),
            cap,
          ),
          "",
        );
    };
    amendmentList(
      "Spec amendments (the request wins over the spec):",
      facts.amendments.filter((a) => !a.authority || a.authority === "request"),
    );
    amendmentList(
      "Spec amendments (the implementation wins over the spec):",
      facts.amendments.filter((a) => a.authority === "implementation"),
    );
    amendmentList(
      "Spec amendments (a requirement wins over a criterion that contradicts it):",
      facts.amendments.filter((a) => a.authority === "requirement"),
    );
  }

  const usage = facts.usage;
  const cost = run.estimated_cost_microusd;
  out.push("## Usage", "");
  out.push(
    [
      `${count(run.token_usage)} tokens`,
      ...(facts.policy.maxTotalTokens ? [`of ${count(facts.policy.maxTotalTokens)} budget`] : []),
    ].join(" ") +
      `, ${count(run.agent_calls)} agent calls, ${duration(run.active_ms)} active` +
      (cost !== null ? `, about $${(cost / 1e6).toFixed(2)}` : "") +
      ".",
    "",
  );
  if (usage.stages.length)
    out.push(
      ...table(
        ["Stage", "Attempts", "Tokens"],
        usage.stages.map((s) => [s.stage, s.attempts, count(s.tokens)]),
        cap,
      ),
      "",
    );
  if (usage.models.length)
    out.push(
      ...table(
        ["Model", "Attempts", "Tokens"],
        usage.models.map((m) => [code(m.model), m.attempts, count(m.tokens)]),
        cap,
      ),
      "",
    );
  const forecast = forecastLine(facts.forecasts, facts.forecastStopped);
  if (forecast) out.push(forecast, "");
  const backends = toolBackendLine(usage.toolBackends ?? []);
  if (backends) out.push(`Code intelligence: ${backends}.`, "");
  const tools = toolTokensLine(usage.tools ?? []);
  if (tools) out.push(`Tool calls (tokens of the steps that made them): ${tools}.`, "");

  if (state.hostEdits?.length)
    out.push(
      "## Host edits",
      "",
      `The host recorded ${state.hostEdits.length} task graph edits in ${code("host-edits.json")}. Host-only analysis findings are notes with their ledger entries in ${code("analysis/host-notes.json")} when present.`,
      "",
    );
  out.push("## Artifacts", "");
  const hidden = facts.internalArtifacts
    ? ` ${count(facts.internalArtifacts)} internal artifacts (attempt outputs, state, baselines) are not listed.`
    : "";
  if (facts.artifacts.length) {
    out.push(
      `Read one with ${code(`baked workflow artifacts ${run.id} --file ID`)}.${hidden}`,
      "",
      ...table(
        ["Artifact", "Kind", "ID", "Bytes"],
        facts.artifacts.map((a) => [
          code(a.logical_path),
          a.kind,
          code(a.id),
          count(a.byte_length),
        ]),
        cap,
      ),
      "",
    );
  } else out.push(`No artifacts.${hidden}`, "");

  return `${out.join("\n").trimEnd()}\n`;
}

/** The labels the critic outcome log holds for an attempt so far, or null. */
function outcomeOf(row: CriticOutcomeRow | undefined): string | null {
  if (!row) return null;
  const parts = [
    row.task_result === "passed"
      ? "checks passed"
      : row.task_result === "repaired"
        ? "repaired"
        : null,
    row.acceptance,
    row.delivery,
    row.survival === null
      ? null
      : `${Math.round(row.survival * 100)}% of lines kept${row.survival_final ? "" : " so far"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Renders the run report. With `maxChars`, long tables and lists are shortened step by step and,
 * as a last resort, the text is cut with a note, so the result always fits.
 */
export function runReport(
  store: WorkflowStore,
  runId: string,
  options: RunReportOptions = {},
): string {
  const facts = collect(store, runId);
  const appendix = options.appendix ? `\n${options.appendix.trimEnd()}\n` : "";
  const limit = (options.maxChars ?? Number.POSITIVE_INFINITY) - appendix.length;
  let text = "";
  for (const cap of ROW_CAPS) {
    text = render(facts, cap);
    if (text.length <= limit) return `${text}${appendix}`;
  }
  const note = `\n\n_Report shortened; \`baked workflow report ${runId}\` prints all of it._\n`;
  return `${text.slice(0, Math.max(0, limit - note.length)).trimEnd()}${note}${appendix}`;
}
