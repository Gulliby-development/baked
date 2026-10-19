import { useEffect, useMemo, useRef, useState } from "react";
import { loadProjectConfig, saveProjectConfig } from "../../config/index.js";
import { useTheme } from "../../core/theme/index.js";
import type { UndoResult } from "../../core/workers/workflow-client.js";
import { defaultWorkflowPolicy } from "../../core/workflows/defaults.js";
import type { PullRequestChecks } from "../../core/workflows/follow.js";
import { usageFileName, writeUsageMarkdown } from "../../core/workflows/usage-markdown.js";
import type { StartRunInput } from "../../core/workflows/view.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import {
  existingWorkflowSession,
  reloadWorkflowSession,
  useWorkflow,
  useWorkflowRuns,
  workflowEditorApi,
  workflowGatesApi,
  workflowInitiativesApi,
  workflowRoutingApi,
  workflowSession,
  workflowUsageLoader,
} from "../../hooks/useWorkflow.js";
import { useWorkflowStore } from "../../stores/workflow.js";
import { Hint, PremiumPopup, type SidebarTab } from "../ui/index.js";
import { ArtifactReview } from "./ArtifactReview.js";
import { ChangesView } from "./ChangesView.js";
import { ChecksView } from "./ChecksView.js";
import { DecisionPrompt } from "./DecisionPrompt.js";
import { FindingsView } from "./FindingsView.js";
import {
  detectChecks,
  errorHint,
  extensionText,
  isTerminal,
  runActions,
  statusTone,
  type Tone,
} from "./format.js";
import { GATES_HINTS, type GatesMode, GatesView } from "./GatesView.js";
import { InitiativesPopup } from "./InitiativesView.js";
import { NewRunForm } from "./NewRunForm.js";
import { Onboarding } from "./Onboarding.js";
import { RoutingPopup } from "./RoutingView.js";
import { orderRuns, RunList } from "./RunList.js";
import { RunOverview } from "./RunOverview.js";
import { tuiErrorText } from "./remedies.js";
import { TaskGraphView } from "./TaskGraphView.js";
import { UndoReport } from "./UndoReport.js";
import { UsagePopup } from "./UsageView.js";
import { WorkflowEditorPopup } from "./WorkflowEditor.js";
import { WorkflowsPopup } from "./WorkflowsView.js";

