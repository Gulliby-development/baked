import { type ReactNode, useEffect, useMemo, useState } from "react";
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
import { Icon, type IconName } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import {
  FILL,
  GlanceCard,
  GROW,
  RISE,
  riseDelay,
  Tile,
  type Tone,
  TonePanel,
  useGrown,
} from "../../components/ui/tone.js";
import { tokens, usd } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LEDE, TABLE } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import { stageIconOf } from "../runs/line-model.js";
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
  type TaskGenerationSlice,
  taskGenerationUsage,
  type UsageFilter,
  type UsageReport,
  type UsageSlice,
} from "./usage-model.js";
import { useLoad } from "./useLoad.js";

const RANGES = [7, 30, 90] as const;

/** Numeric table cells. */
const NUM = "text-right tabular-nums";
const PARTIAL = "text-[11px] text-[color:var(--warn)] no-underline";

/** The parts tokens split into; each owns a colour block on the bars. */
type Part = "cached" | "fresh" | "output" | "unsplit";
const PART_FILL: Record<Part, string> = {
  cached: FILL.ok,
  fresh: FILL.accent,
  output: FILL.info,
  unsplit: FILL.plain,
};
const SEGMENT = "h-full basis-0 border-r-2 border-border last:border-r-0";

const SECTIONS = {
  stage: { title: "Tokens by stage", icon: "usage", tone: "accent" },
  model: { title: "By model", icon: "model", tone: "warn" },
  cross: { title: "By stage and model", icon: "workflows", tone: "info" },
  tasks: { title: "By task generation", icon: "implement", tone: "ok" },
} as const satisfies Record<string, { title: string; icon: IconName; tone: Tone }>;
type SectionId = keyof typeof SECTIONS;

/** The icon of a usage stage, after the workflow stage icons of the run conveyor. */
const STAGE_ICON: Record<string, IconName> = {
  research: "research",
  specify: "spec",
  clarify: "spec",
  plan: "plan",
  analyze: "search",
  approve: "attention",
  implement: "implement",
  checks: "checks",
  review: "review",
  converge: "review",
  accept: "accept",
  deliver: "accept",
  learn: "run-memory",
};

function stageIcon(stage: string): IconName {
  return STAGE_ICON[stage] ?? stageIconOf(stage);
}

