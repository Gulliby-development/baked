import { useEffect, useState } from "react";
import { canExtendRun } from "../../../../../../src/core/workflows/extendable.js";
import { reasonText } from "../../../../../../src/core/workflows/reasons.js";
import { canRepairRun, repairText } from "../../../../../../src/core/workflows/repairable.js";
import { attentionHash } from "../../../shared/attention.js";
import { attentionApi } from "../../client/attention.js";
import { chat } from "../../client/chat.js";
import { desktopRecoveryText } from "../../client/remedies.js";
import {
  errorText,
  GROUP_B_CAPABILITY,
  type RollbackReport,
  runs,
  undoRun,
} from "../../client/runs.js";
import type { LineLoop } from "../../client/start.js";
import { workflow } from "../../client/workflow.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { ModelPicker, useModelCatalog } from "../../components/ui/model-picker.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { tokens, usd } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import { Conveyor } from "./Conveyor.js";
import { DecisionCard, FIELD_LABEL, STACK_FORM, TEXT_INPUT } from "./Decision.js";
import { GateView } from "./GateView.js";
import {
  describe,
  focusStation,
  GATE_KIND,
  gatePlace,
  gateResultText,
  gateTone,
  lineOf,
  SECTION_LABEL,
  SECTIONS,
  type Section,
  type Station,
  sectionsOf,
  stations,
} from "./line-model.js";
import { type RunData, useRun } from "./load.js";
import { RunMaintenance } from "./Maintenance.js";
import { budgetPanelNeeded, clock, duration, pipeline, type RunTrace, taskCount } from "./model.js";
import { PullRequestPanel } from "./PullRequestPanel.js";
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

export const RUN_TITLE_ROW = "flex flex-wrap items-center gap-3";
export const RUN_TITLE = "m-0 text-[20px] font-semibold";
const SMALL_SUB = "text-[12px] text-muted-foreground";
const WARN_NOTE = "text-[12px] text-[var(--warn)]";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type Confirm = "undo" | "cancel" | "fork" | "discard" | "accept";

