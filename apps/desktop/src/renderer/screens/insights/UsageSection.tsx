import { useEffect, useMemo, useState } from "react";
import { api } from "../../client/api.js";
import {
  insights,
  isMissingEndpoint,
  type RunUsageReport,
  type UsageSummary,
} from "../../client/insights.js";
import { workflow } from "../../client/workflow.js";
import { tokens, usd } from "../../format.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { LoadState } from "./LoadState.js";
import {
  aggregateUsage,
  stageLabel,
  summarizeUsage,
  type UsageFilter,
  type UsageReport,
  type UsageSlice,
} from "./usage-model.js";
import { useLoad } from "./useLoad.js";
import "../../styles/insights.css";

const RANGES = [7, 30, 90] as const;
type Scope = { kind: "run"; runId: string } | { kind: "days"; days: number };

/** Runs read one by one when the backend has no project usage summary. */
const RECENT_RUNS = 20;

type Source =
  | { kind: "summary"; byStage: UsageSummary; byModel: UsageSummary }
  | {
      kind: "runs";
      reports: RunUsageReport[];
      costs: Record<string, number | null>;
      /** True when the runs stand in for a time range an older backend cannot answer. */
      fallback: boolean;
    };

async function loadRecentRuns(key: string): Promise<Source> {
  const runs = (await api.runs(key, RECENT_RUNS)).items;
  const reports = await Promise.all(runs.map((run) => insights.runUsage(key, run.runId)));
  return {
    kind: "runs",
    reports,
    costs: Object.fromEntries(runs.map((run) => [run.runId, run.estimatedCostUsd])),
    fallback: true,
  };
}

async function loadSource(key: string, scope: Scope): Promise<Source> {
  if (scope.kind === "run") {
    // The cost estimate is optional here: without it the report still shows tokens.
    const [report, cost] = await Promise.all([
      insights.runUsage(key, scope.runId),
      workflow.status(key, scope.runId).then(
        (run) => run.estimatedCostUsd,
        () => null,
      ),
    ]);
    return {
      kind: "runs",
      reports: [report],
      costs: { [scope.runId]: cost },
      fallback: false,
    };
  }
  try {
    const [byStage, byModel] = await Promise.all([
      insights.usage(key, scope.days, "stage"),
      insights.usage(key, scope.days, "model"),
    ]);
    return { kind: "summary", byStage, byModel };
  } catch (error) {
    if (isMissingEndpoint(error)) return loadRecentRuns(key);
    throw error;
  }
}

function percent(share: number | null): string {
  return share === null ? "–" : `${Math.round(share * 100)}%`;
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card use-figure">
      <span className="use-figure-label">{label}</span>
      <span className="use-figure-value mono">{value}</span>
      <span className="use-figure-note">{note}</span>
    </div>
  );
}

function Legend({ output }: { output: boolean }) {
  return (
    <ul className="use-legend" aria-label="Legend">
      <li>
        <span className="use-swatch use-cached" aria-hidden="true" />
        cached input
      </li>
      <li>
        <span className="use-swatch use-fresh" aria-hidden="true" />
        {output ? "fresh input" : "fresh input and output"}
      </li>
      {output && (
        <li>
          <span className="use-swatch use-output" aria-hidden="true" />
          output
        </li>
      )}
    </ul>
  );
}

