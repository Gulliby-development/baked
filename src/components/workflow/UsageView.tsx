import { useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { UsageDimension, UsageSummary } from "../../core/workflows/usage.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { PremiumPopup } from "../ui/index.js";
import { Table, type TableColumn } from "../ui/Table.js";
import { formatTokens } from "./format.js";

/** The periods the screen offers, in days; ←→ steps through them. */
export const USAGE_PERIODS = [7, 30, 90] as const;
/** The grouping Tab cycles through. */
export const USAGE_GROUPS: UsageDimension[] = ["model", "stage", "day"];

/** Reads the usage of every run over the last `days` days, grouped by one dimension. */
export type UsageLoader = (days: number, groupBy: UsageDimension) => UsageSummary;

export function usd(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

/** One line of totals: runs, attempts, tokens and cost, and the tokens no price covers. */
export function usageTotalsLine(summary: UsageSummary): string {
  const parts = [
    `${summary.runs} run${summary.runs === 1 ? "" : "s"}`,
    `${summary.attempts} attempt${summary.attempts === 1 ? "" : "s"}`,
    `${formatTokens(summary.tokens)} tokens`,
    `${usd(summary.costUsd)}`,
  ];
  if (summary.unpricedTokens > 0) parts.push(`${formatTokens(summary.unpricedTokens)} unpriced`);
  return parts.join(" · ");
}

type Group = UsageSummary["groups"][number];

const GROUP_TITLE: Record<UsageDimension, string> = { model: "MODEL", stage: "STAGE", day: "DAY" };

/** Writes a summary as Markdown into the project; returns where, or throws. */
export type UsageExporter = (summary: UsageSummary) => string;

export function UsagePopup({
  load,
  width,
  height,
  onBack,
  onExport,
}: {
  load: UsageLoader;
  width: number;
  height: number;
  onBack: () => void;
  onExport?: UsageExporter;
}) {
  const t = useTheme();
  const [period, setPeriod] = useState(0);
  const [group, setGroup] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  const days = USAGE_PERIODS[period] ?? 7;
  const groupBy = USAGE_GROUPS[group] ?? "model";
  const result = useMemo((): { summary: UsageSummary } | { error: string } => {
    try {
      return { summary: load(days, groupBy) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [load, days, groupBy]);
  const groups = "summary" in result ? result.summary.groups : [];

  useKeyboard((event) => {
    const key = event.name.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      onBack();
    } else if (key === "left" || key === "right") {
      event.preventDefault();
      const step = key === "left" ? USAGE_PERIODS.length - 1 : 1;
      setPeriod((p) => (p + step) % USAGE_PERIODS.length);
      setCursor(0);
    } else if (key === "tab") {
      event.preventDefault();
      const step = event.shift ? USAGE_GROUPS.length - 1 : 1;
      setGroup((g) => (g + step) % USAGE_GROUPS.length);
      setCursor(0);
    } else if (key === "e" && onExport && "summary" in result) {
      event.preventDefault();
      try {
        setExported({ ok: true, text: `Markdown written to ${onExport(result.summary)}` });
      } catch (err) {
        setExported({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
    } else if (key === "up" || key === "down") {
      event.preventDefault();
      setCursor((c) => Math.max(0, Math.min(groups.length - 1, c + (key === "up" ? -1 : 1))));
    }
  });

  const innerW = width - 6;
  const columns: TableColumn<Group>[] = [
    { key: GROUP_TITLE[groupBy], render: (g) => g.key },
    { key: "RUNS", width: 5, align: "right", render: (g) => String(g.runs) },
    { key: "TOKENS", width: 8, align: "right", render: (g) => formatTokens(g.tokens) },
    { key: "COST", width: 8, align: "right", render: (g) => usd(g.costUsd) },
  ];
  return (
    <PremiumPopup
      visible
      title="Workflow"
      blurb={`Usage across runs: last ${days} days, by ${groupBy}`}
      width={width}
      height={height}
      footerHints={[
        { key: "←→", label: "period" },
        { key: "Tab", label: "group" },
        { key: "↑↓", label: "select" },
        ...(onExport ? [{ key: "E", label: "export .md" }] : []),
        { key: "Esc", label: "back" },
      ]}
    >
      <box flexDirection="column" paddingX={1}>
        {"error" in result ? (
          <text fg={t.error}>{`✗ ${result.error}`}</text>
        ) : (
          <>
            <text fg={t.textPrimary}>{usageTotalsLine(result.summary)}</text>
            <Table
              columns={columns}
              rows={groups}
              width={innerW}
              selectedIndex={Math.min(cursor, groups.length - 1)}
              emptyMessage={`No workflow attempts in the last ${days} days.`}
              maxRows={Math.max(3, height - 10)}
            />
            {result.summary.unpricedTokens > 0 ? (
              <text fg={t.textMuted}>
                Unpriced tokens come from attempts without a known model price; the cost leaves them
                out.
              </text>
            ) : null}
            {exported ? <text fg={exported.ok ? t.success : t.error}>{exported.text}</text> : null}
          </>
        )}
      </box>
    </PremiumPopup>
  );
}