function Controls({
  projectKey,
  data,
  onDone,
  onUndone,
}: {
  projectKey: string;
  data: RunData;
  onDone: () => Promise<void>;
  onUndone: (report: RollbackReport | null) => void;
}) {
  const run = data.status;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [forkStage, setForkStage] = useState("");
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setConfirm(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  const ask = (which: Confirm): void => {
    setError(null);
    setConfirm(which);
  };
  const ended = TERMINAL.has(run.status);
  const groupB = data.capabilities.includes(GROUP_B_CAPABILITY);
  // Undo needs the run's leases, so it is offered only while nothing executes the run.
  const canUndo = run.status !== "created" && run.status !== "running";
  const canFork = groupB && (run.status === "blocked" || ended);
  const worktree = run.worktree?.present ? run.worktree : null;
  const canDiscard = groupB && ended && worktree !== null;
  const canAccept = run.status === "blocked" && run.reason === "input_changed";
  const planned = run.requests.find((r) => r.kind === "delivery" && r.status === "pending");
  const openPlan = (requestId: string): void => {
    window.location.hash = attentionHash({
      projectKey,
      source: "run",
      runId: run.runId,
      requestId,
      kind: "delivery",
    });
  };
  /** Prepares a delivery plan; it is reviewed and approved in "Needs you". */
  const deliver = (local: boolean): Promise<void> =>
    act(async () => {
      const prepared = await attentionApi.prepareDelivery(
        projectKey,
        run.runId,
        local ? { local: true } : {},
      );
      openPlan(prepared.requestId);
    });
  const dialog = (which: Confirm) => ({
    open: confirm === which,
    busy,
    error: confirm === which ? error : null,
    onClose: () => setConfirm(null),
  });
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {error && confirm === null && (
        <span className="text-[12px] text-[var(--err)]" role="alert">
          {error}
        </span>
      )}
      {canRepairRun(run) && run.repairBlock && (
        <>
          {run.repairBlock.limit === "freshRestart" && (
            <span className={WARN_NOTE}>{repairText(run.repairBlock)}</span>
          )}
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            title={`${repairText(run.repairBlock)} ${tokens(run.tokenUsage)} tokens spent.`}
            onClick={() => void act(() => workflow.repair(projectKey, run))}
          >
            One more repair ({run.repairBlock.limit}, {tokens(run.tokenUsage)} spent)
          </Button>
        </>
      )}
      <RunMaintenance projectKey={projectKey} data={data} />
      {canAccept && (
        <Button variant="secondary" size="md" disabled={busy} onClick={() => ask("accept")}>
          Accept changes
        </Button>
      )}
      {run.status === "completed" &&
        (planned ? (
          <Button variant="secondary" size="md" onClick={() => openPlan(planned.id)}>
            Open delivery plan
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => void deliver(false)}
            >
              Deliver
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => void deliver(true)}
            >
              Deliver locally
            </Button>
          </>
        ))}
      {canUndo && (
        <Button variant="secondary" size="md" disabled={busy} onClick={() => ask("undo")}>
          Undo edits
        </Button>
      )}
      {canFork && (
        <Button variant="secondary" size="md" disabled={busy} onClick={() => ask("fork")}>
          Fork run
        </Button>
      )}
      {canDiscard && (
        <Button variant="secondary" size="md" disabled={busy} onClick={() => ask("discard")}>
          Discard worktree
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
        <Button variant="secondary" size="md" disabled={busy} onClick={() => ask("cancel")}>
          Cancel run
        </Button>
      )}
      <ConfirmDialog
        {...dialog("accept")}
        title="Keep the changed files?"
        confirmLabel="Accept and resume"
        onConfirm={() =>
          void act(() => workflow.resume(projectKey, run, { acceptWorkspace: true }))
        }
      >
        Keeps the files changed outside the run, as listed above, and continues from where the run
        stopped. Later tasks build on them, and the run records that you accepted them.
      </ConfirmDialog>
      <ConfirmDialog
        {...dialog("undo")}
        title="Undo this run's edits?"
        confirmLabel="Undo edits"
        onConfirm={() => void act(async () => onUndone(await undoRun(projectKey, run)))}
      >
        Restores the files the run changed and has not committed. Files changed since the run wrote
        them stay as they are.
      </ConfirmDialog>
      <ConfirmDialog
        {...dialog("fork")}
        title={`Fork ${run.featureId}?`}
        confirmLabel="Fork run"
        extra={
          (run.forkStages?.length ?? 0) > 0 && (
            <SegmentGroup aria-label="Start the fork at">
              {["", ...(run.forkStages ?? [])].map((stage) => (
                <Segment
                  key={stage || "start"}
                  aria-pressed={forkStage === stage}
                  onClick={() => setForkStage(stage)}
                >
                  {stage || "From the start"}
                </Segment>
              ))}
            </SegmentGroup>
          )
        }
        onConfirm={() =>
          void act(async () => {
            const forked = await runs.fork(projectKey, run, forkStage || undefined);
            window.location.hash = projectHref(projectKey, "runs", forked.runId);
          })
        }
      >
        {forkStage
          ? `Starts a new run at the ${forkStage} stage with this run's approval and changes. Nothing executes until you resume it. This run stays as it is.`
          : "Starts a new run with this run's spec and plan. It needs a new approval and runs its checks again; nothing executes until you resume it. This run stays as it is."}
      </ConfirmDialog>
      <ConfirmDialog
        {...dialog("discard")}
        title="Discard the worktree?"
        confirmLabel="Discard worktree"
        danger
        onConfirm={() => void act(() => runs.discardWorktree(projectKey, run))}
      >
        Removes <span className="font-mono">{worktree?.path}</span> and deletes the branch{" "}
        <span className="font-mono">{worktree?.branch}</span>. Work that was not delivered is lost.
      </ConfirmDialog>
      <ConfirmDialog
        {...dialog("cancel")}
        title={`Cancel ${run.featureId}?`}
        confirmLabel="Cancel run"
        danger
        onConfirm={() => void act(() => workflow.cancel(projectKey, run))}
      >
        A cancelled run cannot continue. You can fork it later.
      </ConfirmDialog>
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
  const exhausted = canExtendRun(run);
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
      {run.maxCostUsd !== undefined && (
        <Meter
          label="Cost cap"
          value={run.estimatedCostUsd ?? 0}
          limit={run.costCeilingUsd ?? run.maxCostUsd}
          text={`${usd(run.estimatedCostUsd)}${
            run.reservedCostUsd ? ` (+${usd(run.reservedCostUsd)} reserved)` : ""
          } / ${usd(run.maxCostUsd)}${
            run.costCeilingUsd !== undefined ? ` (up to ${usd(run.costCeilingUsd)} to finish)` : ""
          }`}
        />
      )}
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
          <p className={WARN_NOTE}>
            {run.reason === "budget_exhausted"
              ? "The run stopped on its budget."
              : "The run is blocked with its cost cap nearly spent, so its next step would stop on the budget."}
            {run.maxCostUsd !== undefined
              ? " Extending also doubles its cost cap when the cap stopped it."
              : ""}
          </p>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopped = STOPPED.has(run.status);
  const models = useModelCatalog(stopped ? projectKey : null, chat.models);
  if (!routing) return null;
  const routed = Object.entries(routing.stages);
  const summary = run.routing ?? null;
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
      {summary?.strict && (
        <p className="text-[12px]">The run model overrides the configured routes.</p>
      )}
      {summary?.effective.length ? (
        <ul className={SMALL_SUB} aria-label="Models by role">
          {summary.effective.map((row) => (
            <li key={`${row.target}|${row.model}|${row.source}`}>
              {row.target}: <span className="font-mono">{row.model}</span>
              {` (${row.source})`}
            </li>
          ))}
        </ul>
      ) : (
        routed.length > 0 && (
          <ul className={SMALL_SUB}>
            {routed.map(([stage, entry]) => (
              <li key={stage}>
                {stage}: <span className="font-mono">{entry.model}</span>
              </li>
            ))}
          </ul>
        )
      )}
      {(summary?.warnings ?? []).map((warning) => (
        <p key={warning} className={WARN_NOTE}>
          {warning}
        </p>
      ))}
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
          <ModelPicker
            id="reroute-model"
            value={model}
            onChange={setModel}
            catalog={models.catalog}
            error={models.error}
          />
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

