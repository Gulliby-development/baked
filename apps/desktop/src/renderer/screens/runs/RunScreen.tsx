import { useEffect, useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import { chat } from "../../client/chat.js";
import { errorText, type RollbackReport, undoRun } from "../../client/runs.js";
import { workflow } from "../../client/workflow.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { tokens, usd } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { projectHref } from "../../router.js";
import { DecisionCard, FIELD_LABEL, STACK_FORM, TEXT_INPUT } from "./Decision.js";
import { GateView } from "./GateView.js";
import { type RunData, useRun } from "./load.js";
import { clock, duration, pipeline, type RunTrace, taskCount } from "./model.js";
import { Meter, Panel, StatusPill, TONE_TEXT } from "./parts.js";
import { ReportView } from "./ReportView.js";
import {
  ChangesView,
  ChecksView,
  FindingsView,
  findingsOf,
  OverviewView,
  PlanView,
  SpecView,
} from "./RunTabs.js";
import { blockingRequests } from "./requests.js";
import { TasksTab } from "./TasksTab.js";
import { UndoReport } from "./UndoReport.js";

const TABS = [
  "overview",
  "decision",
  "tasks",
  "changes",
  "spec",
  "plan",
  "checks",
  "criteria",
  "findings",
  "report",
] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  decision: "Decision",
  tasks: "Tasks",
  changes: "Changes",
  spec: "Spec",
  plan: "Plan",
  checks: "Checks",
  criteria: "Criteria",
  findings: "Findings",
  report: "Report",
};

