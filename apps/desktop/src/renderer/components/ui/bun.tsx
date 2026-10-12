import { useEffect, useState } from "react";
import {
  type ArtPalette,
  artPalette,
  BAKE_ART_TICK_MS,
  BUN_HEIGHT,
  BUN_WIDTH,
  type BunPose,
  bootPose,
  bunPixels,
  clamp01,
  idlePose,
  type PixelGrid,
} from "../../../../../../src/core/utils/bake-art.js";
import { cn } from "../../lib/cn.js";

// The mascot is the terminal's pixel bun (src/core/utils/bake-art.ts) drawn as SVG squares; the
// colours that follow the theme are CSS variables, the crust ramp is the terminal's.
const PALETTE: ArtPalette = {
  ...artPalette({ brand: "#ff9d52", brandDim: "#000000", textMuted: "#000000", bgApp: "#191410" }),
  fill: "var(--fill-accent)",
  onFill: "var(--on-fill)",
  shadow: "var(--ink)",
  steam: "var(--text-4)",
};

const KNEAD_MS = 1400;

/** Kneading: the dough squashes and springs back, the bun keeps an eye on it. */
export function kneadPose(elapsedMs: number): BunPose {
  const squash = (1 - Math.cos(((elapsedMs % KNEAD_MS) / KNEAD_MS) * Math.PI * 2)) / 2;
  return {
    bake: 0.5,
    rise: 1 - squash * 0.55,
    face: elapsedMs % 4200 >= 4000 ? "blink" : squash > 0.7 ? "happy" : "focus",
    steam: null,
  };
}

/** Proofing in the oven: the dough rises and browns with the work done, steaming near the end. */
export function proofPose(progress: number, elapsedMs: number): BunPose {
  const p = clamp01(progress);
  return {
    ...bootPose(Math.max(0.15, p), elapsedMs),
    face: elapsedMs % 3600 >= 3400 ? "blink" : p >= 1 ? "happy" : "focus",
  };
}

/** One rect per run of equal pixels in a row, so a frame is a few dozen elements. */
function runs(grid: PixelGrid): { x: number; y: number; w: number; color: string }[] {
  const out: { x: number; y: number; w: number; color: string }[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const color = row[x];
      let w = 1;
      while (x + w < row.length && row[x + w] === color) w++;
      if (color) out.push({ x, y, w, color });
      x += w;
    }
  });
  return out;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The bun at work. With `progress` it proofs: the dough rises and browns as the work advances;
 * without, it kneads. Reduced motion shows the awake bun standing still.
 */
function BunScene({
  progress,
  className,
}: {
  /** 0 to 1 when the work can be counted. */
  progress?: number | null;
  className?: string;
}) {
  const [still] = useState(prefersReducedMotion);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (still) return;
    const start = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - start), BAKE_ART_TICK_MS);
    return () => clearInterval(timer);
  }, [still]);
  const pose = still
    ? { ...idlePose(0), steam: null }
    : progress === null || progress === undefined
      ? kneadPose(elapsed)
      : proofPose(progress, elapsed);
  const cells = runs(bunPixels(pose, PALETTE));
  return (
    <svg
      data-slot="bun"
      viewBox={`0 0 ${BUN_WIDTH} ${BUN_HEIGHT * 2}`}
      className={cn("h-auto w-[132px]", className)}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={cell.w}
          height={1}
          style={{ fill: cell.color }}
        />
      ))}
    </svg>
  );
}

export { BunScene };
