import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import {
  approveRequest,
  errorText,
  GROUP_B_CAPABILITY,
  type RecoveryResolution,
  type RunRequest,
  runs,
} from "../../client/runs.js";
import { workflow } from "../../client/workflow.js";
import { type TestsFirstBody, TestsFirstReview } from "../../components/TestsFirst.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { CHECK } from "../../lib/styles.js";
import { href } from "../../router.js";
import type { RunData } from "./load.js";
import { stageLabel } from "./model.js";
import {
  type ApprovalBody,
  answersOf,
  approvalReviewText,
  type ClarificationBody,
  type ConvergenceBody,
  parse,
  questionsOf,
  type RecoveryBody,
} from "./requests.js";

/** A request card: its heading and paragraphs carry the warning tone. */
export const DECISION =
  "flex flex-col gap-3 rounded-base border-2 border-l-8 border-border border-l-fill-warn bg-[color-mix(in_srgb,var(--warn)_7%,var(--bg-panel))] px-5 py-[18px] shadow-shadow [&_h3]:m-0 [&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:text-[var(--warn)] [&_p]:m-0 [&_p]:leading-[1.6] [&_p]:text-soft-foreground";
export const FIELD_LABEL = "text-[12px] text-dim-foreground";
export const STACK_FORM = "flex flex-col gap-2";
export const ROW_ACTIONS = "flex flex-wrap gap-2";
/** Text inputs in run forms keep the taller padding of the multi-line fields. */
export const TEXT_INPUT = "px-[10px] py-2";
const TEXTAREA =
  "resize-y rounded-base border-2 border-border bg-secondary-background px-[10px] py-2 text-foreground [font:inherit]";

/** Runs a decision, then resumes the run the way `baked workflow` does after a decision. */
export function useDecide(projectKey: string, onDone: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (work: () => Promise<RunSnapshot>, resume = true): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const after = await work();
      if (resume && !["completed", "failed", "cancelled", "running"].includes(after.status))
        await workflow.resume(projectKey, after);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return { busy, error, decide };
}

export function Questions({
  projectKey,
  run,
  request,
  onDone,
  compact = false,
}: {
  projectKey: string;
  run: RunSnapshot;
  request: RunRequest;
  onDone: () => Promise<void>;
  compact?: boolean;
}) {
  const questions = questionsOf(parse<ClarificationBody>(request.body_json));
  const [answers, setAnswers] = useState<string[]>([]);
  const { busy, error, decide } = useDecide(projectKey, onDone);
  const filled = Object.keys(answersOf(questions, answers)).length > 0;
  return (
    <form
      className={STACK_FORM}
      onSubmit={(e) => {
        e.preventDefault();
        void decide(() =>
          workflow.answer(projectKey, run, request.id, answersOf(questions, answers)),
        );
      }}
    >
      {questions.map((q, i) => (
        <label key={q.key} className="flex flex-col gap-[6px] text-soft-foreground">
          <span>
            {!compact && <span className="font-mono text-dim-foreground">{q.key} </span>}
            {q.text}
            {q.blocking && !compact && <span className="text-[var(--warn)]"> · blocking</span>}
          </span>
          <textarea
            className={TEXTAREA}
            rows={compact ? 2 : 2}
            value={answers[i] ?? ""}
            onChange={(e) => {
              const next = [...answers];
              next[i] = e.target.value;
              setAnswers(next);
            }}
          />
        </label>
      ))}
      {error && <Alert tone="error">{error}</Alert>}
      <div className={ROW_ACTIONS}>
        <Button type="submit" variant="primary" size="md" disabled={busy || !filled}>
          {compact ? "Answer" : "Send answers"}
        </Button>
      </div>
    </form>
  );
}

