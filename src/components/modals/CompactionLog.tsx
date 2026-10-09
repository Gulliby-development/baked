import { useMemo } from "react";
import { getThemeTokens, useTheme } from "../../core/theme/index.js";
import { useCompactionLogStore } from "../../stores/compaction-logs.js";
import { timeAgo, truncLine } from "../../utils/time.js";
import { LogViewer, type LogViewerConfig, type LogViewerEntry } from "./LogViewer.js";

interface CompactionEntry extends LogViewerEntry {
  kind: string;
  message: string;
  model?: string;
  strategy?: string;
  slotsBefore?: number;
  contextBefore?: string;
  contextAfter?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  summarySnippet?: string;
  summaryLength?: number;
}

function getKindIcons(): Record<string, { icon: string; color: string }> {
  const tk = getThemeTokens();
  return {
    compact: { icon: "◆", color: tk.brand },
    "strategy-change": { icon: "⇄", color: tk.warning },
    "auto-trigger": { icon: "⚡", color: tk.success },
    error: { icon: "✗", color: tk.brandSecondary },
  };
}

const COMPACTION_CONFIG: LogViewerConfig<CompactionEntry> = {
  title: "Compaction Log",
  titleIcon: "◆",
  get titleColor() {
    return getThemeTokens().brandDim;
  },
  get borderColor() {
    return getThemeTokens().brandDim;
  },
  get accentColor() {
    return getThemeTokens().brandDim;
  },
  get cursorColor() {
    return getThemeTokens().brandDim;
  },
  heightRatio: 0.8,
  emptyMessage: "no compaction events yet",
  emptyFilterMessage: "no matching events",
  filterPlaceholder: "type to filter...",
  countLabel: (n) => `${String(n)} ${n === 1 ? "event" : "events"}`,
  get detailSectionColor() {
    return getThemeTokens().brandDim;
  },
  filterFn: (e, q) =>
    e.kind.includes(q) ||
    e.message.toLowerCase().includes(q) ||
    (e.model?.toLowerCase().includes(q) ?? false) ||
    (e.summarySnippet?.toLowerCase().includes(q) ?? false),
  renderListRow: (entry, innerW) => {
    const tk = getThemeTokens();
    const kindIcons = getKindIcons();
    const kindInfo = kindIcons[entry.kind] ?? { icon: "•", color: tk.textSecondary };
    const kindLabel = entry.kind.padEnd(16);
    const ts = timeAgo(entry.timestamp);
    const modelStr = entry.model ? ` [${entry.model}]` : "";
    const summaryMax = innerW - 16 - ts.length - modelStr.length - 10;
    return {
      icon: kindInfo.icon,
      iconColor: kindInfo.color,
      label: kindLabel,
      summary: truncLine(entry.message, summaryMax),
      extra: modelStr || undefined,
      extraColor: tk.brand,
      timeStr: ts,
    };
  },
  getDetailHeader: (entry) => {
    const tk = getThemeTokens();
    const kindIcons = getKindIcons();
    const kindInfo = kindIcons[entry.kind] ?? { icon: "•", color: tk.textSecondary };
    return {
      icon: kindInfo.icon,
      iconColor: kindInfo.color,
      label: entry.kind,
      sublabel: entry.model,
      sublabelColor: tk.brand,
      timeStr: timeAgo(entry.timestamp),
    };
  },
  getDetailLines: (entry) => {
    const lines: string[] = [];
    lines.push(`Kind: ${entry.kind}`);
    lines.push(`Time: ${new Date(entry.timestamp).toLocaleTimeString()}`);
    if (entry.model) lines.push(`Model: ${entry.model}`);
    if (entry.strategy) lines.push(`Strategy: ${entry.strategy}`);
    if (entry.contextBefore || entry.contextAfter)
      lines.push(`Context: ${entry.contextBefore ?? "?"} → ${entry.contextAfter ?? "?"}`);
    if (entry.messagesBefore !== undefined || entry.messagesAfter !== undefined)
      lines.push(
        `Messages: ${String(entry.messagesBefore ?? "?")} → ${String(entry.messagesAfter ?? "?")}`,
      );
    if (entry.slotsBefore !== undefined) lines.push(`V2 Slots: ${String(entry.slotsBefore)}`);
    if (entry.summaryLength !== undefined)
      lines.push(`Summary: ${String(entry.summaryLength)} chars`);
    if (entry.summarySnippet) {
      lines.push("");
      lines.push("── Summary ──");
      lines.push(...entry.summarySnippet.split("\n"));
    }
    return lines;
  },
  getCopyText: (entry) => entry.summarySnippet ?? entry.message,
};

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function CompactionLog({ visible, onClose }: Props) {
  useTheme();
  const storeEntries = useCompactionLogStore((s) => s.entries);
  const entries = useMemo(
    () =>
      [...storeEntries]
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((e) => ({ ...e }) as CompactionEntry),
    [storeEntries],
  );

  return (
    <LogViewer visible={visible} onClose={onClose} entries={entries} config={COMPACTION_CONFIG} />
  );
}