/** The advisory checks that could not start when the run began; a required one refuses the start. */
function StartChecks({ data }: { data: RunData }) {
  const failed = (data.artifacts.preflight ?? []).filter(
    (c) => c.status === "not_found" || c.status === "cannot_start",
  );
  if (!failed.length) return null;
  return (
    <Panel title="Checks at start">
      <ul className={SMALL_SUB}>
        {failed.map((c) => (
          <li key={c.checkId}>
            <span className="font-mono">{c.checkId}</span>: {c.executable}{" "}
            {c.status === "not_found"
              ? "was not found on the PATH"
              : `cannot start (${c.detail ?? "spawn failed"})`}
          </li>
        ))}
      </ul>
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
  go: (t: Section) => void;
}) {
  const { spec, plan, graph } = data.artifacts;
  const tasks = taskCount(graph, trace);
  const cards: { tab: Section; name: string; line: string; note: string; tone: string }[] = [];
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

/** A contract as a chip: filled once a finished station made it, dashed while it is still to come. */
function ContractChip({ name, state }: { name: string; state: "made" | "failed" | "coming" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border-2 border-border px-2 font-mono text-[12px] leading-5 font-semibold",
        state === "made" && "bg-fill-info text-main-foreground",
        state === "failed" && "bg-fill-err text-main-foreground",
        state === "coming" && "border-dashed bg-[var(--bg-sunken)] text-muted-foreground",
      )}
    >
      {name}
    </span>
  );
}

