import { useState } from "react";
import type { AttentionItem } from "../../../shared/api.js";
import { kindLabel } from "../../../shared/attention.js";
import {
  type ApprovalBody,
  answersOf,
  attentionApi,
  type ClarificationBody,
  parseBody,
  questionsOf,
  type RunWithRequests,
} from "../../client/attention.js";
import { projectHref } from "../../router.js";
import {
  ActionError,
  DetailHeader,
  Fact,
  Loading,
  RejectForm,
  useAction,
  useLoad,
} from "./common.js";

export interface DetailProps {
  item: AttentionItem;
  /** Called after the item was answered, with what happens next. */
  onDone: (message: string, next?: string) => void;
}

/** A run item always has a run ID; the screen picks run details only for run items. */
const runIdOf = (item: AttentionItem): string => item.runId ?? "";

function useRun(item: AttentionItem) {
  return useLoad(
    () => attentionApi.run(item.projectKey, runIdOf(item)),
    `${item.projectKey}:${item.runId}:${item.requestId}`,
  );
}

function requestOf(run: RunWithRequests, item: AttentionItem) {
  return run.requests.find((r) => r.id === item.requestId);
}

function OpenRun({ item }: { item: AttentionItem }) {
  return (
    <a className="btn att-btn" href={projectHref(item.projectKey, "runs", runIdOf(item))}>
      Open run
    </a>
  );
}

export function ApprovalDetail({ item, onDone }: DetailProps) {
  const [load] = useRun(item);
  const action = useAction();
  const [exclude, setExclude] = useState(false);
  return (
    <Loading load={load}>
      {(run) => {
        const request = requestOf(run, item);
        if (!request) return <Gone item={item} />;
        const body = parseBody<ApprovalBody>(request);
        const writes = body.writes ?? [];
        const inScope = body.worktree?.userChangesInScope ?? [];
        return (
          <>
            <DetailHeader
              item={item}
              aside={
                <span className="att-aside">
                  {writes.length} {writes.length === 1 ? "file" : "files"} ·{" "}
                  {body.checks?.length ?? 0} checks
                </span>
              }
            />
            <p className="att-lede">
              Approving starts implementation of exactly this specification, plan and task graph.
              Review them in the run first if you have not.
            </p>
            <div className="att-facts">
              <Fact label="Runs in">
                {body.executionMode === "worktree" && body.worktree ? (
                  <span className="mono">{body.worktree.branch}</span>
                ) : (
                  "the working copy"
                )}
              </Fact>
              <Fact label="Agents">{body.profiles?.join(", ") || "–"}</Fact>
              <Fact label="Checks">
                {body.checks?.length ? body.checks.map((c) => c.id).join(", ") : "none"}
              </Fact>
            </div>
            <section className="card att-list" aria-label="Files the tasks write">
              <span className="label">Files the tasks write</span>
              {writes.length === 0 && <span className="muted">No file writes declared.</span>}
              {writes.map((write) => (
                <div key={write.path} className="att-row">
                  <span className="mono">{write.path}</span>
                  <span className="muted">{write.action}</span>
                </div>
              ))}
            </section>
            {body.assumptions?.length ? (
              <section className="card att-list" aria-label="Assumptions">
                <span className="label">Assumptions the agents made instead of asking</span>
                {body.assumptions.map((assumption, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: assumptions may repeat
                  <div key={i} className="att-row">
                    <span>{assumption}</span>
                  </div>
                ))}
              </section>
            ) : null}
            {body.deferredCriteria?.length ? (
              <p className="att-note">
                Checked after release, not by this run: {body.deferredCriteria.join(", ")}.
              </p>
            ) : null}
            {inScope.length > 0 && (
              <div className="banner">
                <p style={{ margin: "0 0 8px" }}>
                  You have uncommitted changes in files these tasks write:{" "}
                  <span className="mono">{inScope.join(", ")}</span>. The worktree starts from HEAD
                  without them.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={exclude}
                    onChange={(event) => setExclude(event.target.checked)}
                  />
                  Leave my uncommitted changes out of this run
                </label>
              </div>
            )}
            <ActionError error={action.error} />
            <div className="att-actions">
              <button
                type="button"
                className="btn-primary att-btn"
                disabled={action.busy || (inScope.length > 0 && !exclude)}
                onClick={() =>
                  void action.run(async () => {
                    await attentionApi.approve(item.projectKey, runIdOf(item), request, exclude);
                    onDone(`Approved ${item.featureId}. The run continues.`);
                  })
                }
              >
                Approve
              </button>
              <RejectForm
                busy={action.busy}
                onReject={(reason) =>
                  void action.run(async () => {
                    await attentionApi.reject(item.projectKey, runIdOf(item), request.id, reason);
                    onDone(`Rejected the plan of ${item.featureId}.`);
                  })
                }
              />
              <OpenRun item={item} />
            </div>
          </>
        );
      }}
    </Loading>
  );
}

