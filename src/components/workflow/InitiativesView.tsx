import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import {
  estimateSummary,
  type InitiativeEstimate,
} from "../../core/workflows/initiatives/estimate.js";
import { costText, type InitiativeStartInput } from "../../core/workflows/initiatives/forms.js";
import type { FeatureView, InitiativeView } from "../../core/workflows/initiatives/service.js";
import {
  type InitiativeAction,
  type InitiativeActionOption,
  type InitiativeListView,
  initiativeActions,
  initiativeBlockers,
  initiativeIsTerminal,
  orderInitiatives,
  pendingSplitApproval,
  summarizeInitiative,
} from "../../core/workflows/initiatives/view-model.js";
import type { WorkflowInfo } from "../../core/workflows/view.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { HardShadow } from "../ui/BrutalBox.js";
import { FocusTarget } from "../ui/FocusTarget.js";
import { Hint, PremiumPopup, Section } from "../ui/index.js";
import { errorHint, formatDuration, formatTokens } from "./format.js";
import { InitiativeStartForm } from "./InitiativeStartForm.js";

/** Everything the initiative screen needs from the outside, so it renders the same in tests. */
export interface InitiativesApi {
  /** Every initiative with what the worker drives; null when workflows are off for the project. */
  load(): Promise<InitiativeListView | null>;
  act(initiativeId: string, action: InitiativeAction): Promise<InitiativeView>;
  /** Starts an initiative from the form; absent, the screen offers no start. */
  start?(input: InitiativeStartInput): Promise<InitiativeView>;
  /** Workflows the start form offers. */
  info?(): Promise<Pick<WorkflowInfo, "workflows" | "defaultWorkflow">>;
  /** The estimate of an initiative's split; absent, the screen offers none. */
  estimate?(initiativeId: string): Promise<InitiativeEstimate | null>;
}

type Color = (t: ReturnType<typeof useTheme>) => string;
const STATUS_COLOR: Record<InitiativeView["status"], Color> = {
  decomposing: (t) => t.info,
  awaiting_approval: (t) => t.warning,
  active: (t) => t.info,
  paused: (t) => t.warning,
  completed: (t) => t.success,
  refused: (t) => t.error,
};
const STATUS_TEXT: Record<InitiativeView["status"], string> = {
  decomposing: "splitting",
  awaiting_approval: "approve split",
  active: "active",
  paused: "paused",
  completed: "completed",
  refused: "refused",
};
const FEATURE_COLOR: Record<FeatureView["state"], Color> = {
  proposed: (t) => t.textMuted,
  waiting: (t) => t.textMuted,
  ready: (t) => t.textSecondary,
  in_progress: (t) => t.info,
  needs_decision: (t) => t.warning,
  paused: (t) => t.warning,
  blocked: (t) => t.error,
  failed: (t) => t.error,
  stale: (t) => t.warning,
  accepted: (t) => t.success,
};
const FEATURE_GLYPH: Record<FeatureView["state"], string> = {
  proposed: "·",
  waiting: "○",
  ready: "○",
  in_progress: "◐",
  needs_decision: "⚑",
  paused: "‖",
  blocked: "✗",
  failed: "✗",
  stale: "↻",
  accepted: "✓",
};
/** A feature's boundary paths, with the placeholders it creates for later features (#1464). */
const pathText = (f: { paths?: number; placeholders?: number }): string => {
  const paths = f.paths ? `${f.paths} ${f.paths === 1 ? "path" : "paths"}` : "";
  const stubs = f.placeholders
    ? `${f.placeholders} ${f.placeholders === 1 ? "placeholder" : "placeholders"}`
    : "";
  return paths || stubs ? ` for ${[paths, stubs].filter(Boolean).join(" + ")}` : "";
};
const featureEstimateText = (estimate: InitiativeEstimate | null, featureId: string): string => {
  const f = estimate?.features.find((e) => e.featureId === featureId);
  if (!f) return "";
  return f.basis === "measured"
    ? ` · used ${formatTokens(f.tokens.high)} tokens`
    : ` · estimate ${formatTokens(f.tokens.low)}-${formatTokens(f.tokens.high)} tokens${pathText(f)}${f.floor ? ` (by ${f.floor})` : ""}`;
};
const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;