function Approval({
  projectKey,
  data,
  request,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  request: RunRequest;
  onDone: () => Promise<void>;
}) {
  const body = parse<ApprovalBody>(request.body_json);
  const [note, setNote] = useState("");
  const [exclude, setExclude] = useState(false);
  const { busy, error, decide } = useDecide(projectKey, onDone);
  const run = data.status;
  const tasks = data.artifacts.graph?.tasks.length ?? 0;
  const scope = body.worktree?.userChangesInScope ?? [];
  const where =
    body.executionMode === "worktree"
      ? ` in the worktree ${body.worktree?.branch ?? ""}`.trimEnd()
      : " in the working copy";
  const files = body.writes?.length ?? 0;
  const tests = parse<TestsFirstBody>(request.body_json).testsFirst;
  if (tests)
    return (
      <div className={DECISION}>
        <h3>The tests written first wait for your approval</h3>
        <p>
          These tests fail on the current code. Approving makes them read-only and lets the agents
          write the code until they pass. Rejecting writes them again with your note.
        </p>
        <TestsFirstReview tests={tests} />
        <label htmlFor="decision-note" className={FIELD_LABEL}>
          Note for the agents (needed to reject)
        </label>
        <textarea
          className={TEXTAREA}
          id="decision-note"
          rows={2}
          value={note}
          placeholder="What the tests should check instead"
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <div className={ROW_ACTIONS}>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => void decide(() => approveRequest(projectKey, run, request))}
          >
            Approve the tests
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy || !note.trim()}
            onClick={() =>
              void decide(() => workflow.reject(projectKey, run, request.id, note.trim()))
            }
          >
            Write them again
          </Button>
        </div>
      </div>
    );
  return (
    <div className={DECISION}>
      <h3>
        {tasks
          ? "The spec, plan and tasks wait for your approval"
          : `${stageLabel(run.stageId ?? "approval")} waits for your approval`}
      </h3>
      <p>
        {tasks
          ? `Approving starts implementation with ${tasks} task${tasks === 1 ? "" : "s"}${where}${files ? `, writing ${files} file${files === 1 ? "" : "s"}` : ""}.`
          : "Approving lets the run continue."}{" "}
        Rejecting sends your note back to the agents.
      </p>
      {body.autoApproval?.declined?.length ? (
        <div>
          <span className={FIELD_LABEL}>Why auto approval left this to you</span>
          <ul className="m-[4px_0_0] pl-[18px] leading-[1.6] text-soft-foreground">
            {body.autoApproval.declined.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {approvalReviewText(body.autoApproval) && (
            <p className="m-[6px_0_0] text-soft-foreground">
              {approvalReviewText(body.autoApproval)}
            </p>
          )}
        </div>
      ) : null}
      {body.requestCoverage?.length ? (
        <div>
          <span className={FIELD_LABEL}>What the request asks for and what covers it</span>
          <ul className="m-[4px_0_0] pl-[18px] leading-[1.6] text-soft-foreground">
            {body.requestCoverage.map((row) => (
              <li key={row.deliverable} className={row.mapped ? undefined : "font-semibold"}>
                {row.deliverable}:{" "}
                {row.requirementIds.length
                  ? [...row.requirementIds, ...row.criterionIds].join(", ")
                  : row.outOfScope
                    ? `out of scope ("${row.outOfScope}")`
                    : "not covered by the spec"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {body.assumptions?.length ? (
        <div>
          <span className={FIELD_LABEL}>Assumptions the agents made instead of asking</span>
          <ul className="m-[4px_0_0] pl-[18px] leading-[1.6] text-soft-foreground">
            {body.assumptions.map((assumption, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: assumptions may repeat
              <li key={i}>{assumption}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {scope.length > 0 && (
        <label className={CHECK}>
          <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
          <span>
            Leave out my uncommitted changes in {scope.join(", ")} (the worktree starts from HEAD)
          </span>
        </label>
      )}
      <label htmlFor="decision-note" className={FIELD_LABEL}>
        Note for the agents (needed to reject)
      </label>
      <textarea
        className={TEXTAREA}
        id="decision-note"
        rows={2}
        value={note}
        placeholder="What should change before implementation"
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <Alert tone="error">{error}</Alert>}
      <div className={ROW_ACTIONS}>
        <Button
          variant="primary"
          size="md"
          disabled={busy || (scope.length > 0 && !exclude)}
          onClick={() => void decide(() => approveRequest(projectKey, run, request, exclude))}
        >
          {tasks ? "Approve and implement" : "Approve"}
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={busy || !note.trim()}
          onClick={() =>
            void decide(() => workflow.reject(projectKey, run, request.id, note.trim()))
          }
        >
          Reject with note
        </Button>
      </div>
    </div>
  );
}

/**
 * Convergence stopped with findings open: the person accepts them as known limitations, allows one
 * more repair round, or stops the run (it stays paused and can be resumed later).
 */
function Convergence({
  projectKey,
  data,
  request,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  request: RunRequest;
  onDone: () => Promise<void>;
}) {
  const body = parse<ConvergenceBody>(request.body_json);
  const { busy, error, decide } = useDecide(projectKey, onDone);
  const run = data.status;
  const groupB = data.capabilities.includes(GROUP_B_CAPABILITY);
  const failing = body.criteria?.failing ?? [];
  return (
    <div className={DECISION}>
      <h3>Repairs stopped with findings still open</h3>
      <p>{body.summary ?? "Convergence cannot start another repair round."}</p>
      {body.criteria && (
        <p>
          {`${body.criteria.passing} of ${body.criteria.total} criteria pass${failing.length ? `; failing: ${failing.map((c) => c.id).join(", ")}` : ""}. Required checks ${body.checksPassing ? "pass" : "do not all pass"}.`}
        </p>
      )}
      <ul className="m-0 pl-[18px] leading-[1.6] text-soft-foreground">
        {(body.findings ?? []).map((f) => (
          <li key={f.id}>
            <strong>{f.severity}</strong> {f.claim}
            {f.file ? ` (${f.file}${f.symbol ? `:${f.symbol}` : ""})` : ""}
          </li>
        ))}
      </ul>
      {(body.contradictions ?? []).map((c) => (
        <p
          key={c.findingId}
        >{`${c.findingId} repeats ${c.earlierId}, which a correction already addressed: ${c.earlierClaim}`}</p>
      ))}
      {body.hostRule && (
        <p>{`Under assume the host would ${body.hostRule.decision}: ${body.hostRule.why} Rules: ${body.hostRule.rules.join(" ")}`}</p>
      )}
      <p>
        Accepting lists these findings as known limitations in the run report and goes on to
        acceptance. One more round repairs them again.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {groupB ? (
        <div className={ROW_ACTIONS}>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => void decide(() => runs.accept(projectKey, run, request.id))}
          >
            Accept as known limitations
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => void decide(() => runs.continue(projectKey, run, request.id))}
          >
            One more round
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() =>
              void decide(
                () =>
                  workflow.reject(
                    projectKey,
                    run,
                    request.id,
                    "Stopped at the convergence decision",
                  ),
                false,
              )
            }
          >
            Stop here
          </Button>
        </div>
      ) : (
        <p className="text-dim-foreground">Deciding from the app needs a newer BAKED.</p>
      )}
    </div>
  );
}

/** The outcomes of an interrupted effect, in the order and words of the terminal UI. */
export const RESOLUTIONS: readonly { value: RecoveryResolution; label: string }[] = [
  { value: "record-applied", label: "It ran and its effect is in place" },
  { value: "record-not-applied", label: "It did not run or had no effect" },
  { value: "retry", label: "Allow a new attempt" },
  { value: "cancel", label: "Cancel the whole run (all its processes are stopped)" },
];

/** What the interrupted effect was meant to do, from the request body, in one line. */
export function effectSummary(body: RecoveryBody): string {
  const intent = body.intent;
  if (!intent || !Object.keys(intent).length) return "";
  const text = JSON.stringify(intent);
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function Recovery({
  projectKey,
  data,
  request,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  request: RunRequest;
  onDone: () => Promise<void>;
}) {
  const body = parse<RecoveryBody>(request.body_json);
  const [resolution, setResolution] = useState<RecoveryResolution | null>(null);
  const [evidence, setEvidence] = useState("");
  const { busy, error, decide } = useDecide(projectKey, onDone);
  const run = data.status;
  const effectId = body.effectId;
  const intent = effectSummary(body);
  const command = `baked workflow recover ${run.runId} --request ${request.id}`;
  return (
    <div className={DECISION}>
      <h3>{body.delivery ? "A delivery step was interrupted" : "A command was interrupted"}</h3>
      <p>
        BAKED cannot tell whether it finished, and nothing is replayed automatically. Check what
        happened, then record the outcome.
      </p>
      {effectId && (
        <p className="font-mono text-[12px] break-all text-dim-foreground">
          Effect {effectId}
          {intent && `: ${intent}`}
        </p>
      )}
      {body.note && <p>{body.note}</p>}
      {!data.capabilities.includes(GROUP_B_CAPABILITY) || !effectId ? (
        <p>
          Resolve it in the terminal: <code className="font-mono">{command}</code>
        </p>
      ) : (
        <form
          className={STACK_FORM}
          onSubmit={(e) => {
            e.preventDefault();
            if (!resolution || !evidence.trim()) return;
            void decide(() =>
              runs.recover(projectKey, run, {
                requestId: request.id,
                effectId,
                resolution,
                evidence: evidence.trim(),
              }),
            );
          }}
        >
          <fieldset className="m-0 flex flex-col border-0 p-0">
            <legend className={FIELD_LABEL}>What happened</legend>
            {RESOLUTIONS.map((r) => (
              <label key={r.value} className={CHECK}>
                <input
                  type="radio"
                  name={`recovery-${request.id}`}
                  value={r.value}
                  checked={resolution === r.value}
                  onChange={() => setResolution(r.value)}
                />
                <span>{r.label}</span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={`recovery-evidence-${request.id}`} className={FIELD_LABEL}>
            What you checked (process stopped, files observed)
          </label>
          <textarea
            id={`recovery-evidence-${request.id}`}
            className={TEXTAREA}
            rows={3}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          {error && <Alert tone="error">{error}</Alert>}
          <div className={ROW_ACTIONS}>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={busy || !resolution || !evidence.trim()}
            >
              Record outcome
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export function DecisionCard({
  projectKey,
  data,
  request,
  onDone,
  onCriteria,
}: {
  projectKey: string;
  data: RunData;
  request: RunRequest;
  onDone: () => Promise<void>;
  onCriteria: () => void;
}) {
  const groupB = data.capabilities.includes(GROUP_B_CAPABILITY);
  const { busy, error, decide } = useDecide(projectKey, onDone);
  switch (request.kind) {
    case "approval":
      return <Approval projectKey={projectKey} data={data} request={request} onDone={onDone} />;
    case "clarification":
      return (
        <div className={DECISION}>
          <h3>The agents have questions</h3>
          <p>Answers go back to the stage that asked; the run continues after you send them.</p>
          <Questions projectKey={projectKey} run={data.status} request={request} onDone={onDone} />
        </div>
      );
    case "manual_evidence":
      return (
        <div className={DECISION}>
          <h3>A criterion needs your observation</h3>
          <p>Check it by hand and record what you saw in Criteria.</p>
          <div className={ROW_ACTIONS}>
            <Button variant="primary" size="md" onClick={onCriteria}>
              Open criteria
            </Button>
          </div>
        </div>
      );
    case "checkpoint":
      return (
        <div className={DECISION}>
          <h3>The run paused at a budget checkpoint</h3>
          <p>Continue to spend up to the next checkpoint, or leave it paused.</p>
          {error && <Alert tone="error">{error}</Alert>}
          {groupB ? (
            <div className={ROW_ACTIONS}>
              <Button
                variant="primary"
                size="md"
                disabled={busy}
                onClick={() =>
                  void decide(() => runs.continue(projectKey, data.status, request.id))
                }
              >
                Continue
              </Button>
            </div>
          ) : (
            <p className="text-dim-foreground">Continuing from the app needs a newer BAKED.</p>
          )}
        </div>
      );
    case "convergence":
      return <Convergence projectKey={projectKey} data={data} request={request} onDone={onDone} />;
    case "delivery":
      return (
        <div className={DECISION}>
          <h3>A delivery plan waits for approval</h3>
          <p>
            Review the commit and pull request in{" "}
            <a href={href({ name: "attention" })}>Needs you</a>.
          </p>
        </div>
      );
    case "recovery":
      return <Recovery projectKey={projectKey} data={data} request={request} onDone={onDone} />;
    default:
      return (
        <div className={DECISION}>
          <h3>The run waits for a decision</h3>
          <p>
            This app does not know the request <code className="font-mono">{request.kind}</code>{" "}
            yet. See it in the terminal:{" "}
            <code className="font-mono">baked workflow status {data.status.runId}</code>
          </p>
        </div>
      );
  }
}
