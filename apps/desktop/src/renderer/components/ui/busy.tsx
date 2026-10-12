import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { BunScene } from "./bun.js";
import { Progress } from "./progress.js";

const count = (n: number) => n.toLocaleString("en-US");

/**
 * A real wait: starting a backend, indexing, starting a run. The bun works while `label` says
 * what on; with `done` and `total` a bar and the count ("412 / 1,380 files") show how far it got.
 * Short reads from the database use `Skeleton` instead, so the bun only appears when it means it.
 */
function Busy({
  label,
  detail,
  done,
  total,
  unit,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  label: string;
  /** A second line under the label. */
  detail?: string;
  done?: number | null;
  total?: number | null;
  /** What `done` and `total` count, e.g. "files". */
  unit?: string;
}) {
  const counted = typeof done === "number" && typeof total === "number" && total > 0;
  return (
    <div
      data-slot="busy"
      role="status"
      aria-live="polite"
      className={cn("flex flex-col items-center gap-3 px-4 py-8 text-center", className)}
      {...props}
    >
      <BunScene progress={counted ? done / total : null} />
      <div className="flex flex-col gap-1">
        <strong className="text-foreground">{label}</strong>
        {detail && <span className="text-[13px] text-muted-foreground">{detail}</span>}
      </div>
      {counted && (
        <div className="flex w-full max-w-[320px] flex-col gap-1.5">
          <Progress value={Math.min(done, total)} max={total} aria-label={label} />
          <span className="font-mono text-[12px] text-soft-foreground tabular-nums">
            {count(Math.min(done, total))} / {count(total)}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export { Busy };
