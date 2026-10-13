import { type ReactNode, useEffect, useState } from "react";
import { type RouteExplanation, setup } from "../../client/setup.js";
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
import { type Query, useQuery } from "../../lib/query.js";
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
import { routeExtras, routeRows } from "./route-logic.js";

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

function StageTable({ estimate }: { estimate: PreRunEstimate }) {
  return (
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
  );
}

export function EstimatePanel({
  estimate,
  error,
  loading,
  cap,
  checkpoint,
  stagesFolded = false,
}: {
  estimate: PreRunEstimate | null;
  error: string | null;
  loading: boolean;
  /** The token cap of the chosen budget preset; null for no cap. */
  cap: number | null;
  checkpoint: number | null;
  /** Folds the per-stage table, for screens that already show the stages. */
  stagesFolded?: boolean;
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
          {stagesFolded ? (
            <details>
              <summary className="cursor-pointer text-[13px] text-muted-foreground">
                Per stage
              </summary>
              <StageTable estimate={estimate} />
            </details>
          ) : (
            <StageTable estimate={estimate} />
          )}
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

/**
 * Who runs each stage of the chosen workflow and why (`GET /v1/workflow/route`, what `baked
 * workflow route` prints). Left out on a backend without the `routing` capability.
 */
export function RoutePanel({ state }: { state: RouteState }) {
  if (state.unsupported) return null;
  const rows = state.route ? routeRows(state.route) : [];
  return (
    <section aria-label="Models" className={PANEL} aria-busy={state.loading}>
      <div className={PANEL_HEAD}>
        <h2 className={LABEL}>Models</h2>
        {state.route && (
          <span className={`${NOTE} ml-auto`}>run model {shortModel(state.route.runModel)}</span>
        )}
      </div>
      {state.error ? (
        <p className={NOTE_ERR}>{state.error}</p>
      ) : !state.route ? (
        <p className={NOTE}>Routing…</p>
      ) : (
        <>
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
                  <th className={CELL}>Why</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const extras = routeExtras(row);
                  return (
                    <tr key={row.stageId}>
                      <td className={CELL}>
                        {stageLabel(row.stageId)}
                        <span className="block text-[11px] text-dim-foreground">{row.kind}</span>
                      </td>
                      <td className={`font-mono ${CELL} whitespace-normal wrap-anywhere`}>
                        {row.model ? shortModel(row.model) : "per profile"}
                        {extras && (
                          <span className="block text-[11px] text-dim-foreground">{extras}</span>
                        )}
                      </td>
                      <td
                        className={`font-mono ${CELL} whitespace-normal text-[12px] text-muted-foreground wrap-anywhere`}
                      >
                        {row.source}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {state.route.warnings.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-[color:var(--warn)]">
              {state.route.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export interface RouteState {
  route: RouteExplanation | null;
  error: string | null;
  loading: boolean;
  /** The backend has no `routing` capability: the panel is left out. */
  unsupported: boolean;
}

/** The route of a workflow with the chosen run model; an answer for older inputs is dropped. */
export function useRoute(key: string, workflow: string, model: string): RouteState {
  const [state, setState] = useState<RouteState>({
    route: null,
    error: null,
    loading: true,
    unsupported: false,
  });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    setup.route(key, workflow, model || undefined).then(
      (route) =>
        live && setState({ route, error: null, loading: false, unsupported: route === null }),
      (error: unknown) =>
        live &&
        setState({ route: null, error: message(error), loading: false, unsupported: false }),
    );
    return () => {
      live = false;
    };
  }, [key, workflow, model]);
  return state;
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
  const { workflow, model, worktree, writers, sandbox } = input;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      const request: PreRunInput = {
        workflow,
        model,
        worktree,
        writers,
        ...(sandbox ? { sandbox } : {}),
      };
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
  }, [key, workflow, model, worktree, writers, sandbox, delayMs]);
  return state;
}

/**
 * A value of one project read through the shared query cache under `name`: the last answer at
 * once, refreshed in the background when older than `staleMs`. `error` is set only while there is no value to show.
 */
export function useLoad<T>(
  key: string,
  name: string,
  load: (key: string) => Promise<T>,
  staleMs?: number,
): Query<T> & { value: T | null } {
  const query = useQuery([key, name], () => load(key), staleMs);
  return {
    ...query,
    value: query.hasData ? (query.data as T) : null,
    error: query.hasData ? null : query.error,
  };
}

export { message };
