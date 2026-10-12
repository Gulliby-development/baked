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
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { tokens, usd } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL, TABLE } from "../../lib/styles.js";
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

const RANGES = [7, 30, 90] as const;

/** Numeric table cells. */
const NUM = "text-right";
const LEGEND_ITEM = "flex items-center gap-[6px]";
const SWATCH = "h-[10px] w-[10px] rounded-[2px]";
const CACHED = "bg-[color-mix(in_srgb,var(--accent)_50%,var(--bg))]";
const FRESH = "bg-[var(--accent)]";
const OUTPUT = "bg-[var(--accent-soft)]";
const UNSPLIT = "bg-[var(--line-strong)]";
const PARTIAL = "text-[11px] text-[color:var(--warn)] no-underline";
export type Scope = { kind: "run"; runId: string } | { kind: "days"; days: number };

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
      <abbr className={PARTIAL} title="No price is known for these tokens">
        not priced
      </abbr>
    );
  return (
    <>
      {usd(slice.costUsd)}
      {unpriced > 0 && slice.costUsd !== null && (
        <abbr className={PARTIAL} title={`${tokens(unpriced)} tokens could not be priced`}>
          {" "}
          partial
        </abbr>
      )}
    </>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className={cn(PANEL, "flex flex-col gap-[6px]")}>
      <span className="text-[12px] text-dim-foreground">{label}</span>
      <span className="font-mono text-[26px] text-foreground">{value}</span>
      <span className="text-[12px] text-muted-foreground">{note}</span>
    </div>
  );
}

