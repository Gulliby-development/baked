import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { getThemeTokens } from "../../core/theme/index.js";

function buildScanLine(pos: number, w: number): StyledText {
  const tk = getThemeTokens();
  const segments: ReturnType<ReturnType<typeof fgStyle>>[] = [];
  for (let i = 0; i < w; i++) {
    const dist = Math.abs(i - pos);
    const color =
      dist === 0
        ? tk.brandAlt
        : dist === 1
          ? tk.brand
          : dist === 2
            ? tk.brandDim
            : tk.bgPopupHighlight;
    segments.push(fgStyle(color)(dist === 0 ? "━" : "─"));
  }
  return new StyledText(segments);
}

/** Animated divider — a bright cursor sweeps across a dim line.
 *  Uses a single <text> with imperative StyledText updates (zero React re-renders). */
export function ScanDivider({ width: w, speed = 120 }: { width: number; speed?: number }) {
  const ref = useRef<TextRenderable>(null);
  const posRef = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      posRef.current = (posRef.current + 1) % (w + 6);
      try {
        if (ref.current) ref.current.content = buildScanLine(posRef.current, w);
      } catch {}
    }, speed);
    return () => clearInterval(timer);
  }, [w, speed]);

  return <text ref={ref} content={buildScanLine(posRef.current, w)} />;
}
