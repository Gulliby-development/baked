import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import { errorText } from "../../client/runs.js";
import { workflow } from "../../client/workflow.js";
import { tokens, usd } from "../../format.js";
import { projectHref } from "../../router.js";
import { DecisionCard } from "./Decision.js";
import { GateView } from "./GateView.js";
import { type RunData, useRun } from "./load.js";
import { clock, duration, pipeline, type RunTrace, taskCount } from "./model.js";
import { Meter, Panel, StatusPill } from "./parts.js";
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
import "../../styles/runs.css";

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
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function Controls({
  projectKey,
  run,
  onDone,
}: {
  projectKey: string;
  run: RunSnapshot;
  onDone: () => Promise<void>;
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
  if (TERMINAL.has(run.status)) return null;
  return (
    <div className="run-controls">
      {error && (
        <span className="err-text small" role="alert">
          {error}
        </span>
      )}
      {run.status === "running" && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void act(() => workflow.pause(projectKey, run))}
        >
          Pause
        </button>
      )}
      {(run.status === "paused" || run.status === "created") && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void act(() => workflow.resume(projectKey, run))}
        >
          Resume
        </button>
      )}
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Cancel ${run.featureId}? A cancelled run cannot continue.`))
            void act(() => workflow.cancel(projectKey, run));
        }}
      >
        Cancel run
      </button>
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
        <p className="small sub-text">
          Estimate at start: {tokens(estimate.tokens.low)}–{tokens(estimate.tokens.high)} tokens
          {estimate.costUsd ? `, ${usd(estimate.costUsd.low)}–${usd(estimate.costUsd.high)}` : ""}.
        </p>
      )}
      {exhausted && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void extend();
          }}
        >
          <p className="warn-text small">The run stopped on its budget.</p>
          <label htmlFor="extend-tokens" className="field-label">
            New token limit (empty: BAKED proposes one)
          </label>
          <input
            id="extend-tokens"
            type="text"
            inputMode="numeric"
            value={extra}
            placeholder={limit ? String(Math.round(limit * 1.5)) : "1200000"}
            onChange={(e) => setExtra(e.target.value)}
          />
          {error && <div className="banner error">{error}</div>}
          <button type="submit" className="btn-primary" disabled={busy}>
            Extend and resume
          </button>
        </form>
      )}
    </Panel>
  );
}

function Activity({ trace }: { trace: RunTrace }) {
  const lines = trace.activity.slice(-12).reverse();
  return (
    <Panel title="Activity">
      {lines.length === 0 && <p className="small muted">No events yet.</p>}
      <ol className="activity" aria-live="polite">
        {lines.map((line) => (
          <li key={line.seq}>
            <span className="mono muted">{clock(line.at)}</span>{" "}
            <span className={line.tone ? `${line.tone}-text` : undefined}>{line.text}</span>
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
    <div className="art-cards">
      {cards.map((c) => (
        <button key={c.name} type="button" className="art-card" onClick={() => go(c.tab)}>
          <span className="art-name">{c.name}</span>
          <span className="small sub-text">{c.line}</span>
          <span className={`small ${c.tone ? `${c.tone}-text` : "muted"}`}>{c.note}</span>
        </button>
      ))}
    </div>
  );
}

function Stages({ data, trace }: { data: RunData; trace: RunTrace }) {
  const stages = pipeline(data.stages, trace, data.status);
  const MARK = { done: "✓", current: "⟳", waiting: "⚑", failed: "✗", skipped: "–", pending: "·" };
  return (
    <ol className="stages" aria-label="Stages">
      {stages.map((s) => (
        <li
          key={s.id}
          className={`stage ${s.state}`}
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
    <div className="run">
      <header className="run-head">
        <div className="run-title-row">
          <h2 className="run-title">{title}</h2>
          <StatusPill status={run.status}>
            {run.status === "running" && run.stageId ? ` · ${run.stageId}` : ""}
          </StatusPill>
          {meta.length > 0 && <span className="meta">{meta.join(" · ")}</span>}
          <Controls projectKey={projectKey} run={run} onDone={refresh} />
        </div>
        <Stages data={data} trace={trace} />
        <div className="tabs" role="tablist" aria-label="Run sections">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-selected={tab === t}
              aria-controls="run-tabpanel"
              className="tab"
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
              {count[t] ? <span className="tab-count"> {count[t]}</span> : null}
            </button>
          ))}
        </div>
      </header>
      <div className="run-body">
        <div className="run-main" role="tabpanel" id="run-tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "decision" && (
            <>
              {pending.map((r) => (
                <DecisionCard
                  key={r.request_id}
                  projectKey={projectKey}
                  data={data}
                  request={r}
                  onDone={refresh}
                  onCriteria={() => setTab("criteria")}
                />
              ))}
              {pending.length === 0 && <div className="empty">Nothing waits for you here.</div>}
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
        </div>
        <aside className="run-side" aria-label="Run status">
          <Budget projectKey={projectKey} data={data} onDone={refresh} />
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
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href={projectHref(projectKey, "runs")}>All runs</a>
        <span aria-hidden="true"> / </span>
        <span className="mono">{runId}</span>
      </nav>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <div className="muted">Loading run…</div>}
      {data && (
        <RunBody key={runId} projectKey={projectKey} data={data} trace={trace} refresh={refresh} />
      )}
    </>
  );
}
