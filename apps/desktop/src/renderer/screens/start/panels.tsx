import { type ReactNode, useEffect, useState } from "react";
import {
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  type PreRunEstimate,
  type PreRunInput,
  start,
} from "../../client/start.js";
import { tokens } from "../../format.js";
import {
  FIT_TEXT,
  fitOf,
  orderChecks,
  rangeText,
  shortModel,
  stageLabel,
  usdRange,
} from "./logic.js";

export { doctorLine } from "./logic.js";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const GLYPH: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "·" };

export function DoctorChecks({ checks, limit }: { checks: DoctorCheck[]; limit?: number }) {
  const shown = orderChecks(checks).slice(0, limit);
  return (
    <ul className="start-checks">
      {shown.map((check) => (
        <li
          key={`${check.id}:${check.subject ?? check.title}`}
          className={`start-check ${check.status}`}
        >
          <span className="mono start-glyph" aria-hidden="true">
            {GLYPH[check.status]}
          </span>
          <span className="stack">
            <span>
              <span className="sr-only">{check.status}: </span>
              {check.title}
            </span>
            {(check.detail || check.fix) && (
              <span className="start-check-detail">
                {[check.detail, check.fix].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DoctorPanel({
  report,
  error,
  loading,
  footer,
}: {
  report: DoctorReport | null;
  error: string | null;
  loading: boolean;
  footer?: ReactNode;
}) {
  return (
    <section aria-label="Doctor" className="card start-panel" aria-busy={loading}>
      <div className="start-panel-head">
        <h2 className="label">Doctor</h2>
        {report && (
          <span className={`start-state ${report.ready ? "ok" : "err"}`}>
            {report.ready ? "ready to start" : "not ready"}
          </span>
        )}
      </div>
      {error ? (
        <p className="start-note err">{error}</p>
      ) : report ? (
        <DoctorChecks checks={report.checks} />
      ) : (
        <p className="start-note">Checking…</p>
      )}
      {footer}
    </section>
  );
}

export function EstimatePanel({
  estimate,
  error,
  loading,
  cap,
  checkpoint,
}: {
  estimate: PreRunEstimate | null;
  error: string | null;
  loading: boolean;
  /** The token cap of the chosen budget preset; null for no cap. */
  cap: number | null;
  checkpoint: number | null;
}) {
  const fit = estimate ? fitOf(estimate.tokens, cap) : null;
  return (
    <section aria-label="Estimate" className="card start-panel" aria-busy={loading}>
      <div className="start-panel-head">
        <h2 className="label">Estimate</h2>
        {estimate && (
          <span className="start-note">
            {estimate.basis === "defaults"
              ? "generic range: no earlier runs"
              : `${estimate.samples} earlier run${estimate.samples === 1 ? "" : "s"}${
                  estimate.basis === "workflow-history" ? ` of ${estimate.workflowId}` : ""
                }`}
          </span>
        )}
      </div>
      {error ? (
        <p className="start-note err">{error}</p>
      ) : !estimate ? (
        <p className="start-note">Estimating…</p>
      ) : (
        <>
          <div className="start-total">
            <span className="mono start-tokens">{rangeText(estimate.tokens)} tokens</span>
            <span className="mono start-cost">
              {usdRange(estimate.costUsd)}
              {estimate.costUsd && !estimate.costComplete ? " (partial)" : ""}
            </span>
            {fit && (
              <span className={`start-fit ${fit}`}>
                {cap === null
                  ? `no token cap, pauses every ${tokens(checkpoint ?? 0)}`
                  : FIT_TEXT[fit]}
              </span>
            )}
          </div>
          <div className="start-table-wrap">
            <table className="table start-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Model</th>
                  <th className="num">Tokens</th>
                  <th className="num">USD</th>
                </tr>
              </thead>
              <tbody>
                {estimate.stages.map((stage) => (
                  <tr key={stage.stageId}>
                    <td>{stageLabel(stage.stageId)}</td>
                    <td className="mono start-model">
                      {stage.models.length ? stage.models.map(shortModel).join(", ") : "host"}
                    </td>
                    <td className="mono num">{rangeText(stage.tokens)}</td>
                    <td className="mono num">{usdRange(stage.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {estimate.notes.length > 0 && (
            <ul className="start-notes">
              {estimate.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

interface PreRunState {
  doctor: DoctorReport | null;
  doctorError: string | null;
  estimate: PreRunEstimate | null;
  estimateError: string | null;
  loading: boolean;
}

/**
 * The doctor and the estimate for the form's inputs, fetched again a moment after the inputs
 * stop changing; an answer for inputs that have changed since is dropped.
 */
export function usePreRun(key: string, input: PreRunInput, delayMs = 350): PreRunState {
  const [state, setState] = useState<PreRunState>({
    doctor: null,
    doctorError: null,
    estimate: null,
    estimateError: null,
    loading: true,
  });
  const { workflow, model, worktree, writers } = input;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      const request: PreRunInput = { workflow, model, worktree, writers };
      void Promise.allSettled([start.doctor(key, request), start.estimate(key, request)]).then(
        ([doctor, estimate]) => {
          if (!live) return;
          setState({
            doctor: doctor.status === "fulfilled" ? doctor.value : null,
            doctorError: doctor.status === "rejected" ? message(doctor.reason) : null,
            estimate: estimate.status === "fulfilled" ? estimate.value : null,
            estimateError: estimate.status === "rejected" ? message(estimate.reason) : null,
            loading: false,
          });
        },
      );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, workflow, model, worktree, writers, delayMs]);
  return state;
}

/** A value loaded once per project, with its error. */
export function useLoad<T>(
  key: string,
  load: (key: string) => Promise<T>,
): { value: T | null; error: unknown } {
  const [state, setState] = useState<{ value: T | null; error: unknown }>({
    value: null,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a module-level function.
  useEffect(() => {
    let live = true;
    setState({ value: null, error: null });
    load(key).then(
      (value) => live && setState({ value, error: null }),
      (error: unknown) => live && setState({ value: null, error }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

export { message };
