import type { RunData } from "./load.js";
import { type Finding, type RunTrace, taskCount, taskState } from "./model.js";

export function SpecView({ data, preview = false }: { data: RunData; preview?: boolean }) {
  const spec = data.artifacts.spec;
  if (!spec) return <div className="empty">No spec yet. Specify writes it.</div>;
  if (preview)
    return (
      <article className="card prose">
        <h3>Spec preview</h3>
        {spec.requirements.slice(0, 4).map((r) => (
          <p key={r.id}>
            <strong>{r.id}.</strong> {r.text}
          </p>
        ))}
        {spec.requirements.length > 4 && (
          <p className="muted">and {spec.requirements.length - 4} more requirements</p>
        )}
      </article>
    );
  return (
    <article className="card prose">
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
          <span className="muted small">
            {r.priority} · {r.verification}
          </span>
        </p>
      ))}
      <h4>Acceptance criteria</h4>
      {spec.criteria.map((c) => (
        <p key={c.id}>
          <strong>{c.id}.</strong> Given {c.given}, when {c.when}, then {c.then}{" "}
          <span className="muted small">{c.method}</span>
        </p>
      ))}
    </article>
  );
}

export function PlanView({ data }: { data: RunData }) {
  const plan = data.artifacts.plan;
  if (!plan) return <div className="empty">No plan yet. Plan writes it.</div>;
  return <pre className="card doc">{plan}</pre>;
}

export function ChangesView({ data, trace }: { data: RunData; trace: RunTrace }) {
  const graph = data.artifacts.graph;
  const rows =
    graph?.tasks.flatMap((t) =>
      t.writes.map((w) => ({ ...w, task: t, state: taskState(t, trace) })),
    ) ?? [];
  if (!rows.length) return <div className="empty">No file changes planned yet.</div>;
  return (
    <div className="table-wrap">
      <p className="lede">Files the tasks write, with the state of the task that writes them.</p>
      <table className="table">
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
              <td className="mono">{r.path}</td>
              <td>{r.action}</td>
              <td className="mono">{r.task.id}</td>
              <td className={`state-${r.state}`}>{r.state === "done" ? "written" : r.state}</td>
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
  if (!checks.length && !gates.length) return <div className="empty">No checks have run yet.</div>;
  const tone = (s: string): string => (s === "passed" ? "ok" : s === "failed" ? "err" : "warn");
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Check or gate</th>
            <th>Result</th>
            <th className="num">Runs</th>
          </tr>
        </thead>
        <tbody>
          {checks.map(([id, c]) => (
            <tr key={`c:${id}`}>
              <td className="mono">{id}</td>
              <td className={`${tone(c.status)}-text`}>{c.status}</td>
              <td className="mono num">{c.runs}</td>
            </tr>
          ))}
          {gates.map(([id, g]) => (
            <tr key={`g:${id}`}>
              <td className="mono">
                {id} <span className="muted">gate · {g.mode}</span>
              </td>
              <td className={`${tone(g.status)}-text`}>
                {g.status}
                {g.flaky ? " (flaky)" : ""}
              </td>
              <td className="mono num">{g.attempts}</td>
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
      <div className="empty">
        {trace.findings.size ? "Reading findings…" : "Reviews have recorded no findings."}
      </div>
    );
  return (
    <ul className="findings">
      {findings.map((f) => (
        <li key={f.id} className={`card finding ${SEVERITY[f.severity] ?? ""}`}>
          <div className="finding-head">
            <span className={`pill ${SEVERITY[f.severity] ?? ""}`}>{f.severity}</span>
            <span className="muted">{f.kind}</span>
            {f.file && <span className="mono small">{f.file}</span>}
          </div>
          <p>{f.claim}</p>
          <p className="small sub-text">Impact: {f.impact}</p>
          <p className="small sub-text">Suggested fix: {f.suggestedFix}</p>
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
    <div className="overview">
      {spec ? (
        <article className="card prose">
          <h3>{spec.title}</h3>
          <p>{spec.outcome}</p>
        </article>
      ) : (
        <div className="empty">The spec appears here once Specify writes it.</div>
      )}
      <dl className="facts">
        <div>
          <dt>Tasks</dt>
          <dd className="mono">{tasks.total ? `${tasks.done}/${tasks.total} integrated` : "–"}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd className="mono">
            {checks.length ? `${checks.length - failed} passed, ${failed} failed` : "–"}
          </dd>
        </div>
        <div>
          <dt>Criteria</dt>
          <dd className="mono">
            {verdicts.length
              ? `${verdicts.filter((v) => v === "pass").length}/${verdicts.length} pass`
              : "–"}
          </dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd className="mono">{trace.findings.size}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd className="mono">{[...trace.models].join(", ") || "–"}</dd>
        </div>
      </dl>
    </div>
  );
}