function scrollTo(id: SectionId): void {
  document.getElementById(`usage-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Section({
  id,
  about,
  step,
  children,
}: {
  id: SectionId;
  about: ReactNode;
  step: number;
  children: ReactNode;
}) {
  const s = SECTIONS[id];
  return (
    <TonePanel
      id={`usage-${id}`}
      title={s.title}
      icon={s.icon}
      tone={s.tone}
      about={about}
      step={step}
    >
      {children}
    </TonePanel>
  );
}

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

function share(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  const value = (part / total) * 100;
  return value < 1 ? "<1%" : `${String(Math.round(value))}%`;
}

/** The parts of a slice in bar order, without the ones it does not have. */
function partsOf(s: Pick<UsageSlice, "cached" | "fresh" | "output" | "unsplit">) {
  return (
    [
      ["cached", s.cached],
      ["fresh", s.fresh],
      ["output", s.output ?? 0],
      ["unsplit", s.unsplit],
    ] as [Part, number][]
  ).filter(([, value]) => value > 0);
}

function partLabels(output: boolean): Record<Part, string> {
  return {
    cached: "Cache reads",
    fresh: output ? "Uncached input" : "Uncached input and output",
    output: "Output",
    unsplit: "Not split",
  };
}

/** A bar split into the parts of a slice, growing in from zero. */
function SplitBar({
  slice,
  width,
  grown,
  tall = false,
}: {
  slice: Pick<UsageSlice, "cached" | "fresh" | "output" | "unsplit">;
  width: number;
  grown: boolean;
  tall?: boolean;
}) {
  const parts = partsOf(slice);
  return (
    <div
      className={cn(
        "flex min-w-[6px] overflow-hidden rounded-base border-2 border-border bg-secondary-background",
        tall ? "h-7" : "h-[18px]",
        GROW,
        parts.length === 0 && "border-dashed",
      )}
      style={{ width: grown ? `${String(width)}%` : "0%" }}
    >
      {parts.map(([part, value]) => (
        <span key={part} className={cn(SEGMENT, PART_FILL[part])} style={{ flexGrow: value }} />
      ))}
    </div>
  );
}

/** All tokens in the range as one bar, with what each part holds. */
function Mix({ slices, grown }: { slices: UsageSlice[]; grown: boolean }) {
  const total = {
    cached: slices.reduce((n, s) => n + s.cached, 0),
    fresh: slices.reduce((n, s) => n + s.fresh, 0),
    output: slices.some((s) => s.output !== null)
      ? slices.reduce((n, s) => n + (s.output ?? 0), 0)
      : null,
    unsplit: slices.reduce((n, s) => n + s.unsplit, 0),
  };
  const sum = total.cached + total.fresh + (total.output ?? 0) + total.unsplit;
  const labels = partLabels(total.output !== null);
  const parts = partsOf(total);
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`Token mix: ${parts.map(([p, v]) => `${labels[p]} ${share(v, sum)}`).join(", ") || "empty"}`}
      >
        <SplitBar slice={total} width={100} grown={grown} tall />
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2 p-0">
        {(["cached", "fresh", "output", "unsplit"] as const)
          .filter((p) =>
            p === "output" ? total.output !== null : p !== "unsplit" || total.unsplit > 0,
          )
          .map((p, i) => {
            const value = total[p] ?? 0;
            return (
              <li
                key={p}
                className={cn(
                  "flex items-center gap-2.5 rounded-base border-2 border-border bg-secondary-background px-3 py-2",
                  RISE,
                )}
                style={riseDelay(i, 45)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 rounded-[3px] border-2 border-border",
                    PART_FILL[p],
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                  {labels[p]}
                </span>
                <span className="font-mono text-[13px] font-bold tabular-nums">
                  {tokens(value)}
                </span>
                <span className="w-9 text-right font-mono text-[11px] tabular-nums text-dim-foreground">
                  {share(value, sum)}
                </span>
              </li>
            );
          })}
      </ul>
    </div>
  );
}

function StageChart({ slices, step }: { slices: UsageSlice[]; step: number }) {
  const grown = useGrown();
  const max = Math.max(1, ...slices.map((s) => s.tokens));
  const total = slices.reduce((n, s) => n + s.tokens, 0);
  const output = slices.some((s) => s.output !== null);
  const unsplit = slices.some((s) => s.unsplit > 0);
  return (
    <Section
      id="stage"
      step={step}
      about="Where the tokens of agent attempts went. Cache reads are billed at a fraction of the price; uncached input and output at the full price."
    >
      {slices.length === 0 ? (
        <Empty>No agent attempts match these filters.</Empty>
      ) : (
        <>
          <Mix slices={slices} grown={grown} />
          <ul className="m-0 list-none p-0" aria-label="Stages">
            {slices.map((s, i) => (
              <li
                key={s.key}
                className={cn(
                  "grid grid-cols-[28px_110px_minmax(0,1fr)_64px_40px] items-center gap-x-3 border-b border-[var(--line)] py-2 last:border-b-0",
                  RISE,
                  s.tokens === 0 && "[&>:first-child]:opacity-60",
                )}
                style={riseDelay(i, 40)}
              >
                <Tile tone="plain" icon={stageIcon(s.key)} small />
                <span className="truncate font-semibold">{stageLabel(s.key)}</span>
                <div className="min-w-0" aria-hidden="true">
                  <SplitBar slice={s} width={(s.tokens / max) * 100} grown={grown} />
                </div>
                <span className="text-right font-mono tabular-nums">{tokens(s.tokens)}</span>
                <span className="text-right font-mono text-[11px] tabular-nums text-dim-foreground">
                  {share(s.tokens, total)}
                </span>
              </li>
            ))}
          </ul>
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
                    {output && (
                      <td className={NUM}>{s.output === null ? "–" : tokens(s.output)}</td>
                    )}
                    {unsplit && <td className={NUM}>{tokens(s.unsplit)}</td>}
                    <td className={NUM}>{tokens(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Section>
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
  max,
  grown,
  fill,
}: {
  slice: UsageSlice;
  columns: ReturnType<typeof columnsOf>;
  /** The largest token count in the table, for the share bar. */
  max: number;
  grown: boolean;
  /** The colour of the share bar: the colour of its section. */
  fill: string;
}) {
  const known = (value: number | null): string => (value === null ? "–" : tokens(value));
  return (
    <>
      <td>
        <span className="flex items-center gap-2">
          <span className="h-3 min-w-[60px] flex-1 overflow-hidden rounded-full border-2 border-border bg-secondary-background">
            <span
              className={cn(
                "block h-full",
                fill,
                GROW,
                slice.tokens > 0 && slice.tokens < max && "border-r-2 border-border",
              )}
              style={{
                width: grown ? `${String((slice.tokens / Math.max(1, max)) * 100)}%` : "0%",
              }}
            />
          </span>
          <span className="w-12 text-right tabular-nums">{tokens(slice.tokens)}</span>
        </span>
      </td>
      <td className={NUM}>{slice.attempts}</td>
      <td className={NUM}>{slice.runs}</td>
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
      <th className="w-[26%]">Tokens</th>
      <th className={NUM}>Attempts</th>
      <th className={NUM}>Runs</th>
      {columns.input && <th className={NUM}>Input</th>}
      <th className={NUM}>Cache reads</th>
      {columns.output && <th className={NUM}>Output</th>}
      {columns.cost && <th className={NUM}>USD (estimate)</th>}
    </>
  );
}

function ModelTable({ slices, step }: { slices: UsageSlice[]; step: number }) {
  const grown = useGrown();
  const columns = columnsOf(slices);
  const max = Math.max(0, ...slices.map((s) => s.tokens));
  return (
    <Section
      id="model"
      step={step}
      about="Tokens and the estimated cost of each model, priced from the price table. Input counts cache reads too."
    >
      {slices.length === 0 ? (
        <Empty>No agent attempts match these filters.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE} aria-label="By model">
            <thead>
              <tr>
                <th>Model</th>
                <FigureHeads columns={columns} />
              </tr>
            </thead>
            <tbody className="font-mono">
              {slices.map((s) => (
                <tr key={s.key}>
                  <td className="text-foreground" title={s.key}>
                    <span className="flex items-center gap-2">
                      <Icon name="model" size={14} className="shrink-0 text-dim-foreground" />
                      {s.key}
                    </span>
                  </td>
                  <FigureCells
                    slice={s}
                    columns={columns}
                    max={max}
                    grown={grown}
                    fill={FILL.warn}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function StageModelTable({ slices, step }: { slices: StageModelSlice[]; step: number }) {
  const grown = useGrown();
  const columns = columnsOf(slices);
  const max = Math.max(0, ...slices.map((s) => s.tokens));
  return (
    <Section
      id="cross"
      step={step}
      about="Each stage with the models that worked on it, to see which model a stage's tokens went to."
    >
      <div className="overflow-x-auto">
        <table className={TABLE} aria-label="By stage and model">
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
                  {i > 0 && slices[i - 1]?.stage === s.stage ? (
                    ""
                  ) : (
                    <span className="flex items-center gap-2 font-sans font-semibold">
                      <Icon
                        name={stageIcon(s.stage)}
                        size={14}
                        className="shrink-0 text-dim-foreground"
                      />
                      {stageLabel(s.stage)}
                    </span>
                  )}
                </td>
                <td>{s.model}</td>
                <FigureCells slice={s} columns={columns} max={max} grown={grown} fill={FILL.info} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** A task's generation: its first implementation, or the nth rerun after a repair. */
export function generationLabel(generation: number): string {
  return generation === 0 ? "First run" : `Rerun ${String(generation)}`;
}

function TaskGenerationTable({ slices, step }: { slices: TaskGenerationSlice[]; step: number }) {
  const grown = useGrown();
  const columns = columnsOf(slices);
  const max = Math.max(0, ...slices.map((s) => s.tokens));
  return (
    <Section
      id="tasks"
      step={step}
      about="Each task's first implementation and every rerun after a repair invalidated it, so the cost of a rerun reads on its own."
    >
      <div className="overflow-x-auto">
        <table className={TABLE} aria-label="By task generation">
          <thead>
            <tr>
              <th>Task</th>
              <th>Generation</th>
              <FigureHeads columns={columns} />
            </tr>
          </thead>
          <tbody className="font-mono">
            {slices.map((s, i) => (
              <tr key={s.key}>
                <td className="text-foreground">
                  {i > 0 && slices[i - 1]?.taskId === s.taskId ? "" : s.taskId}
                </td>
                <td>{generationLabel(s.generation)}</td>
                <FigureCells slice={s} columns={columns} max={max} grown={grown} fill={FILL.ok} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function costNote(report: UsageReport, source: Source): string {
  if (report.costPartial) return `partial: ${tokens(report.unpricedTokens ?? 0)} tokens not priced`;
  if (report.costUsd !== null)
    return source.kind === "cross" || report.unpricedTokens !== null
      ? "estimate from the price table"
      : "approximate";
  return source.kind === "summary" ? "not in this BAKED's usage summary" : "no estimate recorded";
}

function Figures({ report, source }: { report: UsageReport; source: Source }) {
  const split = report.inputTokens !== null && report.outputTokens !== null;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
      <GlanceCard
        tone="accent"
        icon="usage"
        label="Total tokens"
        value={tokens(report.totalTokens)}
        note={
          split
            ? `${tokens(report.inputTokens ?? 0)} in · ${tokens(report.outputTokens ?? 0)} out`
            : `${report.attempts} agent attempt${report.attempts === 1 ? "" : "s"}`
        }
        step={0}
        onClick={() => scrollTo("stage")}
      />
      <GlanceCard
        tone="ok"
        icon="database"
        label="Served from cache"
        value={percent(report.cacheShare)}
        note={`${tokens(report.cachedTokens)} cache-read tokens`}
        step={1}
        onClick={() => scrollTo("stage")}
      />
      <GlanceCard
        tone="warn"
        icon="cost"
        label="Cost"
        value={`${usd(report.costUsd)}${report.costPartial && report.costUsd !== null ? "+" : ""}`}
        note={costNote(report, source)}
        step={2}
        onClick={() => scrollTo("model")}
      />
      <GlanceCard
        tone="info"
        icon="runs"
        label="Runs"
        value={report.runsExact ? String(report.runs) : `≤ ${report.runs}`}
        note={
          source.kind === "runs"
            ? `${report.attempts} attempts, read for this report`
            : report.runsExact
              ? `${report.attempts} agent attempt${report.attempts === 1 ? "" : "s"}`
              : "at most; groups may share runs"
        }
        step={3}
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
  // Only one run's report has its tasks; a project range mixes unrelated runs.
  const generations = useMemo(
    () =>
      state.kind === "ready" && state.data.kind === "runs" && !state.data.fallback
        ? taskGenerationUsage(state.data.reports, filter)
        : [],
    [state, filter],
  );
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
    <div className="flex flex-col gap-4">
      <p className={LEDE}>
        Tokens and the estimated cost of the agent attempts in this project's workflow runs. The
        terminal shows the same with <span className="font-mono">baked usage</span> and{" "}
        <span className="font-mono">/workflow usage</span>.
      </p>
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
          <StageChart slices={report.byStage} step={1} />
          <ModelTable slices={report.byModel} step={2} />
          {report.byStageModel.length > 1 && (
            <StageModelTable slices={report.byStageModel} step={3} />
          )}
          {generations.length > 0 && (
            <TaskGenerationTable
              slices={generations}
              step={report.byStageModel.length > 1 ? 4 : 3}
            />
          )}
        </>
      )}
    </div>
  );
}