/** Footer keys for the list, the detail with its available commands, and a confirmation. */
export function initiativeHints(
  mode: "list" | "detail" | "confirm" | "input" | "start",
  actions: InitiativeActionOption[] = [],
  canOpenRun = false,
  canStart = false,
): { key: string; label: string }[] {
  if (mode === "input")
    return [
      { key: "Enter", label: "submit" },
      { key: "Esc", label: "cancel" },
    ];
  if (mode === "start")
    return [
      { key: "Tab", label: "next field" },
      { key: "Ctrl+S", label: "start" },
      { key: "Esc", label: "cancel" },
    ];
  if (mode === "confirm")
    return [
      { key: "Y", label: "confirm" },
      { key: "N", label: "keep" },
      { key: "Esc", label: "cancel" },
    ];
  if (mode === "list")
    return [
      { key: "↑↓", label: "select" },
      { key: "Enter", label: "open" },
      ...(canStart ? [{ key: "N", label: "new initiative" }] : []),
      { key: "Esc", label: "back to runs" },
    ];
  return [
    { key: "↑↓", label: "feature" },
    ...(canOpenRun ? [{ key: "Enter", label: "open run" }] : []),
    ...actions.map(({ key, label }) => ({ key, label })),
    { key: "Esc", label: "back" },
  ];
}