function StageChart({ slices }: { slices: UsageSlice[] }) {
  const max = Math.max(1, ...slices.map((s) => s.tokens));
  const output = slices.some((s) => s.output !== null);
  return (
    <section className="card use-chart" aria-labelledby="use-stage-title">
      <div className="use-chart-head">
        <h2 id="use-stage-title" className="label">
          Tokens by stage
        </h2>
        <Legend output={output} />
      </div>
      {slices.length === 0 ? (
        <p className="muted">No agent attempts match these filters.</p>
      ) : (
        <div className="use-bars">
          {slices.map((s) => (
            <div key={s.key} className="use-bar-row">
              <span className="use-bar-label">{stageLabel(s.key)}</span>
              <div className="use-bar-track" aria-hidden="true">
                <div className="use-bar" style={{ width: `${(s.tokens / max) * 100}%` }}>
                  <span className="use-cached" style={{ flexGrow: s.cached }} />
                  <span className="use-fresh" style={{ flexGrow: s.fresh }} />
                  {s.output !== null && (
                    <span className="use-output" style={{ flexGrow: s.output }} />
                  )}
                </div>
              </div>
              <span className="use-bar-value mono">{tokens(s.tokens)}</span>
            </div>
          ))}
        </div>
      )}
      {slices.length > 0 && (
        <details className="use-table-fallback">
          <summary>Show as a table</summary>
          <table className="table">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="num">Cached input</th>
                <th className="num">{output ? "Fresh input" : "Fresh input and output"}</th>
                {output && <th className="num">Output</th>}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody className="mono">
              {slices.map((s) => (
                <tr key={s.key}>
                  <td>{stageLabel(s.key)}</td>
                  <td className="num">{tokens(s.cached)}</td>
                  <td className="num">{tokens(s.fresh)}</td>
                  {output && <td className="num">{s.output === null ? "–" : tokens(s.output)}</td>}
                  <td className="num">{tokens(s.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function ModelTable({ slices }: { slices: UsageSlice[] }) {
  const output = slices.some((s) => s.output !== null);
  const cost = slices.some((s) => s.costUsd !== null);
  return (
    <section className="card use-models" aria-labelledby="use-model-title">
      <h2 id="use-model-title" className="label">
        By model
      </h2>
      {slices.length === 0 ? (
        <p className="muted">No agent attempts match these filters.</p>
      ) : (
        <div className="use-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Attempts</th>
                <th className="num">Runs</th>
                <th className="num">Tokens</th>
                <th className="num">Cached</th>
                {output && <th className="num">Output</th>}
                {cost && <th className="num">USD (approx.)</th>}
              </tr>
            </thead>
            <tbody className="mono">
              {slices.map((s) => (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <td className="num">{s.attempts}</td>
                  <td className="num">{s.runs}</td>
                  <td className="num">{tokens(s.tokens)}</td>
                  <td className="num">{tokens(s.cached)}</td>
                  {output && <td className="num">{s.output === null ? "–" : tokens(s.output)}</td>}
                  {cost && <td className="num">{usd(s.costUsd)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Figures({ report, source }: { report: UsageReport; source: Source }) {
  return (
    <div className="use-figures">
      <Figure
        label="Total tokens"
        value={tokens(report.totalTokens)}
        note={`${report.attempts} agent attempt${report.attempts === 1 ? "" : "s"}`}
      />
      <Figure
        label="Served from cache"
        value={percent(report.cacheShare)}
        note={`${tokens(report.cachedTokens)} cached input`}
      />
      <Figure
        label="Cost"
        value={usd(report.costUsd)}
        note={
          report.costUsd !== null
            ? "approximate"
            : source.kind === "summary"
              ? "not in the usage summary"
              : "no estimate recorded"
        }
      />
      <Figure
        label="Runs"
        value={String(report.runs)}
        note={source.kind === "summary" ? "with attempts in the range" : "read for this report"}
      />
    </div>
  );
}

export function UsageSection({ project, id }: SectionProps) {
  const [scope, setScope] = useState<Scope>(() =>
    id ? { kind: "run", runId: id } : { kind: "days", days: 7 },
  );
  const [filter, setFilter] = useState<UsageFilter>({ stage: null, model: null });
  const { state } = useLoad(
    () => loadSource(project.key, scope),
    [project.key, scope.kind, scope.kind === "run" ? scope.runId : scope.days],
  );
  const report = useMemo(() => {
    if (state.kind !== "ready") return null;
    const source = state.data;
    return source.kind === "summary"
      ? summarizeUsage(source.byStage, source.byModel, filter)
      : aggregateUsage(source.reports, source.costs, filter);
  }, [state, filter]);
  const pick = (next: Scope): void => {
    setScope(next);
    setFilter({ stage: null, model: null });
  };
  useEffect(() => {
    if (id) {
      setScope({ kind: "run", runId: id });
      setFilter({ stage: null, model: null });
    }
  }, [id]);
  return (
    <div className="use-page">
      <div className="use-toolbar">
        <fieldset className="seg-group">
          <legend className="sr-only">Range</legend>
          {id && (
            <button
              type="button"
              className="seg"
              aria-pressed={scope.kind === "run"}
              onClick={() => pick({ kind: "run", runId: id })}
            >
              This run
            </button>
          )}
          {RANGES.map((days) => (
            <button
              key={days}
              type="button"
              className="seg"
              aria-pressed={scope.kind === "days" && scope.days === days}
              onClick={() => pick({ kind: "days", days })}
            >
              Last {days} days
            </button>
          ))}
        </fieldset>
        <label className="use-select">
          <span className="sr-only">Stage</span>
          <select
            value={filter.stage ?? ""}
            onChange={(e) => setFilter({ ...filter, stage: e.target.value || null })}
            disabled={!report}
          >
            <option value="">All stages</option>
            {report?.stages.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabel(stage)}
              </option>
            ))}
          </select>
        </label>
        <label className="use-select">
          <span className="sr-only">Model</span>
          <select
            value={filter.model ?? ""}
            onChange={(e) => setFilter({ ...filter, model: e.target.value || null })}
            disabled={!report}
          >
            <option value="">All models</option>
            {report?.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      </div>
      {scope.kind === "run" && (
        <p className="lede">
          Run <a href={projectHref(project.key, "runs", scope.runId)}>{scope.runId}</a>
        </p>
      )}
      {state.kind !== "ready" || !report ? (
        state.kind !== "ready" && (
          <LoadState
            state={state}
            what="Usage reports"
            {...(scope.kind === "run" ? { missing: "This run is not in the project." } : {})}
          />
        )
      ) : (
        <>
          {state.data.kind === "runs" && state.data.fallback && (
            <div className="banner">
              This BAKED has no project usage summary, so these figures cover the{" "}
              {state.data.reports.length} most recent runs instead of the chosen range. A newer
              BAKED reports any range.
            </div>
          )}
          {!report.crossFiltered && (
            <div className="banner">
              The usage summary groups by one dimension at a time, so{" "}
              {filter.stage !== null && filter.model !== null
                ? "each filter narrows only its own breakdown; the totals follow the stage."
                : filter.stage !== null
                  ? "the stage filter does not narrow the model table."
                  : "the model filter does not narrow the stage chart."}
            </div>
          )}
          <Figures report={report} source={state.data} />
          <StageChart slices={report.byStage} />
          <ModelTable slices={report.byModel} />
        </>
      )}
    </div>
  );
}
