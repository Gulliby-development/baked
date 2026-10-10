import { useEffect, useMemo, useState } from "react";
import { api } from "../../client/api.js";
import {
  insights,
  isMissingEndpoint,
  isRejectedQuery,
  type RunUsageReport,
  type UsageDimension,
  type UsageSummary,
} from "../../client/insights.js";
import { workflow } from "../../client/workflow.js";
import { tokens, usd } from "../../format.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { LoadState } from "./LoadState.js";
import {
  aggregateUsage,
  crossUsage,
  isCurrentSummary,
  type StageModelSlice,
  serverFilter,
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
const STAGE_MODEL: readonly UsageDimension[] = ["stage", "model"];

type Source =
  /** A current backend: one summary grouped by stage and model. */
  | { kind: "cross"; base: UsageSummary }
  /** An older backend: one summary per dimension, without the token split or cost. */
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
    // The run's estimate stands in for attempts an older backend reports without a cost.
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
    const base = await insights.usage(key, { days: scope.days, groupBy: STAGE_MODEL });
    if (isCurrentSummary(base)) return { kind: "cross", base };
  } catch (error) {
    if (isMissingEndpoint(error)) return loadRecentRuns(key);
    // A backend before two-dimension grouping refuses `groupBy=stage,model` as invalid.
    if (!isRejectedQuery(error)) throw error;
  }
  const [byStage, byModel] = await Promise.all([
    insights.usage(key, { days: scope.days, groupBy: ["stage"] }),
    insights.usage(key, { days: scope.days, groupBy: ["model"] }),
  ]);
  return { kind: "summary", byStage, byModel };
}

function percent(share: number | null): string {
  return share === null ? "–" : `${Math.round(share * 100)}%`;
}

