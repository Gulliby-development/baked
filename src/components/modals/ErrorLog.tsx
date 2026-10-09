import { useMemo } from "react";
import { getThemeTokens, useTheme } from "../../core/theme/index.js";
import { useErrorStore } from "../../stores/errors.js";
import type { ChatMessage } from "../../types/index.js";
import { timeAgo, truncLine } from "../../utils/time.js";
import { LogViewer, type LogViewerConfig, type LogViewerEntry } from "./LogViewer.js";

type LogEntryKind = "tool-ok" | "tool-error" | "request-error";

interface ErrorEntry extends LogViewerEntry {
  kind: LogEntryKind;
  name: string;
  summary: string;
  detail: string;
  args?: string;
}

function isErrorSystemMsg(content: string): boolean {
  return (
    content.startsWith("Error:") ||
    content.startsWith("Request failed:") ||
    content.startsWith("Failed")
  );
}

function stripErrorPrefix(content: string): string {
  if (content.startsWith("Error: ")) return content.slice(7);
  if (content.startsWith("Request failed: ")) return content.slice(16);
  return content;
}

function extractLogEntries(messages: ChatMessage[]): ErrorEntry[] {
  const entries: ErrorEntry[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const success = tc.result?.success ?? false;
        const output = success
          ? (tc.result?.output ?? "")
          : (tc.result?.error ?? tc.result?.output ?? "");
        entries.push({
          id: tc.id,
          kind: success ? "tool-ok" : "tool-error",
          name: tc.name,
          timestamp: msg.timestamp,
          summary: truncLine(output, 80),
          detail: output,
          args: JSON.stringify(tc.args, null, 2),
        });
      }
    }
    if (msg.role === "system" && isErrorSystemMsg(msg.content)) {
      entries.push({
        id: `req-${String(msg.timestamp)}`,
        kind: "request-error",
        name: "Request Error",
        timestamp: msg.timestamp,
        summary: truncLine(stripErrorPrefix(msg.content), 80),
        detail: msg.content,
      });
    }
  }
  return entries.reverse();
}

function getErrorConfig(): LogViewerConfig<ErrorEntry> {
  const tk = getThemeTokens();
  return {
    title: "Error Log",
    titleIcon: "\uF06A",
    titleColor: tk.brandSecondary,
    borderColor: tk.brandAlt,
    accentColor: tk.brandSecondary,
    cursorColor: tk.brandSecondary,
    heightRatio: 0.6,
    emptyMessage: "no errors yet",
    emptyFilterMessage: "no matching errors",
    filterPlaceholder: "type to filter errors...",
    countLabel: (n) => `${String(n)} ${n === 1 ? "error" : "errors"}`,
    detailSectionColor: tk.brandAlt,
    filterFn: (e, q) =>
      e.name.toLowerCase().includes(q) ||
      e.summary.toLowerCase().includes(q) ||
      e.detail.toLowerCase().includes(q),
    renderListRow: (entry, innerW) => {
      const statusColor = entry.kind === "request-error" ? tk.brandSecondary : tk.warning;
      const nameMax = 20;
      const ts = timeAgo(entry.timestamp);
      const summaryMax = innerW - nameMax - ts.length - 10;
      const name =
        entry.name.length > nameMax
          ? `${entry.name.slice(0, nameMax - 1)}…`
          : entry.name.padEnd(nameMax);
      return {
        icon: "✗",
        iconColor: statusColor,
        label: name,
        summary: truncLine(entry.summary, summaryMax),
        timeStr: ts,
      };
    },
    getDetailHeader: (entry) => ({
      icon: entry.kind === "tool-ok" ? "✓" : "✗",
      iconColor: entry.kind === "tool-ok" ? tk.success : tk.brandSecondary,
      label: entry.name,
      timeStr: timeAgo(entry.timestamp),
    }),
    getDetailLines: (entry) => {
      const lines: string[] = [];
      if (entry.args) {
        lines.push("── Args ──");
        lines.push(...entry.args.split("\n"));
        lines.push("");
      }
      lines.push(entry.kind === "tool-ok" ? "── Output ──" : "── Error ──");
      lines.push(...entry.detail.split("\n"));
      return lines;
    },
    getCopyText: (entry) => (entry.args ? `Args:\n${entry.args}\n\n${entry.detail}` : entry.detail),
  };
}

interface Props {
  visible: boolean;
  messages: ChatMessage[];
  onClose: () => void;
}

export function ErrorLog({ visible, messages, onClose }: Props) {
  useTheme();
  const bgErrors = useErrorStore((s) => s.errors);
  const entries = useMemo(() => {
    const chatEntries = extractLogEntries(messages);
    const bgEntries: ErrorEntry[] = bgErrors.map((e) => ({
      id: e.id,
      kind: "request-error" as const,
      name: e.source,
      timestamp: e.timestamp,
      summary: truncLine(e.message, 80),
      detail: e.message,
    }));
    const all = [...chatEntries, ...bgEntries].sort((a, b) => b.timestamp - a.timestamp);
    return all.filter((e) => e.kind !== "tool-ok");
  }, [messages, bgErrors]);

  return (
    <LogViewer visible={visible} onClose={onClose} entries={entries} config={getErrorConfig()} />
  );
}