const sections = [
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
type Section = (typeof sections)[number];
const TONE_STATUS: Record<Tone, NonNullable<SidebarTab["status"]>> = {
  online: "online",
  info: "online",
  warning: "warning",
  error: "error",
  idle: "idle",
  offline: "offline",
};
const SECTION_LABELS: Record<Section, string> = {
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

export function WorkflowPanel({
  visible,
  workspace,
  onClose,
  activeModel = null,
  activeTabId,
}: {
  visible: boolean;
  workspace: string;
  onClose: () => void;
  activeModel?: string | null;
  activeTabId?: string;
}) {
  const t = useTheme();
  const screen = useWorkflowStore((s) => s.screen);
  const runId = useWorkflowStore((s) => s.selectedRunId);
  const draftPrompt = useWorkflowStore((s) => s.draftPrompt);
  const draftWorkflow = useWorkflowStore((s) => s.draftWorkflow);
  const editorId = useWorkflowStore((s) => s.editorId);
  const editorReturn = useWorkflowStore((s) => s.editorReturn);
  const initiativeId = useWorkflowStore((s) => s.initiativeId);
  const runReturn = useWorkflowStore((s) => s.runReturn);
  const onRun = screen === "run" && runId !== null;
  const {
    runs,
    info,
    enabled,
    error: listError,
    reload,
  } = useWorkflowRuns(workspace, visible && !onRun);
  const { service, snapshot, error, act } = useWorkflow(workspace, onRun ? runId : null, visible);
  const [tab, setTab] = useState<Section>("overview");
  const [cursor, setCursor] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmExtend, setConfirmExtend] = useState(false);
  const [confirmReroute, setConfirmReroute] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  // The files changed outside a blocked run that "accept changes" would keep.
  const [confirmAccept, setConfirmAccept] = useState<string[] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The stage a fork starts at; "" starts from the beginning with a new approval.
  const [forkPick, setForkPick] = useState<{ stages: string[]; index: number } | null>(null);
  /**
   * The fix-ci run the last read of failed pull request checks proposes, or the quick-fix run for
   * its unresolved review comments; Y starts it.
   */
  const [fixChecks, setFixChecks] = useState<{
    featureId: string;
    prompt: string;
    workflowId: string;
    summary: string;
    /** The follow-up delivery flags beyond --follow-up, such as the threads it answers. */
    deliver: string;
  } | null>(null);
  // The last undo of the open run, shown until Esc or another run.
  const [undone, setUndone] = useState<{ runId: string; report: UndoResult["report"] } | null>(
    null,
  );
  const [gatesMode, setGatesMode] = useState<GatesMode>("list");
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);
  const { width, height } = useTerminalDimensions();
  const ordered = useMemo(() => (runs ? orderRuns(runs) : null), [runs]);
  const gatesApi = useMemo(() => workflowGatesApi(workspace), [workspace]);
  const editorApi = useMemo(() => workflowEditorApi(workspace), [workspace]);
  const initiativesApi = useMemo(() => workflowInitiativesApi(workspace), [workspace]);
  const routingApi = useMemo(() => workflowRoutingApi(workspace), [workspace]);
  const loadUsage = useMemo(() => workflowUsageLoader(workspace), [workspace]);
  const pending =
    service && runId
      ? service.store.requests(runId).find((r) => r.status === "pending")
      : undefined;
  const driving = !!(service && runId && service.isDriving(runId));
  const driveError = service && runId ? service.driveError(runId) : null;
  const runModel = service && runId ? service.store.runModel(runId) : null;
  // A stopped run can continue on the tab's model, picked with Ctrl+L.
  const switchTo =
    activeModel && activeModel !== "none" && runModel && activeModel !== runModel
      ? activeModel
      : null;

  // Bring the user to the decision as soon as a new request appears.
  const lastPending = useRef<string | null>(null);
  useEffect(() => {
    const id = pending?.id ?? null;
    if (id && id !== lastPending.current) setTab("decision");
    lastPending.current = id;
  }, [pending?.id]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    if (ordered && cursor >= ordered.length) setCursor(Math.max(0, ordered.length - 1));
  }, [ordered, cursor]);

  const openRun = (id: string): void => {
    useWorkflowStore.getState().select(id, activeTabId);
    setTab("overview");
  };
  const enable = async (): Promise<void> => {
    const existing = loadProjectConfig(workspace)?.workflows;
    saveProjectConfig(workspace, {
      workflows: existing
        ? { ...existing, enabled: true }
        : {
            enabled: true,
            importsEnabled: false,
            defaultWorkflow: "sdd",
            policy: { ...defaultWorkflowPolicy, checks: detectChecks(workspace) },
          },
    });
    const reloaded = await reloadWorkflowSession(
      workspace,
      runs?.map((r) => r.snapshot.runId) ?? [],
    );
    setFlash(
      reloaded
        ? { kind: "ok", message: "Workflows enabled for this project" }
        : { kind: "info", message: "Enabled. Restart BAKED after the active run to apply it." },
    );
    reload();
  };
  const undo = async (id: string): Promise<void> => {
    try {
      const { report } = await workflowSession(workspace).undo(id);
      setUndone({ runId: id, report });
    } catch (err) {
      setFlash({ kind: "err", message: tuiErrorText(err) });
    }
  };
  /**
   * Reads the delivered pull request's checks once; failed checks offer a fix-ci run. With
   * `reviews` it also reads the unresolved review threads, which offer a quick-fix run.
   */
  const readChecks = async (id: string, reviews = false): Promise<void> => {
    try {
      const read = (await workflowSession(workspace).command(
        ["follow", id, "--once", ...(reviews ? ["--reviews"] : [])],
        new AbortController().signal,
      )) as PullRequestChecks & {
        fix?: { featureId: string; prompt: string; workflowId: string };
        reviews?: { threads: unknown[]; changesRequested: unknown[] };
        repair?: { featureId: string; prompt: string; workflowId: string; threads: string[] };
      };
      const failed = read.checks.filter((c) => c.state === "failed").map((c) => c.name);
      const where = read.pullRequest ? `#${read.pullRequest.number}` : read.branch;
      const summary =
        read.state === "failed"
          ? `${where}: failed ${failed.join(", ")}`
          : read.state === "passed"
            ? `${where}: all ${read.checks.length} checks passed`
            : read.state === "pending"
              ? `${where}: checks still running`
              : `${where}: no checks reported yet`;
      if (read.fix) setFixChecks({ ...read.fix, summary, deliver: "" });
      else if (read.repair && read.reviews)
        setFixChecks({
          ...read.repair,
          summary: `${where}: ${read.reviews.threads.length} unresolved review thread(s), ${read.reviews.changesRequested.length} review(s) requesting changes`,
          deliver: read.repair.threads.length
            ? ` --answer-threads ${read.repair.threads.join(",")}`
            : "",
        });
      else if (read.reviews)
        setFlash({ kind: "info", message: `${summary}; no unresolved review comments` });
      else setFlash({ kind: read.state === "passed" ? "ok" : "info", message: summary });
    } catch (err) {
      setFlash({ kind: "err", message: tuiErrorText(err) });
    }
  };
  const start = async (input: StartRunInput): Promise<void> => {
    const run = await workflowSession(workspace).start(input);
    openRun(run.runId);
    setFlash({ kind: "ok", message: `Run started for ${run.featureId}` });
  };

  useKeyboard((event) => {
    if (!visible || event.defaultPrevented) return;
    const key = event.name.toLowerCase();
    // These screens own their keys.
    if (
      screen === "new" ||
      screen === "gates" ||
      screen === "editor" ||
      screen === "initiatives" ||
      screen === "routing" ||
      screen === "usage" ||
      screen === "workflows"
    )
      return;
    if (!onRun) {
      if (key === "escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (enabled === false && key === "e") {
        event.preventDefault();
        void enable().catch((err: unknown) =>
          setFlash({ kind: "err", message: tuiErrorText(err) }),
        );
        return;
      }
      if (key === "g") {
        event.preventDefault();
        useWorkflowStore.getState().showGates();
        return;
      }
      if (key === "u") {
        event.preventDefault();
        useWorkflowStore.getState().showUsage();
        return;
      }
      if (key === "w") {
        event.preventDefault();
        useWorkflowStore.getState().showWorkflows();
        return;
      }
      if (key === "r") {
        event.preventDefault();
        useWorkflowStore.getState().showRouting();
        return;
      }
      if (enabled === false) return;
      if (key === "i") {
        event.preventDefault();
        useWorkflowStore.getState().showInitiatives(null);
        return;
      }
      if (key === "n") {
        event.preventDefault();
        useWorkflowStore.getState().showNew();
        return;
      }
      const max = ordered?.length ?? 0;
      if ((key === "up" || key === "k") && max) {
        event.preventDefault();
        setCursor((c) => (c > 0 ? c - 1 : max - 1));
      } else if ((key === "down" || key === "j") && max) {
        event.preventDefault();
        setCursor((c) => (c < max - 1 ? c + 1 : 0));
      } else if (key === "return" && ordered?.[cursor]) {
        event.preventDefault();
        openRun(ordered[cursor].snapshot.runId);
      }
      return;
    }
    if (key === "tab") {
      event.preventDefault();
      setTab(
        (current) =>
          sections[
            (sections.indexOf(current) + (event.shift ? sections.length - 1 : 1)) % sections.length
          ] ?? "overview",
      );
      return;
    }
    if (confirmExtend) {
      event.preventDefault();
      if (key === "y") {
        setConfirmExtend(false);
        void act("extend");
      } else if (key === "escape" || key === "n") setConfirmExtend(false);
      return;
    }
    if (confirmReroute) {
      event.preventDefault();
      if (key === "y" && switchTo) {
        setConfirmReroute(false);
        void act({ reroute: switchTo });
      } else if (key === "escape" || key === "n") setConfirmReroute(false);
      return;
    }
    if (confirmAccept) {
      event.preventDefault();
      if (key === "y") {
        setConfirmAccept(null);
        void act(confirmAccept.length ? "accept-workspace" : "resume");
      } else if (key === "escape" || key === "n") setConfirmAccept(null);
      return;
    }
    if (confirmUndo) {
      event.preventDefault();
      if (key === "y") {
        setConfirmUndo(false);
        void undo(runId);
      } else if (key === "escape" || key === "n") setConfirmUndo(false);
      return;
    }
    if (fixChecks) {
      event.preventDefault();
      if (key === "y") {
        const fix = fixChecks;
        setFixChecks(null);
        void start({
          workflowId: fix.workflowId,
          featureId: fix.featureId,
          prompt: fix.prompt,
          model: activeModel && activeModel !== "none" ? activeModel : "",
          budget: "standard",
        }).catch((err: unknown) => setFlash({ kind: "err", message: tuiErrorText(err) }));
      } else if (key === "escape" || key === "n") setFixChecks(null);
      return;
    }
    if (forkPick) {
      event.preventDefault();
      const count = forkPick.stages.length;
      if (key === "left" || key === "h")
        setForkPick({ ...forkPick, index: (forkPick.index + count - 1) % count });
      else if (key === "right" || key === "l")
        setForkPick({ ...forkPick, index: (forkPick.index + 1) % count });
      else if (key === "y" || key === "return") {
        const stage = forkPick.stages[forkPick.index];
        setForkPick(null);
        void act(stage ? { fork: stage } : "fork");
      } else if (key === "escape" || key === "n") setForkPick(null);
      return;
    }
    if (confirmDiscard) {
      event.preventDefault();
      if (key === "y") {
        setConfirmDiscard(false);
        void act("discard-worktree");
      } else if (key === "escape" || key === "n") setConfirmDiscard(false);
      return;
    }
    if (confirmCancel) {
      event.preventDefault();
      if (key === "y") {
        setConfirmCancel(false);
        void act("cancel");
      } else if (key === "escape" || key === "n") setConfirmCancel(false);
      return;
    }
    // The decision view owns every other key there, including Esc and letters typed into inputs.
    if (tab === "decision" && pending) return;
    if (key === "escape") {
      event.preventDefault();
      if (undone?.runId === runId) setUndone(null);
      else useWorkflowStore.getState().leaveRun();
      return;
    }
    if (!snapshot) return;
    // The changes list owns its navigation keys.
    if (tab === "changes" && ["up", "down", "k", "j", "return"].includes(key)) return;
    if (key === "return" && pending) {
      event.preventDefault();
      setTab("decision");
      return;
    }
    const action = runActions(
      snapshot,
      service?.store.budget(snapshot.runId) ?? null,
      switchTo,
      service?.store.worktree(snapshot.runId)?.present === true,
    ).find((a) => a.key.toLowerCase() === key);
    if (!action || action.action === "decide") return;
    event.preventDefault();
    if (action.action === "extend") setConfirmExtend(true);
    else if (action.action === "reroute") setConfirmReroute(true);
    else if (action.action === "cancel") setConfirmCancel(true);
    else if (action.action === "discard-worktree") setConfirmDiscard(true);
    else if (action.action === "fork" && service?.store.forkStages(snapshot.runId).length)
      setForkPick({ stages: ["", ...service.store.forkStages(snapshot.runId)], index: 0 });
    else if (action.action === "accept-workspace" && service)
      void service
        .outsideChanges(snapshot.runId)
        .then((changes) => setConfirmAccept(changes.map((c) => c.path)))
        .catch((err: unknown) => setFlash({ kind: "err", message: tuiErrorText(err) }));
    else if (action.action === "repair") void act({ repair: snapshot.revision });
    else if (action.action === "checks") void readChecks(snapshot.runId);
    else if (action.action === "reviews") void readChecks(snapshot.runId, true);
    else if (action.action === "undo") {
      if (!driving) setConfirmUndo(true);
    } else void act(action.action);
  });

  if (!visible) return null;

  const popupW = Math.min(120, width);
  const contentW = popupW - (onRun && popupW >= 88 ? 26 : 6);
  const listHints = [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "open" },
    { key: "N", label: "new run" },
    { key: "I", label: "initiatives" },
    { key: "G", label: "gates" },
    { key: "R", label: "routing" },
    { key: "U", label: "usage" },
    { key: "W", label: "workflows" },
    { key: "Esc", label: "close" },
  ];
  if (screen === "new")
    return (
      <PremiumPopup
        visible
        title="Workflow"
        blurb="Start a spec-driven run"
        width={popupW}
        height={Math.min(40, height)}
        footerHints={[
          { key: "Tab/↑↓", label: "field" },
          { key: "←→", label: "change" },
          { key: "Ctrl+S", label: "start" },
          { key: "Esc", label: "back" },
        ]}
        flash={flash}
      >
        <NewRunForm
          key={`${draftWorkflow ?? ""}:${draftPrompt}`}
          active
          info={info}
          model={activeModel}
          initialPrompt={draftPrompt}
          initialWorkflow={draftWorkflow}
          width={contentW}
          onStart={start}
          onCancel={() => useWorkflowStore.getState().showHome()}
          onEdit={(id) => useWorkflowStore.getState().showEditor(id, "new")}
        />
      </PremiumPopup>
    );

  if (screen === "editor" && editorId)
    return (
      <WorkflowEditorPopup
        workspace={workspace}
        workflowId={editorId}
        api={editorApi}
        width={popupW}
        height={Math.min(40, height)}
        onBack={() => {
          const store = useWorkflowStore.getState();
          if (editorReturn === "new") store.showNew();
          else store.showHome();
        }}
      />
    );

  if (screen === "initiatives")
    return (
      <InitiativesPopup
        api={initiativesApi}
        width={popupW}
        height={Math.min(40, height)}
        selectedId={initiativeId}
        model={activeModel}
        onSelect={(id) => useWorkflowStore.getState().showInitiatives(id)}
        onBack={() => useWorkflowStore.getState().showHome()}
        onOpenRun={(id) => {
          useWorkflowStore.getState().openInitiativeRun(id, activeTabId);
          setTab("overview");
        }}
      />
    );

  if (screen === "workflows")
    return (
      <WorkflowsPopup
        definitions={Object.entries(info?.definitions ?? {}).map(([id, d]) => ({ id, ...d }))}
        width={popupW}
        height={Math.min(40, height)}
        onBack={() => useWorkflowStore.getState().showHome()}
        onEdit={(id) => useWorkflowStore.getState().showEditor(id)}
      />
    );

  if (screen === "routing")
    return (
      <RoutingPopup
        api={routingApi}
        model={activeModel && activeModel !== "none" ? activeModel : null}
        width={popupW}
        height={Math.min(40, height)}
        onBack={() => useWorkflowStore.getState().showHome()}
        onSaved={() => {
          // An idle worker restarts so new runs read the saved routing; a busy one keeps going.
          const driving = existingWorkflowSession(workspace)?.drivingRuns() ?? [];
          void reloadWorkflowSession(workspace, driving);
        }}
      />
    );

  if (screen === "usage")
    return (
      <UsagePopup
        load={loadUsage}
        width={popupW}
        height={Math.min(40, height)}
        onBack={() => useWorkflowStore.getState().showHome()}
        onExport={(summary) => writeUsageMarkdown(workspace, usageFileName(summary.days), summary)}
      />
    );

  if (screen === "gates")
    return (
      <PremiumPopup
        visible
        title="Workflow"
        blurb="Gates: checks every new run must pass"
        width={popupW}
        height={Math.min(40, height)}
        footerHints={GATES_HINTS[gatesMode]}
        flash={flash}
      >
        <box flexDirection="column" paddingX={1}>
          <GatesView
            active
            workspace={workspace}
            api={gatesApi}
            canRun={enabled !== false}
            width={contentW}
            onBack={() => useWorkflowStore.getState().showHome()}
            onMode={setGatesMode}
            notify={(kind, message) => setFlash({ kind, message })}
          />
        </box>
      </PremiumPopup>
    );

  if (!onRun) {
    const needsYou = ordered?.filter((r) => r.pendingKind).length ?? 0;
    return (
      <PremiumPopup
        visible
        title="Workflow"
        blurb={
          enabled === false
            ? "Turned off for this project"
            : needsYou
              ? `${needsYou} run${needsYou > 1 ? "s" : ""} waiting for you`
              : "Runs in this project"
        }
        width={popupW}
        height={Math.min(40, height)}
        footerHints={
          enabled === false
            ? [
                { key: "E", label: "enable" },
                { key: "G", label: "gates" },
                { key: "R", label: "routing" },
                { key: "Esc", label: "close" },
              ]
            : listHints
        }
        flash={flash}
      >
        <box flexDirection="column" paddingX={1}>
          {listError ? (
            <>
              <text fg={t.error}>{`✗ ${listError}`}</text>
              {errorHint(listError) ? <Hint kind="warn">{errorHint(listError)}</Hint> : null}
            </>
          ) : null}
          {enabled === false ? (
            <Onboarding checks={detectChecks(workspace)} model={activeModel} />
          ) : (
            <RunList runs={ordered} cursor={cursor} width={contentW} />
          )}
        </box>
      </PremiumPopup>
    );
  }

  const tasks = service ? service.store.tasks(runId) : [];
  const liveTasks = tasks.filter((task) => task.status !== "invalidated");
  const checks = service ? service.store.checks(runId) : [];
  const findings = service ? service.store.findings(runId) : [];
  const details = service ? service.store.details(runId) : null;
  const stages = service ? service.store.stages(runId) : [];
  const openFindings = findings.filter((f) => ["open", "confirmed"].includes(f.status)).length;
  const checkDetails = service ? service.store.checkDetails(runId) : [];
  const changes = service ? service.store.changes(runId) : [];
  const codeChanges = changes.filter((c) => c.source === "code").length;
  const failedChecks = checkDetails.filter((c) => c.status !== "passed").length;
  const tabs: SidebarTab<Section>[] = sections.map((id) => {
    const count =
      id === "tasks" && liveTasks.length
        ? ` ${liveTasks.filter((x) => ["implemented", "verified"].includes(x.status)).length}/${liveTasks.length}`
        : id === "changes" && codeChanges
          ? ` ${codeChanges}`
          : id === "findings" && openFindings
            ? ` ${openFindings}`
            : id === "decision" && pending
              ? " ⚑"
              : "";
    return {
      id,
      label: `${SECTION_LABELS[id]}${count}`,
      ...(id === "checks" && failedChecks ? { status: "error" as const } : {}),
      ...(id === "findings" && openFindings ? { status: "warning" as const } : {}),
    };
  });
  const budgetView = service ? service.store.budget(runId) : null;
  const worktree = service ? service.store.worktree(runId) : null;
  const actions = snapshot
    ? runActions(snapshot, budgetView, switchTo, worktree?.present === true).filter(
        (a) => !(a.action === "undo" && driving),
      )
    : [];
  const hints =
    tab === "decision" && pending
      ? [
          { key: "Tab", label: "section" },
          ...(pending.kind === "approval"
            ? [
                { key: "A", label: "approve" },
                { key: "X", label: "reject" },
              ]
            : pending.kind === "convergence"
              ? [
                  { key: "A", label: "accept findings" },
                  { key: "C", label: "repair once more" },
                  { key: "X", label: "stop here" },
                ]
              : pending.kind === "checkpoint"
                ? [
                    { key: "C", label: "continue" },
                    { key: "X", label: "stop here" },
                  ]
                : pending.kind === "clarification"
                  ? [
                      { key: "↑↓", label: "question" },
                      { key: "Enter", label: "next" },
                      { key: "Ctrl+S", label: "send" },
                    ]
                  : [{ key: "Enter", label: "submit" }]),
          { key: "Esc", label: "back" },
        ]
      : [
          { key: "Tab", label: "section" },
          ...(tab === "changes" && changes.length
            ? [
                { key: "↑↓", label: "file" },
                { key: "Enter", label: "diff" },
              ]
            : []),
          ...actions
            .filter((a) => !(tab === "changes" && a.action === "decide"))
            .map(({ key, label }) => ({ key, label })),
          { key: "Esc", label: runReturn === "initiatives" ? "back" : "back to runs" },
        ];
  return (
    <PremiumPopup
      visible
      title="Workflow"
      blurb={
        snapshot
          ? `${snapshot.featureId} · ${snapshot.status}${snapshot.reason !== "none" ? ` (${snapshot.reason})` : ""}${driving && !isTerminal(snapshot.status) ? " · ⟳ live" : ""}`
          : undefined
      }
      status={snapshot ? TONE_STATUS[statusTone(snapshot.status)] : undefined}
      width={popupW}
      height={Math.min(40, height)}
      footerHints={hints}
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
      flash={flash}
    >
      <box flexDirection="column" paddingX={1}>
        {confirmExtend && budgetView ? (
          <text fg={t.warning}>
            {`Raise the limits (${extensionText(budgetView)}) and continue from this stage? The approved plan, scope and checks stay as they are. Y confirms; N keeps the run blocked.`}
          </text>
        ) : null}
        {confirmReroute && switchTo ? (
          <text fg={t.warning}>
            {`Switch this run from ${runModel} to ${switchTo} and continue? Completed stages and tasks stay; routes follow modelRouting with the new run model. Y confirms; N keeps the current model.`}
          </text>
        ) : null}
        {confirmUndo ? (
          <text fg={t.warning}>
            Undo this run's uncommitted task edits? Files changed since the run wrote them stay as
            they are. Y confirms; N keeps the files.
          </text>
        ) : null}
        {confirmAccept ? (
          <text fg={t.warning}>
            {confirmAccept.length
              ? `Keep the files changed outside the run (${confirmAccept.slice(0, 5).join(", ")}${confirmAccept.length > 5 ? `, and ${String(confirmAccept.length - 5)} more` : ""}) and continue? Later tasks build on them. Y confirms; N keeps the run blocked.`
              : "No file differs from the run any more. Y retries the run; N keeps it blocked."}
          </text>
        ) : null}
        {undone?.runId === runId ? <UndoReport report={undone.report} /> : null}
        {confirmDiscard && worktree ? (
          <text fg={t.warning}>
            {`Remove this run's worktree ${worktree.path} and delete its branch ${worktree.branch}? Work that was not delivered is lost. Y confirms; N keeps them.`}
          </text>
        ) : null}
        {forkPick ? (
          <text fg={t.warning}>
            {`Fork from: ${forkPick.stages.map((stage, i) => (i === forkPick.index ? `[${stage || "start"}]` : ` ${stage || "start"} `)).join(" ")}. ${forkPick.stages[forkPick.index] ? `The new run starts at ${forkPick.stages[forkPick.index]} with this run's approval and changes.` : "The new run reuses the spec and plan and needs a new approval."} ←→ picks; Y forks; N keeps this run.`}
          </text>
        ) : null}
        {fixChecks ? (
          <text fg={t.warning}>
            {`${fixChecks.summary}. Start a ${fixChecks.workflowId} run (${fixChecks.featureId}) for them? Deliver it afterwards with --follow-up ${runId}${fixChecks.deliver}. Y starts it; N leaves it.`}
          </text>
        ) : null}
        {confirmCancel ? (
          <text fg={t.warning}>
            Cancel this run? It cannot be resumed afterwards. Y confirms; N keeps it.
          </text>
        ) : null}
        {error ? (
          <>
            <text fg={t.error}>{`✗ ${error}`}</text>
            {errorHint(error) ? <Hint kind="warn">{errorHint(error)}</Hint> : null}
          </>
        ) : null}
        {!snapshot ? (
          <text fg={t.textMuted}>Loading run…</text>
        ) : (
          <>
            {tab === "overview" && service && (
              <RunOverview
                snapshot={snapshot}
                details={details}
                stages={stages}
                budget={service.store.budget(runId)}
                estimate={service.store.estimate(runId)}
                routing={service.store.routing(runId)}
                events={service.store.events(runId)}
                tasks={tasks}
                findings={findings}
                checks={checks}
                gates={service.store.gates(runId)}
                driving={driving}
                driveError={driveError}
                width={contentW}
              />
            )}
            {tab === "decision" &&
              (pending ? (
                <DecisionPrompt
                  key={pending.id}
                  request={pending}
                  details={details}
                  active={!confirmCancel}
                  width={contentW}
                  onBack={() => useWorkflowStore.getState().leaveRun()}
                  onDecision={(decision) => {
                    void act(decision);
                  }}
                />
              ) : (
                <text fg={t.textMuted}>
                  {snapshot.approvalDigest
                    ? "Nothing waits for you. The plan was approved; the run continues on its own."
                    : "Nothing waits for you right now. You will be brought here when a decision is needed."}
                </text>
              ))}
            {tab === "tasks" && (
              <>
                <TaskGraphView tasks={tasks} />
                {details?.hostEdits && (
                  <ArtifactReview
                    title="Host edits (host-edits.json)"
                    content={JSON.stringify(details.hostEdits, null, 2)}
                  />
                )}
              </>
            )}
            {tab === "spec" && (
              <ArtifactReview
                title="Specification"
                content={
                  details?.specMarkdown ?? "The specification appears after the Specify stage."
                }
              />
            )}
            {tab === "plan" && (
              <ArtifactReview
                title="Plan"
                content={details?.plan ?? "The plan appears after the Plan stage."}
              />
            )}
            {tab === "checks" && (
              <ChecksView
                checks={checkDetails}
                configured={service ? service.store.configuredChecks(runId) : []}
              />
            )}
            {tab === "changes" && service && (
              <ChangesView
                changes={changes}
                active={!confirmCancel}
                loadDiff={(path) => service.diff(runId, path)}
              />
            )}
            {tab === "criteria" && (
              <ArtifactReview
                title="Criterion coverage"
                content={
                  details?.criteria
                    .map(
                      (c) =>
                        `${c.verdict === "pass" ? "✓" : c.verdict === "fail" ? "✗" : "·"} ${c.id} [${c.method}]: ${c.verdict ?? "not assessed"}\n  ${c.text}\n  Evidence: ${c.evidenceIds.join(", ") || "none"}`,
                    )
                    .join("\n\n") || "Criteria appear after the Specify stage."
                }
              />
            )}
            {tab === "findings" && <FindingsView findings={findings} />}
          </>
        )}
      </box>
    </PremiumPopup>
  );
}
