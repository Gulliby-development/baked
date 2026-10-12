import { memo, useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { reducedMotion, subscribeMotion } from "../../core/utils/motion.js";
import { SPINNER_FRAMES, SPINNER_TICK_MS } from "../../core/utils/spinner.js";
import { useCopySelection } from "../../hooks/useCopySelection.js";

export type ConfigScope = "project" | "global";
export const CONFIG_SCOPES: ConfigScope[] = ["project", "global"];

// Frames count up to a multiple of every frame-set length so `divisor` slowdowns stay even.
const FRAME_WRAP = 3600;

let globalFrame = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const frameListeners = new Set<(frame: number) => void>();

/** One shared timer for every spinner; it runs only while a spinner is mounted and motion is on. */
function syncTick(): void {
  const wanted = frameListeners.size > 0 && !reducedMotion();
  if (wanted && !tickTimer) {
    tickTimer = setInterval(() => {
      globalFrame = (globalFrame + 1) % FRAME_WRAP;
      for (const fn of frameListeners) fn(globalFrame);
    }, SPINNER_TICK_MS);
  } else if (!wanted && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

subscribeMotion(syncTick);

function subscribeFrames(listener: (frame: number) => void): () => void {
  frameListeners.add(listener);
  syncTick();
  return () => {
    frameListeners.delete(listener);
    syncTick();
  };
}

export function useSpinnerFrame(): number {
  const [frame, setFrame] = useState(globalFrame);
  useEffect(() => subscribeFrames(setFrame), []);
  return frame;
}

/** Returns a ref that tracks the current spinner frame WITHOUT causing re-renders.
 * Use with imperative `.content =` updates or pass to children that read `.current`. */
export function useSpinnerFrameRef(): React.RefObject<number> {
  const ref = useRef(globalFrame);
  useEffect(
    () =>
      subscribeFrames((f: number) => {
        ref.current = f;
      }),
    [],
  );
  return ref;
}

export const Spinner = memo(function Spinner({
  frames = SPINNER_FRAMES,
  color,
  divisor = 1,
  suffix,
  bold,
  inline,
}: {
  frames?: readonly string[];
  color?: string;
  /** Slow down frame rate — e.g. divisor=4 updates every 4th tick */
  divisor?: number;
  /** Static suffix appended after the animated frame (e.g. " " for spacing) */
  suffix?: string;
  bold?: boolean;
  /** Render as <span> for use inside <text> parents. Default: <text> for standalone use. */
  inline?: boolean;
} = {}) {
  const t = useTheme();
  // biome-ignore lint/suspicious/noExplicitAny: ref shared across text/span renderables with imperative updates
  const textRef = useRef<any>(null);
  const fg = color ?? t.brand;

  useEffect(() => {
    const isInline = !!inline;
    const listener = (f: number) => {
      try {
        if (textRef.current) {
          const idx = Math.floor(f / divisor) % frames.length;
          const val = (frames[idx] ?? "") + (suffix ?? "");
          if (isInline) {
            // TextNodeRenderable (<span>) uses children, not content
            textRef.current.children = [val];
          } else {
            textRef.current.content = val;
          }
        }
      } catch {}
    };
    return subscribeFrames(listener);
  }, [frames, divisor, suffix, inline]);

  const initIdx = Math.floor(globalFrame / divisor) % frames.length;
  const content = (frames[initIdx] ?? "") + (suffix ?? "");
  const attrs = bold ? 1 : undefined;

  if (inline) {
    return (
      <span ref={textRef} fg={fg} attributes={attrs}>
        {content}
      </span>
    );
  }
  return (
    <text ref={textRef} fg={fg} attributes={attrs}>
      {content}
    </text>
  );
});

const OVERLAY_STYLE = { opacity: 0.65 } as const;

export function Overlay({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const { onMouseDown, onMouseUp } = useCopySelection();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: opentui box is the interactive primitive in TUI; a11y rule targets DOM
    <box
      position="absolute"
      width="100%"
      height="100%"
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    >
      <box
        position="absolute"
        width="100%"
        height="100%"
        backgroundColor={t.bgOverlay}
        style={OVERLAY_STYLE}
      />
      <box
        position="absolute"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width="100%"
        height="100%"
      >
        {children}
      </box>
    </box>
  );
}