export const RUN_TITLE_ROW = "flex flex-wrap items-center gap-3";
export const RUN_TITLE = "m-0 text-[20px] font-semibold";
const SMALL_SUB = "text-[12px] text-muted-foreground";
const WARN_NOTE = "text-[12px] text-[var(--warn)]";
const STAGE = "rounded-[6px] px-[10px] py-[6px]";
const STAGE_STATE: Record<string, string> = {
  done: `${STAGE} bg-[color-mix(in_srgb,var(--ok)_14%,var(--bg))] text-[var(--ok)]`,
  current: `${STAGE} bg-selected text-foreground outline outline-[color:var(--accent)]`,
  waiting: `${STAGE} bg-[color-mix(in_srgb,var(--warn)_16%,var(--bg))] text-[var(--warn)] outline outline-[color:var(--warn)]`,
  failed: `${STAGE} bg-[color-mix(in_srgb,var(--err)_14%,var(--bg))] text-[var(--err)]`,
  skipped: `${STAGE} bg-raised text-dim-foreground line-through`,
  pending: `${STAGE} bg-raised text-dim-foreground`,
};
const TAB =
  "cursor-pointer border-x-0 border-t-0 border-b-2 border-b-transparent bg-transparent px-[2px] py-[10px] text-[14px] text-muted-foreground [font-family:inherit] [font-style:inherit] [font-weight:inherit] [line-height:inherit] hover:text-foreground aria-selected:border-b-[color:var(--accent)] aria-selected:text-foreground";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function Controls({
  projectKey,
  run,
  onDone,
  onUndone,
}: {
  projectKey: string;
  run: RunSnapshot;
  onDone: () => Promise<void>;
  onUndone: (report: RollbackReport | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  const ended = TERMINAL.has(run.status);
  // Undo needs the run's leases, so it is offered only while nothing executes the run.
  const canUndo = run.status !== "created" && run.status !== "running";
  if (ended && !canUndo) return null;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {error && (
        <span className="text-[12px] text-[var(--err)]" role="alert">
          {error}
        </span>
      )}
      {canUndo && (
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "Undo this run's uncommitted task edits? Files changed since the run wrote them stay as they are.",
              )
            )
              void act(async () => onUndone(await undoRun(projectKey, run)));
          }}
        >
          Undo edits
        </Button>
      )}
      {run.status === "running" && (
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => void act(() => workflow.pause(projectKey, run))}
        >
          Pause
        </Button>
      )}
      {(run.status === "paused" || run.status === "created") && (
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => void act(() => workflow.resume(projectKey, run))}
        >
          Resume
        </Button>
      )}
      {!ended && (
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Cancel ${run.featureId}? A cancelled run cannot continue.`))
              void act(() => workflow.cancel(projectKey, run));
          }}
        >
          Cancel run
        </Button>
      )}
    </div>
  );
}

function Budget({
  projectKey,
  data,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  onDone: () => Promise<void>;
}) {
  const run = data.status;
  const limit = data.artifacts.estimate?.maxTokens ?? null;
  const estimate = data.artifacts.estimate;
  const calls = data.usage?.attempts.length ?? null;
  const exhausted = run.status === "blocked" && run.reason === "budget_exhausted";
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const extend = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const value = Number(extra.replace(/[_\s,]/g, ""));
      const raised = await workflow.extend(
        projectKey,
        run,
        extra.trim() && value > 0 ? { tokens: Math.round(value) } : {},
      );
      await workflow.resume(projectKey, raised);
      setExtra("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Panel title="Budget">
      <Meter
        label="Tokens"
        value={run.tokenUsage}
        limit={limit}
        text={`${tokens(run.tokenUsage)}${limit ? ` / ${tokens(limit)}` : ""} · ${usd(run.estimatedCostUsd)}`}
      />
      <Meter
        label="Agent calls"
        value={calls ?? 0}
        limit={null}
        text={calls === null ? "–" : String(calls)}
      />
      <Meter label="Active time" value={run.activeMs} limit={null} text={duration(run.activeMs)} />
      {estimate && (
        <p className={SMALL_SUB}>
          Estimate at start: {tokens(estimate.tokens.low)}–{tokens(estimate.tokens.high)} tokens
          {estimate.costUsd ? `, ${usd(estimate.costUsd.low)}–${usd(estimate.costUsd.high)}` : ""}.
        </p>
      )}
      {exhausted && (
        <form
          className={STACK_FORM}
          onSubmit={(e) => {
            e.preventDefault();
            void extend();
          }}
        >
          <p className={WARN_NOTE}>The run stopped on its budget.</p>
          <label htmlFor="extend-tokens" className={FIELD_LABEL}>
            New token limit (empty: BAKED proposes one)
          </label>
          <input
            id="extend-tokens"
            type="text"
            className={TEXT_INPUT}
            inputMode="numeric"
            value={extra}
            placeholder={limit ? String(Math.round(limit * 1.5)) : "1200000"}
            onChange={(e) => setExtra(e.target.value)}
          />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" variant="primary" size="md" disabled={busy}>
            Extend and resume
          </Button>
        </form>
      )}
    </Panel>
  );
}

/** Statuses in which nothing executes the run, so its models can change. */
const STOPPED = new Set(["created", "paused", "blocked", "waiting"]);

/**
 * The run model, and a switch to another one for a run that is not executing: completed stages
 * and tasks stay, the next agent calls use the new model, and a blocked or paused run resumes.
 */
function Models({
  projectKey,
  data,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  onDone: () => Promise<void>;
}) {
  const run = data.status;
  const routing = data.artifacts.routing;
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopped = STOPPED.has(run.status);
  useEffect(() => {
    if (!stopped) return;
    let live = true;
    chat.models(projectKey).then(
      (result) =>
        live &&
        setModels(
          result.providers.filter((p) => p.configured).flatMap((p) => p.models.map((m) => m.id)),
        ),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectKey, stopped]);
  if (!routing) return null;
  const routed = Object.entries(routing.stages);
  const providerStop =
    run.status === "blocked" &&
    (run.reason === "provider_account" || run.reason === "provider_unavailable");
  const reroute = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await workflow.reroute(projectKey, run, { model: model.trim() });
      if (next.status === "blocked" || next.status === "paused")
        await workflow.resume(projectKey, next);
      setModel("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Panel title="Model">
      <p className="text-[12px]">
        Run model <span className="font-mono">{routing.runModel}</span>
      </p>
      {routed.length > 0 && (
        <ul className={SMALL_SUB}>
          {routed.map(([stage, entry]) => (
            <li key={stage}>
              {stage}: <span className="font-mono">{entry.model}</span>
            </li>
          ))}
        </ul>
      )}
      {stopped && (
        <form
          className={STACK_FORM}
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) void reroute();
          }}
        >
          {providerStop && (
            <p className={WARN_NOTE}>
              The provider stopped this run. Switch it to another model to continue; completed work
              stays.
            </p>
          )}
          <label htmlFor="reroute-model" className={FIELD_LABEL}>
            Switch to model
          </label>
          <input
            id="reroute-model"
            type="text"
            className={TEXT_INPUT}
            list="reroute-models"
            value={model}
            placeholder="provider/model"
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="reroute-models">
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {error && <Alert tone="error">{error}</Alert>}
          <Button
            type="submit"
            variant="secondary"
            size="md"
            disabled={busy || !model.trim() || model.trim() === routing.runModel}
          >
            {run.status === "blocked" || run.status === "paused"
              ? "Switch and resume"
              : "Switch model"}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function Activity({ trace }: { trace: RunTrace }) {
  const lines = trace.activity.slice(-12).reverse();
  return (
    <Panel title="Activity">
      {lines.length === 0 && <p className="text-[12px] text-dim-foreground">No events yet.</p>}
      <ol
        className="m-0 flex list-none flex-col gap-2 p-0 text-[13px] text-muted-foreground"
        aria-live="polite"
      >
        {lines.map((line) => (
          <li key={line.seq}>
            <span className="font-mono text-dim-foreground">{clock(line.at)}</span>{" "}
            <span className={line.tone ? TONE_TEXT[line.tone] : undefined}>{line.text}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function ArtifactCards({
  data,
  trace,
  go,
}: {
  data: RunData;
  trace: RunTrace;
  go: (t: Tab) => void;
}) {
  const { spec, plan, graph } = data.artifacts;
  const tasks = taskCount(graph, trace);
  const cards: { tab: Tab; name: string; line: string; note: string; tone: string }[] = [];
  if (spec)
    cards.push({
      tab: "spec",
      name: "spec.json",
      line: `${spec.requirements.length} requirements, ${spec.criteria.length} acceptance criteria`,
      note: spec.title,
      tone: "",
    });
  if (plan)
    cards.push({
      tab: "plan",
      name: "plan.md",
      line: `${plan.split("\n").length} lines`,
      note:
        plan
          .split("\n")
          .find((l) => l.trim())
          ?.replace(/^#+\s*/, "") ?? "",
      tone: "",
    });
  if (graph) {
    const roots = graph.tasks.filter((t) => t.dependsOn.length === 0).length;
    cards.push({
      tab: "tasks",
      name: "tasks",
      line: `${tasks.total} tasks, ${roots} independent start${roots === 1 ? "" : "s"}`,
      note: tasks.done ? `${tasks.done} integrated` : "none started",
      tone: tasks.done ? "ok" : "",
    });
  }
  if (!cards.length) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
      {cards.map((c) => (
        <button
          key={c.name}
          type="button"
          className="flex cursor-pointer flex-col gap-[6px] rounded-[var(--radius-lg)] border-2 border-border bg-background p-[14px] text-left text-soft-foreground shadow-sm-hard [font:inherit] hover:bg-hover"
          onClick={() => go(c.tab)}
        >
          <span className="font-semibold text-foreground">{c.name}</span>
          <span className={SMALL_SUB}>{c.line}</span>
          <span className={cn("text-[12px]", c.tone ? TONE_TEXT[c.tone] : "text-dim-foreground")}>
            {c.note}
          </span>
        </button>
      ))}
    </div>
  );
}

function Stages({ data, trace }: { data: RunData; trace: RunTrace }) {
  const stages = pipeline(data.stages, trace, data.status);
  const MARK = { done: "✓", current: "⟳", waiting: "⚑", failed: "✗", skipped: "–", pending: "·" };
  return (
    <ol className="m-0 flex list-none flex-wrap gap-[6px] p-0 text-[13px]" aria-label="Stages">
      {stages.map((s) => (
        <li
          key={s.id}
          className={STAGE_STATE[s.state]}
          aria-current={s.state === "current" || s.state === "waiting" ? "step" : undefined}
        >
          <span aria-hidden="true">{MARK[s.state]}</span> {s.label}
          <span className="sr-only">, {s.state}</span>
        </li>
      ))}
    </ol>
  );
}

function RunBody({
  projectKey,
  data,
  trace,
  refresh,
}: {
  projectKey: string;
  data: RunData;
  trace: RunTrace;
  refresh: () => Promise<void>;
}) {
  const run = data.status;
  const pending = blockingRequests(run.requests);
  const [tab, setTab] = useState<Tab>(pending.length ? "decision" : "overview");
  // The last undo of this run, shown until dismissed; `report` is null when nothing was undone.
  const [undone, setUndone] = useState<{ report: RollbackReport | null } | null>(null);
  const graph = data.artifacts.graph;
  const findings = findingsOf(data, trace).length || trace.findings.size;
  const criteria =
    (data.artifacts.spec?.criteria.length ?? 0) +
    data.artifacts.gates.reduce((n, g) => n + (g.acceptance?.scenario.expectations.length ?? 0), 0);
  const count: Partial<Record<Tab, number>> = {
    tasks: graph?.tasks.length ?? 0,
    criteria,
    findings,
  };
  const title = data.artifacts.spec?.title ?? run.featureId;
  const estimate = data.artifacts.estimate;
  const meta = [
    estimate?.workflowId,
    estimate ? `${tokens(estimate.maxTokens)} token budget` : null,
    trace.writers.length > 1 ? `${trace.writers.length} writers` : null,
    run.featureId !== title ? run.featureId : null,
  ].filter(Boolean);
  const tabs = TABS.filter((t) => t !== "decision" || pending.length > 0 || tab === "decision");
  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-[14px] border-b-2 border-border">
        <div className={RUN_TITLE_ROW}>
          <h2 className={RUN_TITLE}>{title}</h2>
          <StatusPill status={run.status}>
            {run.status === "running" && run.stageId ? ` · ${run.stageId}` : ""}
          </StatusPill>
          {meta.length > 0 && (
            <span className="font-mono text-[12px] text-dim-foreground">{meta.join(" · ")}</span>
          )}
          <Controls
            projectKey={projectKey}
            run={run}
            onDone={refresh}
            onUndone={(report) => setUndone({ report })}
          />
        </div>
        <Stages data={data} trace={trace} />
        <div className="flex flex-wrap gap-[22px]" role="tablist" aria-label="Run sections">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-selected={tab === t}
              aria-controls="run-tabpanel"
              className={TAB}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
              {count[t] ? (
                <span className="font-mono text-[12px] text-dim-foreground"> {count[t]}</span>
              ) : null}
            </button>
          ))}
        </div>
      </header>
      <div className="flex flex-wrap gap-6 pt-[22px]">
        <div
          className="flex min-w-0 flex-[999_1_480px] flex-col gap-[18px]"
          role="tabpanel"
          id="run-tabpanel"
          aria-labelledby={`tab-${tab}`}
        >
          {undone && <UndoReport report={undone.report} onClose={() => setUndone(null)} />}
          {tab === "decision" && (
            <>
              {pending.map((r) => (
                <DecisionCard
                  key={r.id}
                  projectKey={projectKey}
                  data={data}
                  request={r}
                  onDone={refresh}
                  onCriteria={() => setTab("criteria")}
                />
              ))}
              {pending.length === 0 && <Empty>Nothing waits for you here.</Empty>}
              <ArtifactCards data={data} trace={trace} go={setTab} />
              {data.artifacts.spec && <SpecView data={data} preview />}
            </>
          )}
          {tab === "overview" && (
            <>
              <ArtifactCards data={data} trace={trace} go={setTab} />
              <OverviewView data={data} trace={trace} />
            </>
          )}
          {tab === "tasks" && (
            <TasksTab projectKey={projectKey} data={data} trace={trace} onDone={refresh} />
          )}
          {tab === "changes" && <ChangesView data={data} trace={trace} />}
          {tab === "spec" && <SpecView data={data} />}
          {tab === "plan" && <PlanView data={data} />}
          {tab === "checks" && <ChecksView trace={trace} />}
          {tab === "criteria" && (
            <GateView projectKey={projectKey} data={data} trace={trace} onDone={refresh} />
          )}
          {tab === "findings" && <FindingsView data={data} trace={trace} />}
          {tab === "report" && (
            <ReportView projectKey={projectKey} runId={run.runId} stamp={run.eventSeq} />
          )}
        </div>
        <aside className="flex flex-[1_1_280px] flex-col gap-[18px]" aria-label="Run status">
          <Budget projectKey={projectKey} data={data} onDone={refresh} />
          <Models projectKey={projectKey} data={data} onDone={refresh} />
          <Activity trace={trace} />
        </aside>
      </div>
    </div>
  );
}

export function RunScreen({ projectKey, runId }: { projectKey: string; runId: string }) {
  const { data, trace, error, refresh } = useRun(projectKey, runId);
  return (
    <>
      <nav className="text-[13px] text-dim-foreground" aria-label="Breadcrumb">
        <a href={projectHref(projectKey, "runs")}>All runs</a>
        <span aria-hidden="true"> / </span>
        <span className="font-mono">{runId}</span>
      </nav>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <div className="text-dim-foreground">Loading run…</div>}
      {data && (
        <RunBody key={runId} projectKey={projectKey} data={data} trace={trace} refresh={refresh} />
      )}
    </>
  );
}
