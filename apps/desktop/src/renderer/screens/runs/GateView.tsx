import { useState } from "react";
import { approveRequest, GROUP_B_CAPABILITY, runs } from "../../client/runs.js";
import { workflow } from "../../client/workflow.js";
import {
  type AcceptanceDecision,
  type GateCriterion,
  gateView,
  type Verdict,
} from "./acceptance.js";
import {
  DECISION,
  FIELD_LABEL,
  ROW_ACTIONS,
  STACK_FORM,
  TEXT_INPUT,
  useDecide,
} from "./Decision.js";
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
const CRITERION = "flex gap-3 rounded-[var(--radius-lg)] border-2 px-[14px] py-3 shadow-sm-hard";
/** A criterion card and its verdict mark, by tone. */
const CRITERION_TONE: Record<string, { card: string; mark: string }> = {
  ok: { card: `${CRITERION} border-border bg-background`, mark: "text-[var(--ok)]" },
  err: {
    card: `${CRITERION} border-[color:var(--err)] bg-[color-mix(in_srgb,var(--err)_7%,var(--bg-panel))]`,
    mark: "text-[var(--err)]",
  },
  warn: {
    card: `${CRITERION} border-[color:var(--warn)] bg-[color-mix(in_srgb,var(--warn)_7%,var(--bg-panel))]`,
    mark: "text-[var(--warn)]",
  },
  "": { card: `${CRITERION} border-border bg-background`, mark: "text-dim-foreground" },
};
const COLUMN = "flex min-w-0 flex-[1_1_380px] flex-col gap-[10px]";
const SUB = "text-[12px] text-muted-foreground";
const CODE =
  "m-0 whitespace-pre-wrap rounded-[var(--radius-lg)] border-2 border-border bg-[var(--bg-code)] px-[14px] py-3 font-mono text-[12.5px] leading-[1.6] text-soft-foreground [overflow-wrap:anywhere]";

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
    return (
      <span className="muted text-[12px]">Recording observations here needs a newer BAKED.</span>
    );
  const id = `obs-${criterion.key}`;
  const mark = (accepted: boolean) =>
    void decide(() => runs.evidence(projectKey, data.status, requestId, text.trim(), accepted));
  return (
    <div className={STACK_FORM}>
      <label htmlFor={id} className={FIELD_LABEL}>
        Your observation
      </label>
      <input
        id={id}
        type="text"
        className={TEXT_INPUT}
        value={text}
        placeholder="What you saw"
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="banner error">{error}</div>}
      <div className={ROW_ACTIONS}>
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
    <section className={DECISION} aria-label="Acceptance test">
      <h3>Keep the acceptance test for {decision.gateId}?</h3>
      <p>
        The walk-through {decision.verdict} and the drafted test passed {decision.stableRuns} runs
        in a row. Keeping it adds <span className="mono">{decision.testPath}</span> as a command
        gate; the run does not wait for this decision.
      </p>
      <details>
        <summary>Show the test</summary>
        <pre className={CODE}>{decision.testContent}</pre>
      </details>
      <label htmlFor={`reason-${decision.requestId}`} className={FIELD_LABEL}>
        Reason to discard
      </label>
      <input
        id={`reason-${decision.requestId}`}
        type="text"
        className={TEXT_INPUT}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <div className="banner error">{error}</div>}
      <div className={ROW_ACTIONS}>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() =>
            void decide(
              () =>
                approveRequest(projectKey, run, {
                  id: decision.requestId,
                  digest: decision.digest,
                }),
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {heading && <h2 className="m-0 text-[18px]">{heading}</h2>}
        <Pill tone={tone}>
          {view.passed} of {view.total} passed
        </Pill>
        {view.setup && (
          <span className="font-mono text-[12px] text-dim-foreground">{view.setup}</span>
        )}
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
      <div className="flex flex-wrap gap-6">
        <section aria-label="Criteria" className={COLUMN}>
          <h3 className="label">Acceptance criteria</h3>
          <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
            {view.criteria.map((c) => (
              <li key={c.key} className={CRITERION_TONE[TONE[c.verdict]]?.card}>
                <span
                  className={`mono ${CRITERION_TONE[TONE[c.verdict]]?.mark}`}
                  aria-hidden="true"
                >
                  {MARK[c.verdict]}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
                  <span>
                    <span className="mono muted">{c.label}.</span> {c.text}
                    <span className="sr-only">, {c.verdict}</span>
                  </span>
                  {c.note && <span className={SUB}>{c.note}</span>}
                  {c.verdict === "manual" && (
                    <span className="text-[12px]">Needs a manual observation from you.</span>
                  )}
                  <Observation projectKey={projectKey} data={data} criterion={c} onDone={onDone} />
                  {c.steps.length > 0 && (
                    <button
                      type="button"
                      className="cursor-pointer self-start border-none bg-transparent p-0 text-[var(--accent)] underline [font:inherit] aria-pressed:text-foreground"
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
        <section aria-label="Evidence" className={COLUMN}>
          <h3 className="label">{chosen ? `Evidence for ${chosen.label}` : "Evidence"}</h3>
          {!chosen && (
            <div className="empty">The AI acceptance walk-through records steps as evidence.</div>
          )}
          {chosen && (
            <>
              <figure className="m-0 flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border-2 border-border bg-background shadow-shadow">
                <div className="mono border-b-2 border-border px-3 py-2 text-[12px] text-dim-foreground">
                  {chosen.url ?? "terminal"}
                </div>
                <pre className="m-0 max-h-[320px] min-h-[160px] overflow-auto whitespace-pre-wrap bg-[var(--bg-sunken)] p-3 font-mono text-[12px] leading-[1.5] text-muted-foreground">
                  {chosen.steps.at(-1)?.frame || "No frame recorded"}
                </pre>
                <figcaption className="px-3 py-[10px] text-[13px] text-muted-foreground">
                  {chosen.steps.at(-1)?.observation}
                </figcaption>
              </figure>
              <ol className={`${CODE} flex list-none flex-col gap-[6px]`}>
                {chosen.steps.map((s) => (
                  <li key={s.stepId}>
                    <div>{s.action}</div>
                    <div className="text-muted-foreground">→ {s.observation}</div>
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