/** Tokens, cost and model on one line; the budget, model and activity panels open below it. */
function RunMeter({
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
  const limit = data.artifacts.estimate?.maxTokens ?? null;
  // A run the budget or its provider stopped needs these panels, so they open on their own.
  const needed = budgetPanelNeeded(run);
  const [open, setOpen] = useState(needed);
  useEffect(() => {
    if (needed) setOpen(true);
  }, [needed]);
  const share = limit && limit > 0 ? Math.min(1, run.tokenUsage / limit) : null;
  const model = data.artifacts.routing?.runModel;
  return (
    <section aria-label="Budget and activity" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-soft-foreground">
        <span>Tokens</span>
        {share !== null && (
          <span
            className="h-[10px] w-[120px] overflow-hidden rounded-[4px] border-2 border-border bg-[var(--bg-sunken)]"
            aria-hidden="true"
          >
            <span className="block h-full bg-main" style={{ width: `${share * 100}%` }} />
          </span>
        )}
        <span className="font-mono">
          {tokens(run.tokenUsage)}
          {limit ? ` / ${tokens(limit)}` : ""} · {usd(run.estimatedCostUsd)}
          {run.maxCostUsd !== undefined ? ` of ${usd(run.maxCostUsd)}` : ""}
          {run.costCeilingUsd !== undefined ? ` (≤ ${usd(run.costCeilingUsd)})` : ""} ·{" "}
          {duration(run.activeMs)} active
        </span>
        {model && (
          <span className="rounded-full border-2 border-border px-2 font-mono leading-5">
            {model}
          </span>
        )}
        <Button
          variant="secondary"
          size="md"
          aria-expanded={open}
          aria-controls="run-meter-details"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide details" : "Budget, model and activity"}
        </Button>
      </div>
      {open && (
        <div
          id="run-meter-details"
          className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] items-start gap-[18px]"
        >
          <Budget projectKey={projectKey} data={data} onDone={refresh} />
          <Models projectKey={projectKey} data={data} onDone={refresh} />
          <StartChecks data={data} />
          <Activity trace={trace} />
        </div>
      )}
    </section>
  );
}

function StationCard({
  station,
  index,
  total,
  stationIds,
  loops,
  contractState,
  waiting,
  blocked,
}: {
  station: Station;
  index: number;
  total: number;
  stationIds: ReadonlyMap<string, number>;
  loops: LineLoop[];
  contractState: (name: string) => "made" | "failed" | "coming";
  /** Requests wait for the user; they are shown above the station. */
  waiting: number;
  /** The run is blocked; why is shown above the station. */
  blocked: boolean;
}) {
  const takes = station.consumes;
  return (
    <section
      aria-label={`Station ${station.label}`}
      className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4 max-[760px]:grid-cols-1"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <span className={LABEL}>
          {station.type === "finish" ? "Finish" : `Station ${index + 1} of ${total}`}
          {station.round > 1 ? ` · round ${station.round}` : ""}
        </span>
        <h3 className="m-0 text-[17px] font-bold">{station.label}</h3>
        <p className="m-0 text-[13px] text-muted-foreground">{describe(station, loops)}</p>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {takes.length > 0 && <span className="font-semibold">Takes</span>}
          {takes.map((name) =>
            name === "request" ? (
              <ContractChip key={name} name="your goal" state="made" />
            ) : (
              <ContractChip key={name} name={name} state={contractState(name)} />
            ),
          )}
          {station.produces && (
            <>
              <span className="font-semibold">Makes</span>
              <ContractChip
                name={station.produces}
                state={
                  station.state === "done"
                    ? "made"
                    : station.state === "failed"
                      ? "failed"
                      : "coming"
                }
              />
            </>
          )}
        </div>
        {station.gates.length > 0 && <StationGates station={station} stationIds={stationIds} />}
      </div>
      <div
        className={cn(
          "flex flex-col gap-1 self-start rounded-base border-2 border-border px-4 py-3 shadow-sm-hard",
          waiting ? "bg-fill-warn text-main-foreground" : "bg-background",
        )}
      >
        <span className={cn(LABEL, waiting && "text-main-foreground")}>Your part</span>
        <p className="m-0 text-[13px]">
          {waiting
            ? `${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you above.`
            : blocked && station.state !== "done"
              ? "The run is blocked. Why it stopped is shown above: retry, switch the model or fork it."
              : station.state === "current"
                ? "Nothing is needed from you. This station is working."
                : station.state === "failed"
                  ? "This station failed. The activity and its sections below say why."
                  : station.state === "done"
                    ? "Done. Its results are in the sections below."
                    : "Nothing yet. This station has not started."}
        </p>
      </div>
    </section>
  );
}

/** Why a blocked or failed run stopped: the reason in words and the error the runtime recorded. */
function StopNote({ run }: { run: RunData["status"] }) {
  const reason = run.reason && run.reason !== "none" ? reasonText(run.reason) : null;
  return (
    <section aria-label="Why the run stopped" className="flex flex-col gap-2">
      <Alert tone="error">
        {run.status === "failed" ? "The run failed" : "The run is blocked"}
        {reason ? `: ${reason}.` : "."}
      </Alert>
      {run.stopDetail && (
        <pre className="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-base border-2 border-border bg-[var(--bg-sunken)] px-3 py-2 font-mono text-[12px]">
          {desktopRecoveryText(run.stopDetail, run.recovery)}
        </pre>
      )}
    </section>
  );
}

