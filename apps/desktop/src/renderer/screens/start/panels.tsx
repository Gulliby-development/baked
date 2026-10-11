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
import { cn } from "../../lib/cn.js";
import { PANEL as CARD, LABEL, STACK, TABLE } from "../../lib/styles.js";
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

const GLYPH_TONE: Record<DoctorStatus, string> = {
  ok: "text-[color:var(--ok)]",
  warn: "text-[color:var(--warn)]",
  fail: "text-[color:var(--err)]",
  skip: "text-dim-foreground",
};

const FIT_TONE: Record<ReturnType<typeof fitOf>, string> = {
  yes: "text-[color:var(--ok)]",
  maybe: "text-[color:var(--warn)]",
  no: "text-[color:var(--err)]",
};

/** A card of the start screens: the doctor, the estimate and the project home's side panels. */
export const PANEL = cn(CARD, "flex flex-col gap-[10px]");
export const NOTE = "m-0 text-[13px] leading-[1.5] text-muted-foreground";
export const NOTE_ERR = "m-0 text-[13px] leading-[1.5] text-[color:var(--err)]";
const PANEL_HEAD = "flex items-center gap-[10px]";
const CELL = "px-[10px] py-2";

export function DoctorChecks({ checks, limit }: { checks: DoctorCheck[]; limit?: number }) {
  const shown = orderChecks(checks).slice(0, limit);
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {shown.map((check) => (
        <li
          key={`${check.id}:${check.subject ?? check.title}`}
          className="flex gap-[10px] text-[13px] text-soft-foreground"
        >
          <span
            className={`w-[1ch] flex-none font-mono ${GLYPH_TONE[check.status]}`}
            aria-hidden="true"
          >
            {GLYPH[check.status]}
          </span>
          <span className={STACK}>
            <span>
              <span className="sr-only">{check.status}: </span>
              {check.title}
            </span>
            {(check.detail || check.fix) && (
              <span className="text-[12px] text-dim-foreground">
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
    <section aria-label="Doctor" className={PANEL} aria-busy={loading}>
      <div className={PANEL_HEAD}>
        <h2 className={LABEL}>Doctor</h2>
        {report && (
          <span
            className={`ml-auto text-[13px] ${report.ready ? "text-[color:var(--ok)]" : "text-[color:var(--err)]"}`}
          >
            {report.ready ? "ready to start" : "not ready"}
          </span>
        )}
      </div>
      {error ? (
        <p className={NOTE_ERR}>{error}</p>
      ) : report ? (
        <DoctorChecks checks={report.checks} />
      ) : (
        <p className={NOTE}>Checking…</p>
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
    <section aria-label="Estimate" className={PANEL} aria-busy={loading}>
      <div className={PANEL_HEAD}>
        <h2 className={LABEL}>Estimate</h2>
        {estimate && (
          <span className={`${NOTE} ml-auto`}>
            {estimate.basis === "defaults"
              ? "generic range: no earlier runs"
              : `${estimate.samples} earlier run${estimate.samples === 1 ? "" : "s"}${
                  estimate.basis === "workflow-history" ? ` of ${estimate.workflowId}` : ""
                }`}
          </span>
        )}
      </div>
      {error ? (
        <p className={NOTE_ERR}>{error}</p>
      ) : !estimate ? (
        <p className={NOTE}>Estimating…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-[18px]">
            <span className="font-mono text-[22px]">{rangeText(estimate.tokens)} tokens</span>
            <span className="font-mono text-[16px] text-[color:var(--accent-soft)]">
              {usdRange(estimate.costUsd)}
              {estimate.costUsd && !estimate.costComplete ? " (partial)" : ""}
            </span>
            {fit && (
              <span className={`text-[13px] ${FIT_TONE[fit]}`}>
                {cap === null
                  ? `no token cap, pauses every ${tokens(checkpoint ?? 0)}`
                  : FIT_TEXT[fit]}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table
              className={cn(
                TABLE,
                "text-[13px] text-soft-foreground [&_tbody_tr:last-child_td]:border-b-0",
              )}
            >
              <thead>
                <tr>
                  <th className={CELL}>Stage</th>
                  <th className={CELL}>Model</th>
                  <th className={`${CELL} text-right`}>Tokens</th>
                  <th className={`${CELL} text-right`}>USD</th>
                </tr>
              </thead>
              <tbody>
                {estimate.stages.map((stage) => (
                  <tr key={stage.stageId}>
                    <td className={CELL}>{stageLabel(stage.stageId)}</td>
                    <td
                      className={`font-mono ${CELL} whitespace-normal text-muted-foreground wrap-anywhere`}
                    >
                      {stage.models.length ? stage.models.map(shortModel).join(", ") : "host"}
                    </td>
                    <td className={`font-mono ${CELL} text-right`}>{rangeText(stage.tokens)}</td>
                    <td className={`font-mono ${CELL} text-right`}>{usdRange(stage.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {estimate.notes.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-dim-foreground">
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
