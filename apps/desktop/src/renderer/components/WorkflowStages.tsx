import { cn } from "../lib/cn.js";

/** How a stage of a launched run looks: done, the one working now, waiting, failed or ahead. */
export type StageLook = "done" | "current" | "waiting" | "failed" | "skipped" | "ahead";

const CHIP =
  "inline-flex h-6 items-center rounded-base border-2 border-border px-2 font-mono text-[11px] font-bold whitespace-nowrap";

const LOOK: Record<StageLook, string> = {
  done: "bg-fill-ok text-main-foreground",
  current:
    "animate-forming bg-[repeating-linear-gradient(90deg,var(--fill-info)_0_8px,var(--bg-raised)_8px_16px)] bg-[length:16px_100%] text-foreground shadow-sm-hard motion-reduce:animate-none",
  waiting:
    "animate-nudge bg-fill-warn text-main-foreground shadow-sm-hard motion-reduce:animate-none",
  failed: "bg-fill-err text-main-foreground",
  skipped: "border-dashed bg-raised text-dim-foreground line-through",
  ahead: "bg-background text-dim-foreground",
};

/**
 * A workflow's stages as a row of chips joined by arrows. Without looks every chip is plain, as on
 * the "Run workflow?" card; with them each chip shows where a launched run is.
 */
export function StageChips({
  stages,
  looks,
  onCard = false,
  className,
}: {
  stages: readonly string[];
  looks?: readonly StageLook[];
  /** Drawn on a coloured prompt card. */
  onCard?: boolean;
  className?: string;
}) {
  return (
    <ol
      className={cn("m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-1.5 p-0", className)}
      aria-label="Stages"
    >
      {stages.map((stage, i) => {
        const look = looks?.[i];
        return (
          <li key={stage} className="flex items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cn("text-[11px]", onCard ? "opacity-60" : "text-dim-foreground")}
              >
                →
              </span>
            )}
            <span
              className={cn(
                CHIP,
                "transition-colors duration-300 motion-reduce:transition-none",
                look ? LOOK[look] : onCard ? "bg-raised text-foreground" : LOOK.ahead,
              )}
              title={look ? `${stage}: ${look}` : stage}
            >
              {stage}
              {look && <span className="sr-only"> ({look})</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