/** The station's gates in words: what each does, where it stands, blocks or advises, last result. */
function StationGates({
  station,
  stationIds,
}: {
  station: Station;
  stationIds: ReadonlyMap<string, number>;
}) {
  return (
    <section aria-label={`Gates of ${station.label}`} className="mt-1 flex flex-col gap-1">
      <span className={LABEL}>Gates</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {station.gates.map((gate) => (
          <li
            key={`${gate.id}:${gate.transition?.id ?? "stage"}`}
            className="flex flex-col gap-[2px] rounded-base border-2 border-border bg-background px-3 py-2 text-[13px]"
          >
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-bold">{gate.id}</span>
              <span className="text-[12px] text-muted-foreground">
                {GATE_KIND[gate.type ?? "unknown"]} ·{" "}
                {gate.mode === "required" ? "blocks when it fails" : "only advises"}
              </span>
              <span
                className={cn(
                  "ml-auto text-[12px] font-semibold",
                  TONE_TEXT[GATE_TEXT_TONE[gateTone(gate)]],
                )}
              >
                {gateResultText(gate)}
              </span>
            </span>
            <span className="text-muted-foreground">{gate.does}</span>
            <span className="text-[12px] text-dim-foreground">
              {gatePlace(gate, stationIds, station.id)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
const GATE_TEXT_TONE = { ok: "ok", err: "err", warn: "warn", idle: "" } as const;

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
  // An ended run waits for nobody: its requests stay pending in the store but cannot be answered.
  const pending = TERMINAL.has(run.status) ? [] : blockingRequests(run.requests);
  // The last undo of this run, shown until dismissed; `report` is null when nothing was undone.
  const [undone, setUndone] = useState<{ report: RollbackReport | null } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const graph = data.artifacts.graph;
  const findings = findingsOf(data, trace).length || trace.findings.size;
  const criteria =
    (data.artifacts.spec?.criteria.length ?? 0) +
    data.artifacts.gates.reduce((n, g) => n + (g.acceptance?.scenario.expectations.length ?? 0), 0);
  const count: Partial<Record<Section, number>> = {
    tasks: graph?.tasks.length ?? 0,
    criteria,
    findings,
  };
  const title = data.artifacts.spec?.title ?? run.featureId;
  const estimate = data.artifacts.estimate;
  const meta = [
    estimate?.workflowId,
    trace.writers.length > 1 ? `${trace.writers.length} writers` : null,
    run.featureId !== title ? run.featureId : null,
    run.limitations?.count
      ? `${run.limitations.count} accepted limitation${run.limitations.count === 1 ? "" : "s"}`
      : null,
    run.reviewNotes?.count
      ? `${run.reviewNotes.count} review note${run.reviewNotes.count === 1 ? "" : "s"}`
      : null,
    run.stalled ? `stalled: no event for ${Math.round(run.stalled.silentMs / 60_000)} min` : null,
    run.providerWait
      ? `waiting for provider ${run.providerWait.modelId}; next health probe at ${new Date(run.providerWait.retryAt).toLocaleTimeString()}`
      : null,
    run.autoRetry
      ? `retrying by itself at ${new Date(run.autoRetry.at).toLocaleTimeString()} (${run.autoRetry.attempt} of ${run.autoRetry.of})`
      : null,
  ].filter(Boolean);

  const stages = pipeline(data.stages, trace, run);
  const line = lineOf(
    stages.map((s) => s.id),
    data.line,
  );
  const rounds = new Map([...trace.stages].map(([id, s]) => [id, s.generation]));
  // A v1 check stage records its command gates as checks; a gate's own result wins.
  const results = new Map([
    ...[...trace.checks].map(
      ([id, c]) => [id, { status: c.status, mode: "required", attempts: 1, flaky: false }] as const,
    ),
    ...trace.gates,
  ]);
  const list = stations(stages, line, rounds, run.status, results);
  const selectedId = picked && list.some((s) => s.id === picked) ? picked : focusStation(list);
  const index = Math.max(
    0,
    list.findIndex((s) => s.id === selectedId),
  );
  const station = list[index] as Station;
  const own = sectionsOf(station);
  const shown = section ?? (pending.length ? "decision" : own[0]) ?? "overview";
  const tabs = own.includes(shown) ? own : [...own, shown];
  const others = SECTIONS.filter((s) => !tabs.includes(s));
  const contractState = (name: string): "made" | "failed" | "coming" => {
    const maker = [...list].reverse().find((s) => s.produces === name);
    if (!maker) return "made";
    return maker.state === "done" ? "made" : maker.state === "failed" ? "failed" : "coming";
  };
  const select = (id: string): void => {
    setPicked(id);
    setSection(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-[14px]">
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
            data={data}
            onDone={refresh}
            onUndone={(report) => setUndone({ report })}
          />
        </div>
        <RunMeter projectKey={projectKey} data={data} trace={trace} refresh={refresh} />
      </header>
      <Conveyor
        stations={list}
        loops={line.loops}
        selected={station.id}
        running={run.status === "running"}
        onSelect={select}
      />
      {undone && <UndoReport report={undone.report} onClose={() => setUndone(null)} />}
      {(run.status === "blocked" || run.status === "failed") && <StopNote run={run} />}
      {run.status === "completed" && <PullRequestPanel projectKey={projectKey} runId={run.runId} />}
      {pending.length > 0 && (
        <section aria-label="Your part" className="flex flex-col gap-3">
          {pending.map((r) => (
            <DecisionCard
              key={r.id}
              projectKey={projectKey}
              data={data}
              request={r}
              onDone={refresh}
              onCriteria={() => setSection("criteria")}
            />
          ))}
        </section>
      )}
      <StationCard
        station={station}
        index={index}
        total={list.length - 1}
        stationIds={new Map(list.map((s, i) => [s.id, i]))}
        loops={line.loops}
        contractState={contractState}
        waiting={pending.length}
        blocked={run.status === "blocked"}
      />
      <div className="flex flex-col gap-[18px] border-t-2 border-border pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentGroup aria-label={`${station.label} sections`} role="tablist">
            {tabs.map((t) => (
              <Segment
                key={t}
                role="tab"
                id={`tab-${t}`}
                aria-selected={shown === t}
                aria-pressed={shown === t}
                aria-controls="run-tabpanel"
                onClick={() => setSection(t)}
              >
                {SECTION_LABEL[t]}
                {count[t] ? <span className="font-mono text-[12px]"> {count[t]}</span> : null}
              </Segment>
            ))}
          </SegmentGroup>
          {others.length > 0 && (
            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
              Other sections
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) setSection(e.target.value as Section);
                }}
              >
                <option value="">Choose…</option>
                {others.map((t) => (
                  <option key={t} value={t}>
                    {SECTION_LABEL[t]}
                    {count[t] ? ` (${count[t]})` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div
          className="flex min-w-0 flex-col gap-[18px]"
          role="tabpanel"
          id="run-tabpanel"
          aria-labelledby={`tab-${shown}`}
        >
          {shown === "decision" && (
            <>
              {pending.length === 0 && <Empty>Nothing waits for you here.</Empty>}
              <ArtifactCards data={data} trace={trace} go={setSection} />
              {data.artifacts.spec && <SpecView data={data} preview />}
            </>
          )}
          {shown === "overview" && (
            <>
              <ArtifactCards data={data} trace={trace} go={setSection} />
              <OverviewView data={data} trace={trace} />
            </>
          )}
          {shown === "tasks" && (
            <TasksTab projectKey={projectKey} data={data} trace={trace} onDone={refresh} />
          )}
          {shown === "changes" && <ChangesView data={data} trace={trace} />}
          {shown === "spec" && <SpecView data={data} />}
          {shown === "plan" && <PlanView data={data} />}
          {shown === "checks" && <ChecksView trace={trace} />}
          {shown === "criteria" && (
            <GateView projectKey={projectKey} data={data} trace={trace} onDone={refresh} />
          )}
          {shown === "findings" && <FindingsView data={data} trace={trace} />}
          {shown === "report" && (
            <ReportView projectKey={projectKey} runId={run.runId} stamp={run.eventSeq} />
          )}
        </div>
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
      {!data && !error && <Skeleton lines={5} label="Loading the run" />}
      {data && (
        <RunBody key={runId} projectKey={projectKey} data={data} trace={trace} refresh={refresh} />
      )}
    </>
  );
}
