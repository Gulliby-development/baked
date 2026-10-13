/**
 * One Markdown report of a run: what was asked and done, tasks, checks, acceptance criteria,
 * findings, decisions, token usage by stage and model, and the run's artifacts. Delivery uses it
 * as the pull request body; `baked workflow report` and the local API return it.
 */

import type { z } from "zod";
import { modelVendor } from "../llm/model-vendor.js";
import {
  type DuplicationResult,
  metricDeltas,
  QUALITY_DUPLICATION,
} from "./quality/duplication.js";
import { QUALITY_RULES, type RulesResult } from "./quality/rules.js";
import { ReportSchema, type ReviewSchema, type RunPolicy, TaskSchema } from "./schemas.js";
import type { ArtifactRow, WorkflowStore } from "./store.js";
import { type RunUsageReport, runUsage, toolBackendLine } from "./usage.js";
import { parseRunDefinition } from "./v2/runtime.js";
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
    // What the host's run of each finding's repro showed, by finding id.
    const reproOutcomes = new Map<string, string>();
    for (const artifact of store.artifacts(runId)) {
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
      { status: string; validity: string; runs: number; ms: number }
    >();
    for (const row of store.checkDetails(runId)) {
      const known = checks.get(row.check_id);
      checks.set(row.check_id, {
        status: row.status,
        validity: row.validity,
        runs: (known?.runs ?? 0) + 1,
        ms: (known?.ms ?? 0) + row.duration_ms,
      });
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
      duplication: readJson<DuplicationResult>(QUALITY_DUPLICATION),
      rules: readJson<RulesResult>(QUALITY_RULES),
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
      usage: stagesInRunOrder(store, runUsage(store, runId)),
      artifacts: [...latestArtifacts.values()].filter((a) => !internalArtifact(a.logical_path)),
      internalArtifacts: [...latestArtifacts.values()].filter((a) =>
        internalArtifact(a.logical_path),
      ).length,
    };
  });
}
type Facts = ReturnType<typeof collect>;

/** Which models and vendors reviewed the change and which implemented it (#635). */
function reviewModels(routing: Facts["routing"]): string | null {
  if (!routing) return null;
  const models = (targets: string[]) => [
    ...new Set(routing.effective.filter((r) => targets.includes(r.target)).map((r) => r.model)),
  ];
  const named = (list: string[]) =>
    list.map((model) => `${code(model)} (${modelVendor(model)})`).join(", ");
  const review = models(["reviewer", "spec-auditor"]);
  const implementation = models(["implementer"]);
  if (!review.length) return null;
  return `Reviewed on ${named(review)}${implementation.length ? `; implemented on ${named(implementation)}` : ""}.`;
}

/** The code quality gates: the duplication ratchet (#638) and the anti-slop rules (#639). */
function qualitySection(
  duplication: DuplicationResult | null,
  rules: RulesResult | null,
  cap: number,
): string[] {
  return [
    ...(duplication ? duplicationSection(duplication, cap) : []),
    ...(rules ? rulesSection(rules, cap) : []),
  ];
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
        f.blocking ? `${f.severity}, blocking` : f.severity,
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
  if (spec) out.push(spec.outcome, "");
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
    out.push("## Tasks", "", `${done} of ${facts.tasks.length} done.`, "");
    out.push(
      ...table(
        ["Task", "Title", "Status", "Origin"],
        facts.tasks.map((t) => [t.id, t.title, t.status, t.origin]),
        cap,
      ),
      "",
    );
  }

  out.push("## Checks", "");
  if (facts.checks.length)
    out.push(
      ...table(
        ["Check", "Status", "Validity", "Runs", "Time"],
        facts.checks.map((c) => [code(c.id), c.status, c.validity, c.runs, duration(c.ms)]),
        cap,
      ),
      "",
    );
  else out.push("No checks ran.", "");

  if (facts.duplication || facts.rules)
    out.push("## Code quality", "", ...qualitySection(facts.duplication, facts.rules, cap));

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
  const reviewedBy = reviewModels(facts.routing);
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

  if (state.limitations.length) {
    out.push(
      "## Known limitations",
      "",
      `${state.limitations.length} finding(s) were accepted instead of repaired, so the criteria they name may not hold in every case: a stopped convergence accepted by a person or the assume rule, or a low partial finding about test or documentation strength behind verified behavior (notes), or an automated criterion only another environment can prove (for example another operating system), which the run could not verify.`,
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
    } as const;
    out.push(
      "## Review notes",
      "",
      `${state.reviewNotes.length} review finding(s) started no correction. They are kept here as notes: an edge case the spec does not name (basis inferred), a confidence below the review threshold, a severity below the ones this run repairs, an advisory review, or a claim its repro did not show. **Repeats** names the earlier note on the same kind, file and symbol that a later round raised again.`,
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
  if (decided.length || pending.length || assumptions.length) {
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
  const backends = toolBackendLine(usage.toolBackends ?? []);
  if (backends) out.push(`Code intelligence: ${backends}.`, "");

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
