import { useState } from "react";
import { GROUP_B_CAPABILITY, runs } from "../../client/runs.js";
import { workflow } from "../../client/workflow.js";
import {
  type AcceptanceDecision,
  type GateCriterion,
  gateView,
  type Verdict,
} from "./acceptance.js";
import { useDecide } from "./Decision.js";
import type { RunData } from "./load.js";
import type { RunTrace } from "./model.js";
import { Pill } from "./parts.js";

const MARK: Record<Verdict, string> = {
  pass: "✓",
  fail: "✗",
  inconclusive: "?",
  deferred: "↷",
  manual: "⚑",
  pending: "·",
};
const TONE: Record<Verdict, string> = {
  pass: "ok",
  fail: "err",
  inconclusive: "warn",
  deferred: "",
  manual: "warn",
  pending: "",
};

function Observation({
  projectKey,
  data,
  criterion,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  criterion: GateCriterion;
  onDone: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const { busy, error, decide } = useDecide(projectKey, onDone);
  const requestId = criterion.manualRequestId;
  if (!requestId) return null;
  if (!data.capabilities.includes(GROUP_B_CAPABILITY))
    return <span className="small muted">Recording observations here needs a newer BAKED.</span>;
  const id = `obs-${criterion.key}`;
  const mark = (accepted: boolean) =>
    void decide(() => runs.evidence(projectKey, data.status, requestId, text.trim(), accepted));
  return (
    <div className="stack-form">
      <label htmlFor={id} className="field-label">
        Your observation
      </label>
      <input
        id={id}
        type="text"
        value={text}
        placeholder="What you saw"
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="banner error">{error}</div>}
      <div className="row-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !text.trim()}
          onClick={() => mark(true)}
        >
          Mark passed
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !text.trim()}
          onClick={() => mark(false)}
        >
          Mark failed
        </button>
      </div>
    </div>
  );
}

function TestDecision({
  projectKey,
  data,
  decision,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  decision: AcceptanceDecision;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, decide } = useDecide(projectKey, onDone);
  const run = data.status;
  return (
    <section className="decision" aria-label="Acceptance test">
      <h3>Keep the acceptance test for {decision.gateId}?</h3>
      <p>
        The walk-through {decision.verdict} and the drafted test passed {decision.stableRuns} runs
        in a row. Keeping it adds <span className="mono">{decision.testPath}</span> as a command
        gate; the run does not wait for this decision.
      </p>
      <details>
        <summary>Show the test</summary>
        <pre className="code">{decision.testContent}</pre>
      </details>
      <label htmlFor={`reason-${decision.requestId}`} className="field-label">
        Reason to discard
      </label>
      <input
        id={`reason-${decision.requestId}`}
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <div className="banner error">{error}</div>}
      <div className="row-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() =>
            void decide(
              () =>
                workflow.approve(
                  projectKey,
                  { ...run, approvalDigest: decision.digest },
                  decision.requestId,
                ),
              false,
            )
          }
        >
          Keep test
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !reason.trim()}
          onClick={() =>
            void decide(
              () => workflow.reject(projectKey, run, decision.requestId, reason.trim()),
              false,
            )
          }
        >
          Discard
        </button>
      </div>
    </section>
  );
}

export function GateView({
  projectKey,
  data,
  trace,
  onDone,
  heading,
}: {
  projectKey: string;
  data: RunData;
  trace: RunTrace;
  onDone: () => Promise<void>;
  /** Shown above the criteria on the Acceptance screen; the run's Criteria tab has its own. */
  heading?: string;
}) {
  const view = gateView({
    spec: data.artifacts.spec,
    trace,
    reviews: data.artifacts.reviews,
    walks: data.artifacts.walks,
    gates: data.artifacts.gates,
    requests: data.status.requests,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const chosen =
    view.criteria.find((c) => c.key === selected) ??
    view.criteria.find((c) => c.steps.length > 0 && c.verdict !== "pass") ??
    view.criteria.find((c) => c.steps.length > 0) ??
    null;
  if (view.total === 0)
    return (
      <div className="empty">
        No acceptance criteria yet. They come with the spec and the AI acceptance gates.
      </div>
    );
  const tone =
    view.passed === view.total
      ? "ok"
      : view.criteria.some((c) => c.verdict === "fail")
        ? "err"
        : "warn";
  return (
    <div className="gate">
      <div className="gate-head">
        {heading && <h2>{heading}</h2>}
        <Pill tone={tone}>
          {view.passed} of {view.total} passed
        </Pill>
        {view.setup && <span className="meta">{view.setup}</span>}
      </div>
      {view.decisions.map((d) => (
        <TestDecision
          key={d.requestId}
          projectKey={projectKey}
          data={data}
          decision={d}
          onDone={onDone}
        />
      ))}
      <div className="gate-body">
        <section aria-label="Criteria" className="gate-criteria">
          <h3 className="label">Acceptance criteria</h3>
          <ul className="criteria">
            {view.criteria.map((c) => (
              <li key={c.key} className={`criterion ${TONE[c.verdict]}`}>
                <span className="mono mark" aria-hidden="true">
                  {MARK[c.verdict]}
                </span>
                <div className="criterion-body">
                  <span>
                    <span className="mono muted">{c.label}.</span> {c.text}
                    <span className="sr-only">, {c.verdict}</span>
                  </span>
                  {c.note && <span className="small sub-text">{c.note}</span>}
                  {c.verdict === "manual" && (
                    <span className="small">Needs a manual observation from you.</span>
                  )}
                  <Observation projectKey={projectKey} data={data} criterion={c} onDone={onDone} />
                  {c.steps.length > 0 && (
                    <button
                      type="button"
                      className="link-button small"
                      aria-pressed={chosen?.key === c.key}
                      onClick={() => setSelected(c.key)}
                    >
                      Evidence: {c.steps.length} step{c.steps.length === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Evidence" className="gate-evidence">
          <h3 className="label">{chosen ? `Evidence for ${chosen.label}` : "Evidence"}</h3>
          {!chosen && (
            <div className="empty">The AI acceptance walk-through records steps as evidence.</div>
          )}
          {chosen && (
            <>
              <figure className="frame">
                <div className="frame-bar mono">{chosen.url ?? "terminal"}</div>
                <pre className="frame-body">
                  {chosen.steps.at(-1)?.frame || "No frame recorded"}
                </pre>
                <figcaption>{chosen.steps.at(-1)?.observation}</figcaption>
              </figure>
              <ol className="code steps">
                {chosen.steps.map((s) => (
                  <li key={s.stepId}>
                    <div>{s.action}</div>
                    <div className="sub-text">→ {s.observation}</div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
