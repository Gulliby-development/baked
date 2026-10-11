import { TextAttributes } from "@opentui/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import type { ChatMessage } from "../../types/index.js";

const DISMISS_DELAY = 5000;
const ERROR_DISMISS_DELAY = 8000;
const EXPANDED_DISMISS_DELAY = 12000;
const SLIDE_INTERVAL = 50;
const FADE_DURATION = 600;
const FADE_STEPS = 8;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const v = Number.parseInt(n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return rgbToHex(
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  );
}

function isError(text: string): boolean {
  return (
    text.startsWith("Error:") || text.startsWith("Request failed:") || text.startsWith("Failed")
  );
}

interface Props {
  messages: ChatMessage[];
  expanded?: boolean;
}

type Phase = "enter" | "visible" | "exit" | "hidden";

export function SystemBanner({ messages, expanded = false }: Props) {
  const { width } = useTerminalDimensions();
  const termWidth = width ?? 80;
  const [current, setCurrent] = useState<ChatMessage | null>(null);
  const [phase, setPhase] = useState<Phase>("hidden");
  const [revealCount, setRevealCount] = useState(0);
  const [fadeStep, setFadeStep] = useState(0);
  const lastSeenTs = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const systemMsgs = messages.filter((m) => m.role === "system" && !m.showInChat);
    if (systemMsgs.length === 0) return;
    const latest = systemMsgs[systemMsgs.length - 1] as ChatMessage | undefined;
    if (!latest || latest.timestamp <= lastSeenTs.current) return;

    lastSeenTs.current = latest.timestamp;

    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }

    setCurrent(latest);
    setRevealCount(0);
    setFadeStep(0);
    setPhase("enter");
  }, [messages]);

  useEffect(() => {
    if (phase !== "enter" || !current) return;
    const text = current.content;
    const displayLen = (text.split("\n")[0] ?? "").length;
    if (revealCount >= displayLen) {
      setPhase("visible");
      return;
    }
    const chunkSize = Math.max(1, Math.ceil(displayLen / 12));
    const timer = setTimeout(() => {
      setRevealCount((c) => Math.min(c + chunkSize, displayLen));
    }, SLIDE_INTERVAL);
    return () => clearTimeout(timer);
  }, [phase, revealCount, current]);

  useEffect(() => {
    if (phase !== "visible" || !current) return;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    const baseDelay = isError(current.content) ? ERROR_DISMISS_DELAY : DISMISS_DELAY;
    const delay = expanded ? EXPANDED_DISMISS_DELAY : baseDelay;
    dismissTimer.current = setTimeout(() => {
      setPhase("exit");
      setFadeStep(0);
    }, delay);
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [phase, current, expanded]);

  useEffect(() => {
    if (phase !== "exit") return;
    if (fadeStep >= FADE_STEPS) {
      setPhase("hidden");
      setCurrent(null);
      return;
    }
    const timer = setTimeout(() => {
      setFadeStep((s) => s + 1);
    }, FADE_DURATION / FADE_STEPS);
    return () => clearTimeout(timer);
  }, [phase, fadeStep]);

  const err = current ? isError(current.content) : false;
  const allLines = current ? current.content.split("\n") : [""];
  const firstLine = allLines[0] ?? "";
  const extraLines = allLines.slice(1);
  const multiLine = extraLines.length > 0;

  const tk = useTheme();
  const bgColor = err ? tk.bgBannerError : tk.bgBanner;
  const accentColor = err ? tk.error : tk.brand;
  const textColor = err ? tk.error : tk.brandAlt;
  const iconColor = err ? tk.error : tk.brand;
  const dimColor = tk.textFaint;

  const fadeFactor = phase === "exit" ? fadeStep / FADE_STEPS : 0;

  const { fAccent, fText, fIcon, fDim, fBg } = useMemo(() => {
    const fadeTarget = tk.bgSecondary;
    return {
      fAccent: lerpColor(accentColor, fadeTarget, fadeFactor),
      fText: lerpColor(textColor, fadeTarget, fadeFactor),
      fIcon: lerpColor(iconColor, fadeTarget, fadeFactor),
      fDim: lerpColor(dimColor, fadeTarget, fadeFactor),
      fBg: lerpColor(bgColor, tk.bgPrimary, fadeFactor),
    };
  }, [
    fadeFactor,
    bgColor,
    accentColor,
    textColor,
    iconColor,
    dimColor,
    tk.bgPrimary,
    tk.bgSecondary,
  ]);

  const bannerIcon = err ? "✗" : "⚡";

  const time = useMemo(
    () =>
      current
        ? new Date(current.timestamp).toLocaleTimeString("en-US", {
            hour12: true,
            hour: "numeric",
            minute: "2-digit",
          })
        : "",
    [current?.timestamp, current],
  );

  if (phase === "hidden" || !current) return null;

  const displayText = phase === "enter" ? firstLine.slice(0, revealCount) : firstLine;
  const showCursor = phase === "enter";

  const showExpanded = expanded && multiLine && phase !== "enter";
  const bannerHeight = showExpanded ? 1 + extraLines.length : 1;

  return (
    <box flexShrink={0} flexDirection="column" height={bannerHeight}>
      <box height={1} width={termWidth}>
        <box position="absolute">
          <text bg={fBg}>{" ".repeat(termWidth)}</text>
        </box>
        <box position="absolute">
          <text bg={fBg}>
            <span fg={fIcon}> {bannerIcon}</span>
            <span fg={fAccent} attributes={TextAttributes.BOLD}>
              {err ? "Error" : "System"}
            </span>
            <span fg={fDim}> │ </span>
            <span fg={fText}>{displayText}</span>
            {showCursor && <span fg={fAccent}>█</span>}
            {multiLine && phase !== "enter" && !showExpanded && (
              <>
                <span fg={fDim}> (+{String(extraLines.length)} lines</span>
                <span fg={tk.textMuted}> ^O</span>
                <span fg={fDim}>)</span>
              </>
            )}
            <span fg={fDim}> · {time} </span>
          </text>
        </box>
      </box>
      {showExpanded &&
        extraLines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
          <box key={i} height={1} width={termWidth}>
            <box position="absolute">
              <text bg={fBg}>{" ".repeat(termWidth)}</text>
            </box>
            <box position="absolute">
              <text bg={fBg}>
                <span fg={fDim}>{"    "} │ </span>
                <span fg={fText}>{line}</span>
              </text>
            </box>
          </box>
        ))}
    </box>
  );
}
