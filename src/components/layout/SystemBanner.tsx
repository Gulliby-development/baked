import { TextAttributes } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { artPalette, inkOn } from "../../core/utils/bake-art.js";
import { useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import type { ChatMessage } from "../../types/index.js";

const DISMISS_DELAY = 5000;
const ERROR_DISMISS_DELAY = 8000;
const EXPANDED_DISMISS_DELAY = 12000;

export function isBannerError(text: string): boolean {
  return (
    text.startsWith("Error:") || text.startsWith("Request failed:") || text.startsWith("Failed")
  );
}

interface Props {
  messages: ChatMessage[];
  expanded?: boolean;
}

/**
 * The latest system notice as a solid colour block: brand fill for notices, error fill for
 * failures. It appears at once and disappears after a delay; nothing animates in between.
 */
export function SystemBanner({ messages, expanded = false }: Props) {
  const { width } = useTerminalDimensions();
  const termWidth = width ?? 80;
  const [current, setCurrent] = useState<ChatMessage | null>(null);
  const lastSeenTs = useRef(0);
  const tk = useTheme();

  useEffect(() => {
    const systemMsgs = messages.filter((m) => m.role === "system" && !m.showInChat);
    const latest = systemMsgs[systemMsgs.length - 1];
    if (!latest || latest.timestamp <= lastSeenTs.current) return;
    lastSeenTs.current = latest.timestamp;
    setCurrent(latest);
  }, [messages]);

  useEffect(() => {
    if (!current) return;
    const delay = expanded
      ? EXPANDED_DISMISS_DELAY
      : isBannerError(current.content)
        ? ERROR_DISMISS_DELAY
        : DISMISS_DELAY;
    const timer = setTimeout(() => setCurrent(null), delay);
    return () => clearTimeout(timer);
  }, [current, expanded]);

  if (!current) return null;

  const err = isBannerError(current.content);
  const [firstLine = "", ...extraLines] = current.content.split("\n");
  const multiLine = extraLines.length > 0;
  const showExpanded = expanded && multiLine;
  const fill = err ? tk.error : artPalette(tk).fill;
  const ink = inkOn(fill);
  const time = new Date(current.timestamp).toLocaleTimeString("en-US", {
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
  });
  const label = err ? " ERROR " : " SYSTEM ";
  // Pads to the row width so the fill reaches the right edge; overflow is clipped by the box.
  const pad = (text: string, cells: number) =>
    text + " ".repeat(Math.max(0, cells - Bun.stringWidth(text)));
  const more = multiLine && !showExpanded ? ` (+${String(extraLines.length)} lines ^O)` : "";

  return (
    <box flexShrink={0} flexDirection="column" height={showExpanded ? 1 + extraLines.length : 1}>
      <box height={1} width={termWidth} overflow="hidden">
        <text bg={fill} fg={ink} wrapMode="none">
          <span fg={ink} bg={fill} attributes={TextAttributes.BOLD}>
            {label}
          </span>
          <span fg={ink} bg={fill}>
            {pad(`│ ${firstLine}${more} · ${time} `, termWidth - label.length)}
          </span>
        </text>
      </box>
      {showExpanded &&
        extraLines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
          <box key={i} height={1} width={termWidth} overflow="hidden">
            <text bg={fill} fg={ink} wrapMode="none">
              {pad(`${" ".repeat(label.length)}│ ${line}`, termWidth)}
            </text>
          </box>
        ))}
    </box>
  );
}
