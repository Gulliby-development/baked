import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
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
import { Hint, PremiumPopup, Section } from "../ui/index.js";
import { errorHint, formatDuration, formatTokens } from "./format.js";

/** Everything the initiative screen needs from the outside, so it renders the same in tests. */
export interface InitiativesApi {
  /** Every initiative with what the worker drives; null when workflows are off for the project. */
  load(): Promise<InitiativeListView | null>;
  act(initiativeId: string, action: InitiativeAction): Promise<InitiativeView>;
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
const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;

/** Footer keys for the list, the detail with its available commands, and a confirmation. */
export function initiativeHints(
  mode: "list" | "detail" | "confirm",
  actions: InitiativeActionOption[] = [],
  canOpenRun = false,
): { key: string; label: string }[] {
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
}: {
  api: InitiativesApi;
  width: number;
  height: number;
  /** The initiative shown in detail; null shows the list. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const t = useTheme();
  const [data, setData] = useState<InitiativeListView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [featureCursor, setFeatureCursor] = useState(0);
  const [confirm, setConfirm] = useState<InitiativeActionOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);
  const [epoch, setEpoch] = useState(0);

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
  const actions = selected ? initiativeActions(selected, driving, feature) : [];
  useEffect(() => {
    if (cursor >= ordered.length && ordered.length) setCursor(ordered.length - 1);
  }, [ordered.length, cursor]);

  const run = useCallback(
    async (option: InitiativeActionOption, id: string): Promise<void> => {
      setBusy(true);
      try {
        await api.act(id, option.action);
        setFlash({ kind: "ok", message: `${option.label}: done` });
      } catch (err) {
        setFlash({ kind: "err", message: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
        setEpoch((e) => e + 1);
      }
    },
    [api],
  );

  useKeyboard((event) => {
    if (event.defaultPrevented) return;
    const key = event.name.toLowerCase();
    if (confirm) {
      event.preventDefault();
      if (key === "y" && selected) {
        const option = confirm;
        setConfirm(null);
        void run(option, selected.initiativeId);
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
    const option = actions.find((a) => a.key.toLowerCase() === key);
    if (!option || busy) return;
    event.preventDefault();
    if (option.confirm) setConfirm(option);
    else void run(option, selected.initiativeId);
  });

  const contentW = width - 6;
  const contentH = height - 8;
  const needsYou = ordered.filter((v) => summarizeInitiative(v).needsYou).length;
  const hints = confirm
    ? initiativeHints("confirm")
    : selected
      ? [
          ...initiativeHints("detail", actions, !!feature?.runId),
          ...(selected.decompose ? [{ key: "O", label: "split run" }] : []),
        ]
      : initiativeHints("list");
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
        {confirm ? <text fg={t.warning}>{confirm.confirm}</text> : null}
        {data === undefined ? (
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
            width={contentW}
            height={contentH - (confirm ? 2 : 0)}
          />
        ) : selectedId ? (
          <text fg={t.textMuted}>{`Initiative ${selectedId} is not in this project.`}</text>
        ) : (
          <InitiativeList views={ordered} cursor={cursor} width={contentW} />
        )}
      </box>
    </PremiumPopup>
  );
}

export function InitiativeList({
  views,
  cursor,
  width,
}: {
  views: InitiativeView[];
  cursor: number;
  width: number;
}) {
  const t = useTheme();
  if (views.length === 0)
    return (
      <Section
        title="No initiatives yet"
        description="An initiative splits a large request into 3 to 12 features with contracts, run one at a time in dependency order."
      >
        <text fg={t.textPrimary}>
          {clip('Start one with: baked workflow initiative start ID --prompt "..."', width)}
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
        const budget = `${formatTokens(s.tokensUsed)}/${formatTokens(s.tokensLimit)} tokens`;
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
                  `    ${progress} · ${budget}${attention ? ` · ${attention}` : ""}`,
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
                {clip(`${progress} · ${budget}${attention ? ` · ${attention}` : ""}`, detailW)}
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
  width,
  height,
}: {
  view: InitiativeView;
  featureCursor: number;
  driveError: string | null;
  width: number;
  height: number;
}) {
  const t = useTheme();
  const split = pendingSplitApproval(view);
  const blockers = initiativeIsTerminal(view) ? [] : initiativeBlockers(view);
  const { limits, used } = view.budget;
  const plan =
    view.approvedPlanRevision === null
      ? `revision ${view.planRevision || "none"} (not approved)`
      : view.approvedPlanRevision === view.planRevision
        ? `revision ${view.planRevision} (approved)`
        : `revision ${view.planRevision} (approved: ${view.approvedPlanRevision})`;
  const narrow = width < 64;
  // Header, plan, budget and next take four lines; the selected feature takes up to three more.
  const fixed = 4 + (split ? 2 : 0) + Math.min(2, blockers.length) + (driveError ? 1 : 0) + 4;
  const rows = Math.max(2, height - fixed);
  const start = Math.max(
    0,
    Math.min(featureCursor - Math.floor(rows / 2), view.features.length - rows),
  );
  const shown = view.features.slice(start, start + rows);
  const selected = view.features[featureCursor] ?? null;
  const idW = narrow ? Math.max(8, Math.floor(width * 0.4)) : Math.min(20, Math.floor(width * 0.2));
  return (
    <box flexDirection="column">
      <text fg={t.textPrimary} attributes={1}>
        {clip(view.title, width)}
      </text>
      <text fg={t.textMuted}>
        {clip(
          `Plan ${plan} · ${view.workflowId}${view.featureAutoApproval ? " · tiered approval" : ""}`,
          width,
        )}
      </text>
      <text fg={t.textMuted}>
        {clip(
          `Budget ${formatTokens(used.tokens)}/${formatTokens(limits.maxTotalTokens)} tokens · ${used.calls}/${limits.maxAgentCalls} calls · ${formatDuration(used.activeMs)}/${formatDuration(limits.maxActiveMs)}`,
          width,
        )}
      </text>
      <text fg={view.next.kind === "blocked" ? t.error : t.info}>
        {clip(`Next: ${view.next.message || view.next.kind}`, width)}
      </text>
      {split ? (
        <Hint kind="warn">
          {`Split approval pending for plan revision ${view.planRevision} (digest ${split.digest.slice(0, 12)}). A approves it; edit the split with baked workflow initiative merge, split, remove or rename.`}
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
      {shown.map((f) => {
        const index = view.features.indexOf(f);
        const isSelected = index === featureCursor;
        const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
        const color = FEATURE_COLOR[f.state](t);
        const run = f.runId ? `${f.runStatus ?? "?"} · run ${f.runId}` : "no run yet";
        const deps = f.dependsOn.length ? ` ← ${f.dependsOn.join(", ")}` : "";
        const rest = narrow
          ? f.state.replace("_", " ")
          : `${f.state.replace("_", " ")} · ${run}${deps}`;
        return (
          <box key={f.id} flexDirection="row" backgroundColor={bg}>
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
        );
      })}
      {selected ? (
        <box flexDirection="column">
          <text fg={t.textMuted}>
            {clip(
              narrow
                ? `${selected.title} · ${selected.runId ? `run ${selected.runId} (${selected.runStatus})` : "no run yet"}`
                : `${selected.title} · contract: ${selected.contract}`,
              width,
            )}
          </text>
          {selected.pendingRequests.length ? (
            <text fg={t.warning}>
              {clip(
                `⚑ ${selected.pendingRequests.map((r) => r.kind.replace("_", " ")).join(", ")} waits in run ${selected.runId}; Enter opens it`,
                width,
              )}
            </text>
          ) : selected.blockers.length ? (
            <text fg={t.error}>{clip(`✗ ${selected.blockers.join("; ")}`, width)}</text>
          ) : null}
        </box>
      ) : null}
    </box>
  );
}
