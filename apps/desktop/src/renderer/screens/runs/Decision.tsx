import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import {
  approveRequest,
  errorText,
  GROUP_B_CAPABILITY,
  type RunRequest,
  runs,
} from "../../client/runs.js";
import { workflow } from "../../client/workflow.js";
import { href } from "../../router.js";
import type { RunData } from "./load.js";
import { stageLabel } from "./model.js";
import {
  type ApprovalBody,
  answersOf,
  type ClarificationBody,
  parse,
  questionsOf,
} from "./requests.js";

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
      className="stack-form"
      onSubmit={(e) => {
        e.preventDefault();
        void decide(() =>
          workflow.answer(projectKey, run, request.id, answersOf(questions, answers)),
        );
      }}
    >
      {questions.map((q, i) => (
        <label key={q.key} className="question">
          <span>
            {!compact && <span className="mono muted">{q.key} </span>}
            {q.text}
            {q.blocking && !compact && <span className="warn-text"> · blocking</span>}
          </span>
          <textarea
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
      {error && <div className="banner error">{error}</div>}
      <div className="row-actions">
        <button type="submit" className="btn-primary" disabled={busy || !filled}>
          {compact ? "Answer" : "Send answers"}
        </button>
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
  return (
    <div className="decision">
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
      {body.assumptions?.length ? (
        <div className="decision-assumptions">
          <span className="field-label">Assumptions the agents made instead of asking</span>
          <ul>
            {body.assumptions.map((assumption, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: assumptions may repeat
              <li key={i}>{assumption}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {scope.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
          <span>
            Leave out my uncommitted changes in {scope.join(", ")} (the worktree starts from HEAD)
          </span>
        </label>
      )}
      <label htmlFor="decision-note" className="field-label">
        Note for the agents (needed to reject)
      </label>
      <textarea
        id="decision-note"
        rows={2}
        value={note}
        placeholder="What should change before implementation"
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <div className="banner error">{error}</div>}
      <div className="row-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || (scope.length > 0 && !exclude)}
          onClick={() => void decide(() => approveRequest(projectKey, run, request, exclude))}
        >
          {tasks ? "Approve and implement" : "Approve"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !note.trim()}
          onClick={() =>
            void decide(() => workflow.reject(projectKey, run, request.id, note.trim()))
          }
        >
          Reject with note
        </button>
      </div>
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
        <div className="decision">
          <h3>The agents have questions</h3>
          <p>Answers go back to the stage that asked; the run continues after you send them.</p>
          <Questions projectKey={projectKey} run={data.status} request={request} onDone={onDone} />
        </div>
      );
    case "manual_evidence":
      return (
        <div className="decision">
          <h3>A criterion needs your observation</h3>
          <p>Check it by hand and record what you saw in Criteria.</p>
          <div className="row-actions">
            <button type="button" className="btn-primary" onClick={onCriteria}>
              Open criteria
            </button>
          </div>
        </div>
      );
    case "checkpoint":
      return (
        <div className="decision">
          <h3>The run paused at a budget checkpoint</h3>
          <p>Continue to spend up to the next checkpoint, or leave it paused.</p>
          {error && <div className="banner error">{error}</div>}
          {groupB ? (
            <div className="row-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  void decide(() => runs.continue(projectKey, data.status, request.id))
                }
              >
                Continue
              </button>
            </div>
          ) : (
            <p className="muted">Continuing from the app needs a newer BAKED.</p>
          )}
        </div>
      );
    case "delivery":
      return (
        <div className="decision">
          <h3>A delivery plan waits for approval</h3>
          <p>
            Review the commit and pull request in{" "}
            <a href={href({ name: "attention" })}>Needs you</a>.
          </p>
        </div>
      );
    default:
      return (
        <div className="decision">
          <h3>An effect needs a recovery decision</h3>
          <p>
            Resolve it in the terminal:{" "}
            <code className="mono">
              baked workflow recover {data.status.runId} --request {request.id}
            </code>
          </p>
        </div>
      );
  }
}