function Legend({ output, unsplit }: { output: boolean; unsplit: boolean }) {
  return (
    <ul
      className="my-0 mr-0 ml-auto flex list-none flex-wrap gap-4 p-0 text-[12px] text-muted-foreground"
      aria-label="Legend"
    >
      <li className={LEGEND_ITEM}>
        <span className={`${SWATCH} ${CACHED}`} aria-hidden="true" />
        cache reads
      </li>
      <li className={LEGEND_ITEM}>
        <span className={`${SWATCH} ${FRESH}`} aria-hidden="true" />
        {output ? "uncached input" : "uncached input and output"}
      </li>
      {output && (
        <li className={LEGEND_ITEM}>
          <span className={`${SWATCH} ${OUTPUT}`} aria-hidden="true" />
          output
        </li>
      )}
      {unsplit && (
        <li className={LEGEND_ITEM}>
          <span className={`${SWATCH} ${UNSPLIT}`} aria-hidden="true" />
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
    <section className={cn(PANEL, "flex flex-col gap-3")} aria-labelledby="use-stage-title">
      <div className="flex flex-wrap items-center gap-4">
        <h2 id="use-stage-title" className={LABEL}>
          Tokens by stage
        </h2>
        <Legend output={output} unsplit={unsplit} />
      </div>
      {slices.length === 0 ? (
        <p className="text-dim-foreground">No agent attempts match these filters.</p>
      ) : (
        <div className="grid grid-cols-[110px_minmax(0,1fr)_70px] items-center gap-x-3 gap-y-2 text-[13px]">
          {slices.map((s) => (
            <div key={s.key} className="contents">
              <span className="text-soft-foreground">{stageLabel(s.key)}</span>
              <div className="min-w-0" aria-hidden="true">
                <div
                  className="flex h-[14px] min-w-[2px] gap-px"
                  style={{ width: `${(s.tokens / max) * 100}%` }}
                >
                  <span className={`basis-0 ${CACHED}`} style={{ flexGrow: s.cached }} />
                  <span className={`basis-0 ${FRESH}`} style={{ flexGrow: s.fresh }} />
                  {s.output !== null && (
                    <span className={`basis-0 ${OUTPUT}`} style={{ flexGrow: s.output }} />
                  )}
                  {s.unsplit > 0 && (
                    <span className={`basis-0 ${UNSPLIT}`} style={{ flexGrow: s.unsplit }} />
                  )}
                </div>
              </div>
              <span className="text-right font-mono text-muted-foreground">{tokens(s.tokens)}</span>
            </div>
          ))}
        </div>
      )}
      {slices.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[12px] text-muted-foreground">
            Show as a table
          </summary>
          <table className={cn(TABLE, "mt-2")}>
            <thead>
              <tr>
                <th>Stage</th>
                <th className={NUM}>Cache reads</th>
                <th className={NUM}>{output ? "Uncached input" : "Uncached input and output"}</th>
                {output && <th className={NUM}>Output</th>}
                {unsplit && <th className={NUM}>Not split</th>}
                <th className={NUM}>Total</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {slices.map((s) => (
                <tr key={s.key}>
                  <td>{stageLabel(s.key)}</td>
                  <td className={NUM}>{tokens(s.cached)}</td>
                  <td className={NUM}>{tokens(s.fresh)}</td>
                  {output && <td className={NUM}>{s.output === null ? "–" : tokens(s.output)}</td>}
                  {unsplit && <td className={NUM}>{tokens(s.unsplit)}</td>}
                  <td className={NUM}>{tokens(s.tokens)}</td>
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
      <td className={NUM}>{slice.attempts}</td>
      <td className={NUM}>{slice.runs}</td>
      <td className={NUM}>{tokens(slice.tokens)}</td>
      {columns.input && <td className={NUM}>{known(slice.input)}</td>}
      <td className={NUM}>{tokens(slice.cached)}</td>
      {columns.output && <td className={NUM}>{known(slice.output)}</td>}
      {columns.cost && (
        <td className={NUM}>
          <Cost slice={slice} />
        </td>
      )}
    </>
  );
}

function FigureHeads({ columns }: { columns: ReturnType<typeof columnsOf> }) {
  return (
    <>
      <th className={NUM}>Attempts</th>
      <th className={NUM}>Runs</th>
      <th className={NUM}>Tokens</th>
      {columns.input && <th className={NUM}>Input</th>}
      <th className={NUM}>Cache reads</th>
      {columns.output && <th className={NUM}>Output</th>}
      {columns.cost && <th className={NUM}>USD (estimate)</th>}
    </>
  );
}

function ModelTable({ slices }: { slices: UsageSlice[] }) {
  const columns = columnsOf(slices);
  return (
    <section className={cn(PANEL, "flex flex-col gap-3")} aria-labelledby="use-model-title">
      <h2 id="use-model-title" className={LABEL}>
        By model
      </h2>
      {slices.length === 0 ? (
        <p className="text-dim-foreground">No agent attempts match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr>
                <th>Model</th>
                <FigureHeads columns={columns} />
              </tr>
            </thead>
            <tbody className="font-mono">
              {slices.map((s) => (
                <tr key={s.key}>
                  <td className="text-foreground">{s.key}</td>
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
    <section className={cn(PANEL, "flex flex-col gap-3")} aria-labelledby="use-cross-title">
      <h2 id="use-cross-title" className={LABEL}>
        By stage and model
      </h2>
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Model</th>
              <FigureHeads columns={columns} />
            </tr>
          </thead>
          <tbody className="font-mono">
            {slices.map((s, i) => (
              <tr key={s.key}>
                <td className="text-foreground">
                  {i > 0 && slices[i - 1]?.stage === s.stage ? "" : stageLabel(s.stage)}
                </td>
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
    <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
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

/** File name an exported usage document is saved under. */
export function usageFileName(scope: Scope, today = new Date()): string {
  return scope.kind === "run"
    ? `baked-usage-${scope.runId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`
    : `baked-usage-${scope.days}d-${today.toISOString().slice(0, 10)}.md`;
}

/**
 * Copies or saves the usage of the chosen range as Markdown, rendered by the backend
 * (`GET /v1/usage?format=md`, or the run's usage with `format=md`) for the current filters.
 */
function ExportUsage({
  projectKey,
  scope,
  filter,
}: {
  projectKey: string;
  scope: Scope;
  filter: UsageFilter;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (): Promise<string | null> => {
    if (scope.kind === "run") return insights.runUsageMarkdown(projectKey, scope.runId);
    // The combined implement stage exists only on this screen; the export then covers all stages.
    const filters = serverFilter(filter) ?? (filter.model !== null ? { model: filter.model } : {});
    return insights.usageMarkdown(projectKey, {
      days: scope.days,
      groupBy: STAGE_MODEL,
      ...filters,
    });
  };
  const run = async (action: "copy" | "save"): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const markdown = await load();
      if (markdown === null) {
        setNote("This BAKED cannot export usage yet; a newer BAKED can.");
        return;
      }
      if (action === "copy") {
        await navigator.clipboard.writeText(markdown);
        setNote("Copied");
      } else {
        const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = usageFileName(scope);
        link.click();
        URL.revokeObjectURL(url);
        setNote(null);
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {note && (
        <span className="text-[12px] text-muted-foreground" role="status">
          {note}
        </span>
      )}
      <Button variant="secondary" size="md" disabled={busy} onClick={() => void run("copy")}>
        Copy as Markdown
      </Button>
      <Button variant="secondary" size="md" disabled={busy} onClick={() => void run("save")}>
        Export as .md
      </Button>
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
    [project.key, "usage", scope.kind, scope.kind === "run" ? scope.runId : scope.days],
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
    [project.key, "usage-exact", exactKey],
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
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentGroup>
          <legend className="sr-only">Range</legend>
          {id && (
            <Segment
              aria-pressed={scope.kind === "run"}
              onClick={() => pick({ kind: "run", runId: id })}
            >
              This run
            </Segment>
          )}
          {RANGES.map((days) => (
            <Segment
              key={days}
              aria-pressed={scope.kind === "days" && scope.days === days}
              onClick={() => pick({ kind: "days", days })}
            >
              Last {days} days
            </Segment>
          ))}
        </SegmentGroup>
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
        {state.kind === "ready" &&
          state.data.kind !== "summary" &&
          !(state.data.kind === "runs" && state.data.fallback) && (
            <ExportUsage projectKey={project.key} scope={scope} filter={filter} />
          )}
      </div>
      {scope.kind === "run" && (
        <p className={LEDE}>
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
            <Alert>
              This BAKED has no project usage summary, so these figures cover the{" "}
              {state.data.reports.length} most recent runs instead of the chosen range. A newer
              BAKED reports any range.
            </Alert>
          )}
          {state.data.kind === "summary" && (
            <Alert>
              This BAKED reports usage by one dimension at a time, without input and output tokens
              or a cost estimate. A newer BAKED reports them, by stage and model together.
              {!report.crossFiltered &&
                (filter.stage !== null && filter.model !== null
                  ? " Each filter narrows only its own breakdown; the totals follow the stage."
                  : filter.stage !== null
                    ? " The stage filter does not narrow the model table."
                    : " The model filter does not narrow the stage chart.")}
            </Alert>
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
