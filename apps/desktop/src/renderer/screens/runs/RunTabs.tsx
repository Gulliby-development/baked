import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { LEDE, PANEL, TABLE } from "../../lib/styles.js";
import type { RunData } from "./load.js";
import { type Finding, type RunTrace, taskCount, taskState } from "./model.js";
import { Pill, TONE_TEXT } from "./parts.js";

const PROSE = `${PANEL} leading-[1.65] text-soft-foreground [&_h3]:m-[0_0_8px] [&_h3]:text-[14px] [&_h3]:text-foreground [&_h4]:m-[14px_0_6px] [&_h4]:text-[13px] [&_h4]:text-foreground [&_p]:m-[0_0_8px] [&_strong]:text-foreground`;
const SUB = "text-[12px] text-muted-foreground";
/** The colour of a task's state in the task tables. */
export const STATE_TEXT: Record<string, string> = {
  done: "text-[var(--ok)]",
  running: "text-[var(--info)]",
  failed: "text-[var(--err)]",
  blocked: "text-[var(--err)]",
};
const FACT = "rounded-base border-2 border-border px-3 py-[10px]";
const FACT_TERM = "text-[12px] text-dim-foreground";
const FACT_VALUE = "m-[4px_0_0] font-mono text-foreground";

export function SpecView({ data, preview = false }: { data: RunData; preview?: boolean }) {
  const spec = data.artifacts.spec;
  if (!spec) return <Empty>No spec yet. Specify writes it.</Empty>;
  if (preview)
    return (
      <article className={PROSE}>
        <h3>Spec preview</h3>
        {spec.requirements.slice(0, 4).map((r) => (
          <p key={r.id}>
            <strong>{r.id}.</strong> {r.text}
          </p>
        ))}
        {spec.requirements.length > 4 && (
          <p className="text-dim-foreground">
            and {spec.requirements.length - 4} more requirements
          </p>
        )}
      </article>
    );
  return (
    <article className={PROSE}>
      <h3>{spec.title}</h3>
      <p>
        <strong>Problem.</strong> {spec.problem}
      </p>
      <p>
        <strong>Outcome.</strong> {spec.outcome}
      </p>
      <h4>In scope</h4>
      <ul>
        {spec.inScope.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {spec.outOfScope.length > 0 && (
        <>
          <h4>Out of scope</h4>
          <ul>
            {spec.outOfScope.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
      <h4>Requirements</h4>
      {spec.requirements.map((r) => (
        <p key={r.id}>
          <strong>{r.id}.</strong> {r.text}{" "}
          <span className="text-[12px] text-dim-foreground">
            {r.priority} · {r.verification}
          </span>
        </p>
      ))}
      <h4>Acceptance criteria</h4>
      {spec.criteria.map((c) => (
        <p key={c.id}>
          <strong>{c.id}.</strong> Given {c.given}, when {c.when}, then {c.then}{" "}
          <span className="text-[12px] text-dim-foreground">{c.method}</span>
        </p>
      ))}
    </article>
  );
}

export function PlanView({ data }: { data: RunData }) {
  const plan = data.artifacts.plan;
  if (!plan) return <Empty>No plan yet. Plan writes it.</Empty>;
  return (
    <pre
      className={cn(
        PANEL,
        "m-0 whitespace-pre-wrap font-mono text-[12.5px] leading-[1.6] text-soft-foreground [overflow-wrap:anywhere]",
      )}
    >
      {plan}
    </pre>
  );
}

export function ChangesView({ data, trace }: { data: RunData; trace: RunTrace }) {
  const graph = data.artifacts.graph;
  const rows =
    graph?.tasks.flatMap((t) =>
      t.writes.map((w) => ({ ...w, task: t, state: taskState(t, trace) })),
    ) ?? [];
  if (!rows.length) return <Empty>No file changes planned yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <p className={LEDE}>Files the tasks write, with the state of the task that writes them.</p>
      <table className={TABLE}>
        <thead>
          <tr>
            <th>File</th>
            <th>Action</th>
            <th>Task</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.task.id}:${r.path}`}>
              <td className="font-mono">{r.path}</td>
              <td>{r.action}</td>
              <td className="font-mono">{r.task.id}</td>
              <td className={STATE_TEXT[r.state]}>{r.state === "done" ? "written" : r.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChecksView({ trace }: { trace: RunTrace }) {
  const checks = [...trace.checks.entries()];
  const gates = [...trace.gates.entries()];
  if (!checks.length && !gates.length) return <Empty>No checks have run yet.</Empty>;
  const tone = (s: string): string => (s === "passed" ? "ok" : s === "failed" ? "err" : "warn");
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr>
            <th>Check or gate</th>
            <th>Result</th>
            <th className="text-right">Runs</th>
          </tr>
        </thead>
        <tbody>
          {checks.map(([id, c]) => (
            <tr key={`c:${id}`}>
              <td className="font-mono">{id}</td>
              <td className={TONE_TEXT[tone(c.status)]}>{c.status}</td>
              <td className="text-right font-mono">{c.runs}</td>
            </tr>
          ))}
          {gates.map(([id, g]) => (
            <tr key={`g:${id}`}>
              <td className="font-mono">
                {id} <span className="text-dim-foreground">gate · {g.mode}</span>
              </td>
              <td className={TONE_TEXT[tone(g.status)]}>
                {g.status}
                {g.flaky ? " (flaky)" : ""}
              </td>
              <td className="text-right font-mono">{g.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function findingsOf(data: RunData, trace: RunTrace): Finding[] {
  const byId = new Map<string, Finding>();
  for (const review of data.artifacts.reviews)
    for (const finding of review.findings)
      if (trace.findings.has(finding.id)) byId.set(finding.id, finding);
  return [...byId.values()];
}

const SEVERITY: Record<string, string> = { critical: "err", high: "err", medium: "warn", low: "" };
export function FindingsView({ data, trace }: { data: RunData; trace: RunTrace }) {
  const findings = findingsOf(data, trace);
  if (!findings.length)
    return (
      <Empty>
        {trace.findings.size ? "Reading findings…" : "Reviews have recorded no findings."}
      </Empty>
    );
  return (
    <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
      {findings.map((f) => (
        <li key={f.id} className={cn(PANEL, "[&_p]:m-[6px_0_0]")}>
          <div className="flex flex-wrap items-center gap-[10px]">
            <Pill tone={SEVERITY[f.severity] ?? ""}>{f.severity}</Pill>
            <span className="text-dim-foreground">{f.kind}</span>
            {f.file && <span className="font-mono text-[12px]">{f.file}</span>}
          </div>
          <p>{f.claim}</p>
          <p className={SUB}>Impact: {f.impact}</p>
          <p className={SUB}>Suggested fix: {f.suggestedFix}</p>
        </li>
      ))}
    </ul>
  );
}

export function OverviewView({ data, trace }: { data: RunData; trace: RunTrace }) {
  const spec = data.artifacts.spec;
  const tasks = taskCount(data.artifacts.graph, trace);
  const checks = [...trace.checks.values()];
  const failed = checks.filter((c) => c.status === "failed").length;
  const verdicts = [...trace.criteria.values()];
  return (
    <div className="flex flex-col gap-[14px]">
      {spec ? (
        <article className={PROSE}>
          <h3>{spec.title}</h3>
          <p>{spec.outcome}</p>
        </article>
      ) : (
        <Empty>The spec appears here once Specify writes it.</Empty>
      )}
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        <div className={FACT}>
          <dt className={FACT_TERM}>Tasks</dt>
          <dd className={FACT_VALUE}>
            {tasks.total ? `${tasks.done}/${tasks.total} integrated` : "–"}
          </dd>
        </div>
        <div className={FACT}>
          <dt className={FACT_TERM}>Checks</dt>
          <dd className={FACT_VALUE}>
            {checks.length ? `${checks.length - failed} passed, ${failed} failed` : "–"}
          </dd>
        </div>
        <div className={FACT}>
          <dt className={FACT_TERM}>Criteria</dt>
          <dd className={FACT_VALUE}>
            {verdicts.length
              ? `${verdicts.filter((v) => v === "pass").length}/${verdicts.length} pass`
              : "–"}
          </dd>
        </div>
        <div className={FACT}>
          <dt className={FACT_TERM}>Findings</dt>
          <dd className={FACT_VALUE}>{trace.findings.size}</dd>
        </div>
        <div className={FACT}>
          <dt className={FACT_TERM}>Models</dt>
          <dd className={FACT_VALUE}>{[...trace.models].join(", ") || "–"}</dd>
        </div>
      </dl>
    </div>
  );
}
