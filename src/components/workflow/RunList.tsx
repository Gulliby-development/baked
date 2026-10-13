import { useTheme } from "../../core/theme/index.js";
import type { RunSummary } from "../../core/workflows/view.js";
import { Hint, Section } from "../ui/index.js";
import {
  formatTokens,
  isTerminal,
  reasonText,
  relativeTime,
  statusGlyph,
  statusTone,
} from "./format.js";
import { usd } from "./UsageView.js";

/** Runs that need the user come first, then active runs, then history; newest first inside each. */
export function orderRuns(runs: RunSummary[]): RunSummary[] {
  const rank = (r: RunSummary): number =>
    r.pendingKind ? 0 : isTerminal(r.snapshot.status) ? 2 : 1;
  return [...runs].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

function progressText(run: RunSummary): string {
  const { snapshot, stage, tasks } = run;
  if (run.pendingKind === "checkpoint") return "paused at a token checkpoint";
  if (run.pendingKind) return `needs your ${run.pendingKind.replace("_", " ")}`;
  if (snapshot.status === "completed") return `${tasks.total} tasks done`;
  if (snapshot.status === "blocked" || snapshot.status === "failed")
    return reasonText(snapshot.reason);
  const step = `${stage.id ?? "not started"} ${stage.total ? `${stage.index + 1}/${stage.total}` : ""}`;
  return tasks.total ? `${step} · tasks ${tasks.done}/${tasks.total}` : step;
}

/**
 * The run's progress and token figure in `width` columns. A long reason is cut so the figure
 * shows whole; what a waiting run needs from the user (`keepDetail`) wins over the figure.
 */
export function fitDetail(
  detail: string,
  tokens: string,
  width: number,
  keepDetail = false,
): string {
  const room = width - tokens.length;
  if (room < 4 || (keepDetail && detail.length > room))
    return `${detail}${tokens}`.slice(0, width).padEnd(width);
  const cut = detail.length > room ? `${detail.slice(0, room - 1)}…` : detail;
  return `${cut}${tokens}`.padEnd(width);
}

export function RunList({
  runs,
  cursor,
  width,
}: {
  runs: RunSummary[] | null;
  cursor: number;
  width: number;
}) {
  const t = useTheme();
  if (!runs) return <text fg={t.textMuted}>Loading runs…</text>;
  if (runs.length === 0)
    return (
      <Section
        title="No workflow runs yet"
        description="A run turns a feature request into an approved spec, plan, code, checks and review."
      >
        <text fg={t.textPrimary}>Press N to describe a feature and start the first run.</text>
        <Hint>You approve the spec, plan and file scope before any source file changes.</Hint>
      </Section>
    );
  // Narrow terminals get two-line rows so the feature name and state stay readable.
  const narrow = width < 64;
  const featureW = narrow
    ? Math.max(8, width - 14)
    : Math.max(12, Math.min(28, Math.floor(width * 0.28)));
  const statusW = 10;
  const ageW = 9;
  const detailW = Math.max(10, width - featureW - statusW - ageW - 8);
  return (
    <box flexDirection="column">
      {runs.map((run, i) => {
        const selected = i === cursor;
        const tone = statusTone(run.snapshot.status);
        const color = run.pendingKind
          ? t.warning
          : tone === "online"
            ? t.success
            : tone === "error"
              ? t.error
              : tone === "warning"
                ? t.warning
                : tone === "info"
                  ? t.info
                  : t.textMuted;
        const bg = selected ? t.bgPopupHighlight : t.bgPopup;
        const detail = progressText(run);
        const tokens = run.snapshot.tokenUsage
          ? ` · ${formatTokens(run.snapshot.tokenUsage)}/${formatTokens(run.budget.maxTokens)}${run.snapshot.estimatedCostUsd !== null ? ` · ${usd(run.snapshot.estimatedCostUsd)}` : ""}`
          : "";
        if (narrow)
          return (
            <box key={run.snapshot.runId} flexDirection="column" backgroundColor={bg}>
              <box flexDirection="row" backgroundColor={bg}>
                <text bg={bg} fg={selected ? t.brand : t.textFaint}>
                  {selected ? "▸ " : "  "}
                </text>
                <text bg={bg} fg={color}>
                  {`${statusGlyph(run.snapshot.status, run.pendingKind !== null)} `}
                </text>
                <text bg={bg} fg={selected ? t.textPrimary : t.textSecondary} attributes={1}>
                  {run.snapshot.featureId.slice(0, featureW).padEnd(featureW)}
                </text>
                <text bg={bg} fg={t.textFaint}>
                  {relativeTime(run.updatedAt).padStart(ageW)}
                </text>
              </box>
              <text bg={bg} fg={run.pendingKind ? t.warning : t.textMuted}>
                {`    ${run.snapshot.status} · ${detail}`.slice(0, Math.max(10, width - 2))}
              </text>
            </box>
          );
        return (
          <box key={run.snapshot.runId} flexDirection="row" backgroundColor={bg} id={`wf-run-${i}`}>
            <text bg={bg} fg={selected ? t.brand : t.textFaint}>
              {selected ? "▸ " : "  "}
            </text>
            <text bg={bg} fg={color}>
              {`${statusGlyph(run.snapshot.status, run.pendingKind !== null)} `}
            </text>
            <text
              bg={bg}
              fg={selected ? t.textPrimary : t.textSecondary}
              attributes={selected ? 1 : 0}
            >
              {run.snapshot.featureId.slice(0, featureW).padEnd(featureW)}
            </text>
            <text bg={bg} fg={color}>
              {` ${run.snapshot.status.padEnd(statusW)}`}
            </text>
            <text bg={bg} fg={run.pendingKind ? t.warning : t.textMuted}>
              {fitDetail(detail, tokens, detailW, run.pendingKind !== null)}
            </text>
            <text bg={bg} fg={t.textFaint}>
              {relativeTime(run.updatedAt).padStart(ageW)}
            </text>
          </box>
        );
      })}
    </box>
  );
}