export function ClarificationDetail({ item, onDone }: DetailProps) {
  const [load] = useRun(item);
  const action = useAction();
  const [answers, setAnswers] = useState<string[]>([]);
  return (
    <Loading load={load}>
      {(run) => {
        const request = requestOf(run, item);
        if (!request) return <Gone item={item} />;
        const questions = questionsOf(parseBody<ClarificationBody>(request));
        const missing = questions.some((q, i) => q.blocking && !answers[i]?.trim());
        const none = questions.every((_q, i) => !answers[i]?.trim());
        return (
          <form
            className="att-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                await attentionApi.answer(
                  item.projectKey,
                  runIdOf(item),
                  request.id,
                  answersOf(questions, answers),
                );
                onDone(`Answered ${item.featureId}. The run continues.`);
              });
            }}
          >
            <DetailHeader item={item} />
            <p className="att-lede">
              The run stopped at stage {run.stageId ?? "–"} with questions only you can answer.
            </p>
            {questions.map((question, index) => (
              <div key={question.key} className="card att-question">
                <label htmlFor={`att-q-${index}`}>
                  <span className="mono muted">{question.key}</span> {question.text}
                  {!question.blocking && <span className="muted"> (optional)</span>}
                </label>
                <textarea
                  id={`att-q-${index}`}
                  className="att-input"
                  rows={2}
                  value={answers[index] ?? ""}
                  onChange={(event) => {
                    const next = [...answers];
                    next[index] = event.target.value;
                    setAnswers(next);
                  }}
                />
              </div>
            ))}
            <ActionError error={action.error} />
            <div className="att-actions">
              <button
                type="submit"
                className="btn-primary att-btn"
                disabled={action.busy || missing || none}
              >
                Answer and continue
              </button>
              <OpenRun item={item} />
            </div>
          </form>
        );
      }}
    </Loading>
  );
}

/** Items "Needs you" does not answer itself: they open in the run. */
export function RunDetail({ item }: DetailProps) {
  return (
    <>
      <DetailHeader item={item} />
      <p className="att-lede">
        {item.requestId === null
          ? "The run is blocked and needs a look before it can continue."
          : item.blocking
            ? `The run waits for a ${kindLabel(item.kind)} decision. Answer it in the run.`
            : `For your review: the run continues without it. Record it in the run when you can.`}
      </p>
      <div className="att-actions">
        <a
          className="btn-primary att-btn"
          href={projectHref(item.projectKey, "runs", runIdOf(item))}
        >
          Open run
        </a>
      </div>
    </>
  );
}

export function InitiativeDetail({ item }: DetailProps) {
  return (
    <>
      <DetailHeader item={item} />
      <p className="att-lede">
        The initiative {item.title ? <strong>{item.title}</strong> : item.initiativeId} waits for
        your {kindLabel(item.kind)} before it drives its features further.
      </p>
      <div className="att-actions">
        <a className="btn-primary att-btn" href={projectHref(item.projectKey, "initiatives")}>
          Open initiatives
        </a>
      </div>
    </>
  );
}

export function Gone({ item }: { item: AttentionItem }) {
  return (
    <>
      <DetailHeader item={item} />
      <p className="att-lede">This request was already answered or replaced.</p>
    </>
  );
}