/** A cost with a mark when part of the tokens could not be priced. */
function Cost({ slice }: { slice: Pick<UsageSlice, "costUsd" | "unpricedTokens" | "tokens"> }) {
  const unpriced = slice.unpricedTokens ?? 0;
  if (unpriced > 0 && unpriced >= slice.tokens && !slice.costUsd)
    return (
      <abbr className="use-partial" title="No price is known for these tokens">
        not priced
      </abbr>
    );
  return (
    <>
      {usd(slice.costUsd)}
      {unpriced > 0 && slice.costUsd !== null && (
        <abbr className="use-partial" title={`${tokens(unpriced)} tokens could not be priced`}>
          {" "}
          partial
        </abbr>
      )}
    </>
  );
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

function Legend({ output, unsplit }: { output: boolean; unsplit: boolean }) {
  return (
    <ul className="use-legend" aria-label="Legend">
      <li>
        <span className="use-swatch use-cached" aria-hidden="true" />
        cache reads
      </li>
      <li>
        <span className="use-swatch use-fresh" aria-hidden="true" />
        {output ? "uncached input" : "uncached input and output"}
      </li>
      {output && (
        <li>
          <span className="use-swatch use-output" aria-hidden="true" />
          output
        </li>
      )}
      {unsplit && (
        <li>
          <span className="use-swatch use-unsplit" aria-hidden="true" />
          not split
        </li>
      )}
    </ul>
  );
}

function StageChart({ slices }: { slices: UsageSlice[] }) {
  const max = Math.max(1, ...slices.map((s) => s.tokens));
  const output = slices.some((s) => s.output !== null);
  const unsplit = slices.some((s) => s.unsplit > 0);
  return (
    <section className="card use-chart" aria-labelledby="use-stage-title">
      <div className="use-chart-head">
        <h2 id="use-stage-title" className="label">
          Tokens by stage
        </h2>
        <Legend output={output} unsplit={unsplit} />
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
                  {s.unsplit > 0 && (
                    <span className="use-unsplit" style={{ flexGrow: s.unsplit }} />
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
                <th className="num">Cache reads</th>
                <th className="num">{output ? "Uncached input" : "Uncached input and output"}</th>
                {output && <th className="num">Output</th>}
                {unsplit && <th className="num">Not split</th>}
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
                  {unsplit && <td className="num">{tokens(s.unsplit)}</td>}
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

/** Columns shared by the model table and the stage and model table. */
function columnsOf(slices: UsageSlice[]) {
  return {
    input: slices.some((s) => s.input !== null),
    output: slices.some((s) => s.output !== null),
    cost: slices.some((s) => s.costUsd !== null),
  };
}

function FigureCells({
  slice,
  columns,
}: {
  slice: UsageSlice;
  columns: ReturnType<typeof columnsOf>;
}) {
  const known = (value: number | null): string => (value === null ? "–" : tokens(value));
  return (
    <>
      <td className="num">{slice.attempts}</td>
      <td className="num">{slice.runs}</td>
      <td className="num">{tokens(slice.tokens)}</td>
      {columns.input && <td className="num">{known(slice.input)}</td>}
      <td className="num">{tokens(slice.cached)}</td>
      {columns.output && <td className="num">{known(slice.output)}</td>}
      {columns.cost && (
        <td className="num">
          <Cost slice={slice} />
        </td>
      )}
    </>
  );
}

function FigureHeads({ columns }: { columns: ReturnType<typeof columnsOf> }) {
  return (
    <>
      <th className="num">Attempts</th>
      <th className="num">Runs</th>
      <th className="num">Tokens</th>
      {columns.input && <th className="num">Input</th>}
      <th className="num">Cache reads</th>
      {columns.output && <th className="num">Output</th>}
      {columns.cost && <th className="num">USD (estimate)</th>}
    </>
  );
}

function ModelTable({ slices }: { slices: UsageSlice[] }) {
  const columns = columnsOf(slices);
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
                <FigureHeads columns={columns} />
              </tr>
            </thead>
            <tbody className="mono">
              {slices.map((s) => (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <FigureCells slice={s} columns={columns} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StageModelTable({ slices }: { slices: StageModelSlice[] }) {
  const columns = columnsOf(slices);
  return (
    <section className="card use-models" aria-labelledby="use-cross-title">
      <h2 id="use-cross-title" className="label">
        By stage and model
      </h2>
      <div className="use-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Model</th>
              <FigureHeads columns={columns} />
            </tr>
          </thead>
          <tbody className="mono">
            {slices.map((s, i) => (
              <tr key={s.key}>
                <td>{i > 0 && slices[i - 1]?.stage === s.stage ? "" : stageLabel(s.stage)}</td>
                <td>{s.model}</td>
                <FigureCells slice={s} columns={columns} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function costNote(report: UsageReport, source: Source): string {
  if (report.costPartial)
    return `partial: ${tokens(report.unpricedTokens ?? 0)} tokens could not be priced`;
  if (report.costUsd !== null)
    return source.kind === "cross" || report.unpricedTokens !== null
      ? "estimate from the price table"
      : "approximate";
  return source.kind === "summary" ? "not in this BAKED's usage summary" : "no estimate recorded";
}

function Figures({ report, source }: { report: UsageReport; source: Source }) {
  const split = report.inputTokens !== null && report.outputTokens !== null;
  return (
    <div className="use-figures">
      <Figure
        label="Total tokens"
        value={tokens(report.totalTokens)}
        note={`${report.attempts} agent attempt${report.attempts === 1 ? "" : "s"}`}
      />
      {split && (
        <Figure
          label="Input tokens"
          value={tokens(report.inputTokens ?? 0)}
          note={`${tokens(report.outputTokens ?? 0)} output; input includes cache reads`}
        />
      )}
      <Figure
        label="Served from cache"
        value={percent(report.cacheShare)}
        note={`${tokens(report.cachedTokens)} cache-read tokens`}
      />
      <Figure
        label="Cost"
        value={`${usd(report.costUsd)}${report.costPartial && report.costUsd !== null ? "+" : ""}`}
        note={costNote(report, source)}
      />
      <Figure
        label="Runs"
        value={report.runsExact ? String(report.runs) : `≤ ${report.runs}`}
        note={
          source.kind === "runs"
            ? "read for this report"
            : report.runsExact
              ? "with attempts in the range"
              : "at most; groups may share runs"
        }
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
  // With a filter, a current backend answers the exact totals (runs above all) in a second
  // request; until it arrives, or when the filter cannot be sent, the totals add up groups.
  const exactQuery =
    state.kind === "ready" &&
    state.data.kind === "cross" &&
    scope.kind === "days" &&
    (filter.stage !== null || filter.model !== null)
      ? serverFilter(filter)
      : null;
  const exactKey =
    exactQuery && scope.kind === "days" ? JSON.stringify([scope.days, exactQuery]) : null;
  const { state: exactState } = useLoad(
    exactQuery && scope.kind === "days"
      ? () =>
          insights
            .usage(project.key, { days: scope.days, groupBy: STAGE_MODEL, ...exactQuery })
            .then((summary) => ({ key: exactKey, summary }))
      : null,
    [project.key, exactKey],
  );
  const exact =
    exactState.kind === "ready" &&
    exactState.data.key === exactKey &&
    isCurrentSummary(exactState.data.summary)
      ? exactState.data.summary
      : null;
  const report = useMemo(() => {
    if (state.kind !== "ready") return null;
    const source = state.data;
    switch (source.kind) {
      case "cross":
        return crossUsage(source.base, filter, exact);
      case "summary":
        return summarizeUsage(source.byStage, source.byModel, filter);
      case "runs":
        return aggregateUsage(source.reports, source.costs, filter);
    }
  }, [state, filter, exact]);
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
          {state.data.kind === "summary" && (
            <div className="banner">
              This BAKED reports usage by one dimension at a time, without input and output tokens
              or a cost estimate. A newer BAKED reports them, by stage and model together.
              {!report.crossFiltered &&
                (filter.stage !== null && filter.model !== null
                  ? " Each filter narrows only its own breakdown; the totals follow the stage."
                  : filter.stage !== null
                    ? " The stage filter does not narrow the model table."
                    : " The model filter does not narrow the stage chart.")}
            </div>
          )}
          <Figures report={report} source={state.data} />
          <StageChart slices={report.byStage} />
          <ModelTable slices={report.byModel} />
          {report.byStageModel.length > 1 && <StageModelTable slices={report.byStageModel} />}
        </>
      )}
    </div>
  );
}