export function InitiativesPopup({
  api,
  width,
  height,
  selectedId,
  onSelect,
  onBack,
  onOpenRun,
  model = null,
}: {
  api: InitiativesApi;
  width: number;
  height: number;
  /** The initiative shown in detail; null shows the list. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
  /** The chat tab's model; M switches the initiative to it. */
  model?: string | null;
}) {
  const t = useTheme();
  const [data, setData] = useState<InitiativeListView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [featureCursor, setFeatureCursor] = useState(0);
  const [confirm, setConfirm] = useState<InitiativeActionOption | null>(null);
  // The action waiting for text, such as a reject reason or a new title, and the text so far.
  const [typing, setTyping] = useState<{ option: InitiativeActionOption; text: string } | null>(
    null,
  );
  const [starting, setStarting] = useState(false);
  // Keys typed after N but before the start form renders begin its request.
  const opening = useRef<string | null>(null);
  const [workflowInfo, setWorkflowInfo] = useState<Pick<
    WorkflowInfo,
    "workflows" | "defaultWorkflow"
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  // Estimates asked for with T, by initiative; they stay until the screen closes.
  const [estimates, setEstimates] = useState<Record<string, InitiativeEstimate>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch forces an immediate reload after a command
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await api.load();
        if (disposed) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, epoch]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  const ordered = useMemo(() => (data ? orderInitiatives(data.initiatives) : []), [data]);
  const selected = selectedId ? (ordered.find((v) => v.initiativeId === selectedId) ?? null) : null;
  const features = selected?.features ?? [];
  const feature = features[Math.min(featureCursor, Math.max(0, features.length - 1))] ?? null;
  const driving = !!(selected && data?.driving.includes(selected.initiativeId));
  const actions = selected ? initiativeActions(selected, driving, feature, model) : [];
  useEffect(() => {
    if (cursor >= ordered.length && ordered.length) setCursor(ordered.length - 1);
  }, [ordered.length, cursor]);

  const run = useCallback(
    async (label: string, action: InitiativeAction, id: string): Promise<void> => {
      setBusy(true);
      try {
        await api.act(id, action);
        setFlash({ kind: "ok", message: `${label}: done` });
      } catch (err) {
        setFlash({ kind: "err", message: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
        setEpoch((e) => e + 1);
      }
    },
    [api],
  );

  useEffect(() => {
    if (starting) opening.current = null;
  }, [starting]);
  const openStart = (): void => {
    opening.current = "";
    setStarting(true);
    if (!workflowInfo && api.info)
      void api.info().then(setWorkflowInfo, () => setWorkflowInfo(null));
  };
  const submitTyped = (): void => {
    if (!typing?.option.input || !selected) return;
    try {
      const action = typing.option.input.build(typing.text);
      const label = typing.option.label;
      setTyping(null);
      void run(label, action, selected.initiativeId);
    } catch (err) {
      setFlash({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    }
  };

  useKeyboard((event) => {
    if (event.defaultPrevented || starting) return;
    if (opening.current !== null) {
      const ch = event.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && !event.ctrl && !event.meta) {
        event.preventDefault();
        opening.current += ch;
      }
      return;
    }
    const key = event.name.toLowerCase();
    if (typing) {
      if (key === "escape") {
        event.preventDefault();
        setTyping(null);
      }
      return;
    }
    if (confirm) {
      event.preventDefault();
      if (key === "y" && selected) {
        const option = confirm;
        setConfirm(null);
        void run(option.label, option.action, selected.initiativeId);
      } else if (key === "n" || key === "escape") setConfirm(null);
      return;
    }
    const up = key === "up" || key === "k";
    const down = key === "down" || key === "j";
    if (!selected) {
      if (key === "escape") {
        event.preventDefault();
        onBack();
      } else if ((up || down) && ordered.length) {
        event.preventDefault();
        const n = ordered.length;
        setCursor((c) => (up ? (c > 0 ? c - 1 : n - 1) : c < n - 1 ? c + 1 : 0));
      } else if (key === "return" && ordered[cursor]) {
        event.preventDefault();
        setFeatureCursor(0);
        onSelect(ordered[cursor].initiativeId);
      } else if (key === "n" && api.start && data) {
        event.preventDefault();
        openStart();
      }
      return;
    }
    if (key === "escape") {
      event.preventDefault();
      onSelect(null);
      return;
    }
    if ((up || down) && features.length) {
      event.preventDefault();
      const n = features.length;
      setFeatureCursor((c) => (up ? (c > 0 ? c - 1 : n - 1) : c < n - 1 ? c + 1 : 0));
      return;
    }
    if (key === "return" && feature?.runId) {
      event.preventDefault();
      onOpenRun(feature.runId);
      return;
    }
    if (key === "o" && selected.decompose) {
      event.preventDefault();
      onOpenRun(selected.decompose.runId);
      return;
    }
    if (key === "t" && api.estimate && features.length) {
      event.preventDefault();
      const id = selected.initiativeId;
      void api.estimate(id).then(
        (estimate) => {
          if (estimate) setEstimates((all) => ({ ...all, [id]: estimate }));
        },
        (err: unknown) =>
          setFlash({ kind: "err", message: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    const option = actions.find((a) => a.key.toLowerCase() === key);
    if (!option || busy) return;
    event.preventDefault();
    if (option.input) setTyping({ option, text: option.input.initial });
    else if (option.confirm) setConfirm(option);
    else void run(option.label, option.action, selected.initiativeId);
  });

  const contentW = width - 6;
  const needsYou = ordered.filter((v) => summarizeInitiative(v).needsYou).length;
  const hints = starting
    ? initiativeHints("start")
    : typing
      ? initiativeHints("input")
      : confirm
        ? initiativeHints("confirm")
        : selected
          ? [
              ...initiativeHints("detail", actions, !!feature?.runId),
              ...(selected.decompose ? [{ key: "O", label: "split run" }] : []),
              ...(api.estimate && features.length ? [{ key: "T", label: "estimate" }] : []),
            ]
          : initiativeHints("list", [], false, !!api.start && !!data);
  return (
    <PremiumPopup
      visible
      title="Workflow"
      blurb={
        selected
          ? `Initiative ${selected.initiativeId} · ${STATUS_TEXT[selected.status]}${driving ? " · ⟳ live" : ""}`
          : needsYou
            ? `Initiatives: ${needsYou} waiting for you`
            : "Initiatives: large requests split into features"
      }
      width={width}
      height={height}
      footerHints={hints}
      flash={flash}
    >
      <box flexDirection="column" paddingX={1}>
        {error ? (
          <>
            <text fg={t.error}>{`✗ ${error}`}</text>
            {errorHint(error) ? <Hint kind="warn">{errorHint(error)}</Hint> : null}
          </>
        ) : null}
        {starting && api.start && data ? (
          <InitiativeStartForm
            active
            initialPrompt={opening.current ?? ""}
            model={model}
            workflows={workflowInfo?.workflows ?? []}
            defaultWorkflow={workflowInfo?.defaultWorkflow ?? "sdd"}
            taken={data.initiatives.map((v) => v.initiativeId)}
            width={contentW}
            onCancel={() => setStarting(false)}
            onStart={async (input) => {
              const start = api.start;
              if (!start) return;
              const view = await start(input);
              setStarting(false);
              setFlash({ kind: "ok", message: `Initiative ${view.initiativeId} started` });
              setFeatureCursor(0);
              onSelect(view.initiativeId);
              setEpoch((e) => e + 1);
            }}
          />
        ) : typing?.option.input ? (
          <box flexDirection="column">
            <text fg={t.warning}>{typing.option.input.question}</text>
            <HardShadow width={Math.max(20, contentW - 2) + 1}>
              <box
                border
                borderStyle="heavy"
                borderColor={t.brand}
                paddingX={1}
                backgroundColor={t.bgPopup}
              >
                <input
                  value={typing.text}
                  onInput={(text: string) => setTyping((cur) => (cur ? { ...cur, text } : cur))}
                  onSubmit={submitTyped}
                  placeholder={typing.option.input.placeholder}
                  focused
                  backgroundColor={t.bgPopup}
                />
              </box>
            </HardShadow>
          </box>
        ) : confirm ? (
          <text fg={t.warning}>{confirm.confirm}</text>
        ) : data === undefined ? (
          <text fg={t.textMuted}>Loading initiatives…</text>
        ) : data === null ? (
          <Section
            title="Workflows are off"
            description="Initiatives run on workflows. Press Esc, then E on the run list to enable them."
          >
            <text fg={t.textMuted}> </text>
          </Section>
        ) : selected ? (
          <InitiativeDetail
            view={selected}
            featureCursor={Math.min(featureCursor, Math.max(0, features.length - 1))}
            driveError={data.errors[selected.initiativeId] ?? null}
            estimate={estimates[selected.initiativeId] ?? null}
            width={contentW}
          />
        ) : selectedId ? (
          <text fg={t.textMuted}>{`Initiative ${selectedId} is not in this project.`}</text>
        ) : (
          <InitiativeList views={ordered} cursor={cursor} width={contentW} canStart={!!api.start} />
        )}
      </box>
    </PremiumPopup>
  );
}

export function InitiativeList({
  views,
  cursor,
  width,
  canStart = false,
}: {
  views: InitiativeView[];
  cursor: number;
  width: number;
  /** Whether N opens the start form here. */
  canStart?: boolean;
}) {
  const t = useTheme();
  if (views.length === 0)
    return (
      <Section
        title="No initiatives yet"
        description="An initiative splits a large request into 3 to 12 features with contracts, run one at a time in dependency order."
      >
        <text fg={t.textPrimary}>
          {clip(
            canStart
              ? "Press N to start one."
              : 'Start one with: baked workflow initiative start ID --prompt "..."',
            width,
          )}
        </text>
        <Hint>You approve the split once; each feature run asks for its own approvals.</Hint>
      </Section>
    );
  const narrow = width < 64;
  const idW = narrow
    ? Math.max(8, width - 18)
    : Math.max(12, Math.min(26, Math.floor(width * 0.26)));
  return (
    <box flexDirection="column">
      {views.map((view, i) => {
        const s = summarizeInitiative(view);
        const isSelected = i === cursor;
        const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
        const color = s.needsYou ? t.warning : STATUS_COLOR[view.status](t);
        const glyph = s.needsYou ? "⚑" : initiativeIsTerminal(view) ? "✓" : "◐";
        const progress = `${s.accepted}/${s.total} features`;
        const budget = `${formatTokens(s.tokensUsed)}/${formatTokens(s.tokensLimit)} tokens${s.cost ? ` · ${s.cost}` : ""}`;
        const attention = [
          s.pending ? `${s.pending} decision${s.pending > 1 ? "s" : ""}` : "",
          s.blockers ? `${s.blockers} blocker${s.blockers > 1 ? "s" : ""}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const status = STATUS_TEXT[view.status];
        if (narrow)
          return (
            <box key={view.initiativeId} flexDirection="column" backgroundColor={bg}>
              <box flexDirection="row" backgroundColor={bg}>
                <text bg={bg} fg={isSelected ? t.brand : t.textFaint}>
                  {isSelected ? "▸ " : "  "}
                </text>
                <text bg={bg} fg={color}>{`${glyph} `}</text>
                <text bg={bg} fg={isSelected ? t.textPrimary : t.textSecondary} attributes={1}>
                  {clip(view.initiativeId, idW).padEnd(idW)}
                </text>
                <text bg={bg} fg={color}>{` ${status}`}</text>
              </box>
              <text bg={bg} fg={s.needsYou ? t.warning : t.textMuted}>
                {clip(
                  `    ${progress}${attention ? ` · ${attention}` : ""} · ${budget}`,
                  width - 2,
                )}
              </text>
            </box>
          );
        const statusW = 14;
        const detailW = Math.max(10, width - idW - statusW - 6);
        return (
          <box key={view.initiativeId} flexDirection="column" backgroundColor={bg}>
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={isSelected ? t.brand : t.textFaint}>
                {isSelected ? "▸ " : "  "}
              </text>
              <text bg={bg} fg={color}>{`${glyph} `}</text>
              <text
                bg={bg}
                fg={isSelected ? t.textPrimary : t.textSecondary}
                attributes={isSelected ? 1 : 0}
              >
                {clip(view.initiativeId, idW).padEnd(idW)}
              </text>
              <text bg={bg} fg={color}>{` ${status.padEnd(statusW)}`}</text>
              <text bg={bg} fg={s.needsYou ? t.warning : t.textMuted}>
                {clip(`${progress}${attention ? ` · ${attention}` : ""} · ${budget}`, detailW)}
              </text>
            </box>
            {isSelected ? (
              <text bg={bg} fg={t.textMuted}>
                {clip(`    ${view.title} — ${view.next.message}`, width - 2)}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

export function InitiativeDetail({
  view,
  featureCursor,
  driveError,
  estimate = null,
  width,
}: {
  view: InitiativeView;
  featureCursor: number;
  driveError: string | null;
  /** The estimate of the split, once asked for with T. */
  estimate?: InitiativeEstimate | null;
  width: number;
}) {
  const t = useTheme();
  const split = pendingSplitApproval(view);
  const blockers = initiativeIsTerminal(view) ? [] : initiativeBlockers(view);
  const { limits, used } = view.budget;
  const cost = costText(view.budget.cost);
  const plan =
    view.approvedPlanRevision === null
      ? `revision ${view.planRevision || "none"} (not approved)`
      : view.approvedPlanRevision === view.planRevision
        ? `revision ${view.planRevision} (approved)`
        : `revision ${view.planRevision} (approved: ${view.approvedPlanRevision})`;
  const narrow = width < 64;
  const idW = narrow ? Math.max(8, Math.floor(width * 0.4)) : Math.min(20, Math.floor(width * 0.2));
  return (
    <box flexDirection="column">
      <text fg={t.textPrimary} attributes={1}>
        {clip(view.title, width)}
      </text>
      <text fg={t.textMuted}>
        {clip(
          `Plan ${plan} · default workflow ${view.workflowId} · ${view.model ?? "default model"}${view.featureAutoApproval ? " · tiered approval" : ""}${view.parallelRuns > 1 ? ` · up to ${view.parallelRuns} features at once` : ""}`,
          width,
        )}
      </text>
      <text fg={t.textMuted}>
        {clip(
          `Budget ${formatTokens(used.tokens)}/${formatTokens(limits.maxTotalTokens)} tokens · ${used.calls}/${limits.maxAgentCalls} calls · ${formatDuration(used.activeMs)}/${formatDuration(limits.maxActiveMs)}${cost ? ` · ${cost}` : ""}`,
          width,
        )}
      </text>
      {estimate ? (
        <text fg={estimate.budget.fits === "yes" ? t.textMuted : t.warning}>
          {clip(`Estimate: ${estimateSummary(estimate)}`, width)}
        </text>
      ) : null}
      <text fg={view.next.kind === "blocked" ? t.error : t.info}>
        {clip(`Next: ${view.next.message || view.next.kind}`, width)}
      </text>
      {split ? (
        <Hint kind="warn">
          {`Split approval pending for plan revision ${view.planRevision}. A approves it, N rejects it; the keys below edit the selected feature.`}
        </Hint>
      ) : null}
      {driveError ? <text fg={t.error}>{clip(`✗ ${driveError}`, width)}</text> : null}
      {blockers.slice(0, 2).map((b) => (
        <text key={b} fg={t.error}>
          {clip(`✗ ${b}`, width)}
        </text>
      ))}
      <text fg={t.textSecondary} attributes={1}>
        {`Features in dependency order (${view.features.length})`}
      </text>
      {view.features.length === 0 ? (
        <text fg={t.textMuted}>
          {view.decompose
            ? `The split is being proposed by run ${view.decompose.runId} (${view.decompose.status}). O opens it.`
            : "No split yet."}
        </text>
      ) : null}
      {view.features.map((f, index) => {
        const isSelected = index === featureCursor;
        const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
        const color = FEATURE_COLOR[f.state](t);
        const run = f.runId
          ? `${f.runStatus && f.runStatus !== f.state ? `${f.runStatus} · ` : ""}run ${f.runId}`
          : "no run yet";
        const deps = f.dependsOn.length ? ` ← ${f.dependsOn.join(", ")}` : "";
        const rest = narrow
          ? `${f.state.replace("_", " ")} · ${f.workflowId}`
          : `${f.state.replace("_", " ")} · ${f.workflowId} · ${run}${deps}`;
        // The selected feature shows its details under its row; FocusTarget keeps them in view.
        return (
          <FocusTarget key={f.id} active={isSelected}>
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={isSelected ? t.brand : t.textFaint}>
                {isSelected ? "▸ " : "  "}
              </text>
              <text bg={bg} fg={color}>{`${FEATURE_GLYPH[f.state]} `}</text>
              <text bg={bg} fg={isSelected ? t.textPrimary : t.textSecondary}>
                {clip(`${f.id}${f.mandatory ? "" : "?"}`, idW).padEnd(idW)}
              </text>
              <text bg={bg} fg={color}>
                {clip(` ${rest}`, Math.max(4, width - idW - 4))}
              </text>
            </box>
            {isSelected ? (
              <box flexDirection="column" paddingLeft={4}>
                <text fg={t.textMuted}>
                  {clip(
                    narrow
                      ? `${f.title} · ${f.runId ? `run ${f.runId} (${f.runStatus})` : "no run yet"}`
                      : `${f.title} · contract: ${f.contract}`,
                    width - 4,
                  )}
                </text>
                {narrow ? null : (
                  <text fg={t.textMuted}>
                    {clip(
                      `Workflow ${f.workflowId} · ${f.size}${f.share ? ` · starts with ${formatTokens(f.share.tokens)} tokens${f.shareUsd != null ? ` and $${f.shareUsd.toFixed(2)}` : ""}` : ""}${f.spentUsd ? ` · $${f.spentUsd.toFixed(2)} spent` : ""}${featureEstimateText(estimate, f.id)}`,
                      width - 4,
                    )}
                  </text>
                )}
                {f.mergedFrom?.length ? (
                  <text fg={t.textMuted}>
                    {clip(
                      `Merged from ${f.mergedFrom.join(", ")}: too small for a run each`,
                      width - 4,
                    )}
                  </text>
                ) : null}
                {f.issue ? (
                  <text fg={t.textMuted}>
                    {clip(
                      `Issue ${f.issue.repository}#${f.issue.number}: delivery closes it`,
                      width - 4,
                    )}
                  </text>
                ) : null}
                {f.pendingRequests.length ? (
                  <text fg={t.warning}>
                    {clip(
                      `⚑ ${f.pendingRequests.map((r) => r.kind.replace("_", " ")).join(", ")} waits in run ${f.runId}; Enter opens it`,
                      width - 4,
                    )}
                  </text>
                ) : f.blockers.length ? (
                  <text fg={t.error}>{clip(`✗ ${f.blockers.join("; ")}`, width - 4)}</text>
                ) : null}
              </box>
            ) : null}
          </FocusTarget>
        );
      })}
    </box>
  );
}
