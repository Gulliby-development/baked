import { Icon } from "../../components/Icon.js";
import { cn } from "../../lib/cn.js";
import { stageIconOf } from "./line-model.js";
import { type PipelineStage, type PipelineState, stageLabel } from "./model.js";

/**
 * A run's stages as a small line of stations, the same picture as the workflow gallery's cards:
 * done stations green, the working one in the accent with a pulse, one that needs you nudging,
 * a failed one red, and the rail filled up to where the run is.
 */

const SIZE = 20;
const STEP = 25;

const FILL: Record<PipelineState, string> = {
  done: "bg-fill-ok text-main-foreground",
  current: "bg-main text-main-foreground",
  waiting: "bg-fill-warn text-main-foreground animate-nudge motion-reduce:animate-none",
  failed: "bg-fill-err text-main-foreground",
  skipped: "border-dashed bg-raised text-dim-foreground",
  pending: "bg-background text-dim-foreground",
};

const STATE_WORD: Record<PipelineState, string> = {
  done: "done",
  current: "working",
  waiting: "needs you",
  failed: "failed",
  skipped: "skipped",
  pending: "not started",
};

/** How far the rail is filled: up to the last station that has started. */
export function reached(stages: readonly Pick<PipelineStage, "state">[]): number {
  let last = -1;
  stages.forEach((s, i) => {
    if (s.state !== "pending") last = i;
  });
  return last;
}

export function RunLine({ stages }: { stages: readonly PipelineStage[] }) {
  if (stages.length === 0) return null;
  const width = (stages.length - 1) * STEP + SIZE;
  const fill = Math.max(0, reached(stages)) * STEP;
  return (
    <span
      className="relative inline-block h-[28px] align-middle"
      style={{ width }}
      role="img"
      aria-label={`Stages: ${stages.map((s) => `${s.label} ${STATE_WORD[s.state]}`).join(", ")}`}
    >
      <span
        className="absolute h-[2px] bg-[var(--line-strong)]"
        style={{ left: SIZE / 2, top: SIZE / 2 - 1, width: width - SIZE }}
        aria-hidden="true"
      />
      <span
        className="absolute h-[2px] bg-border transition-[width] duration-500 motion-reduce:transition-none"
        style={{ left: SIZE / 2, top: SIZE / 2 - 1, width: fill }}
        aria-hidden="true"
      />
      {stages.map((s, i) => (
        <span
          key={s.id}
          title={`${stageLabel(s.id)}: ${STATE_WORD[s.state]}`}
          className={cn(
            "absolute top-0 flex items-center justify-center rounded-[4px] border-2 border-border",
            FILL[s.state],
          )}
          style={{ left: i * STEP, width: SIZE, height: SIZE }}
          aria-hidden="true"
        >
          <Icon name={stageIconOf(s.id)} size={11} />
          {s.state === "current" && (
            <span className="absolute -bottom-[7px] size-[5px] animate-pulse-dot rounded-full bg-[var(--accent)] motion-reduce:animate-none" />
          )}
        </span>
      ))}
    </span>
  );
}
