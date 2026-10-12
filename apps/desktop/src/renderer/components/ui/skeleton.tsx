import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

const WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-2/3", "w-3/4"];

/** Placeholder bars for a short read; the bun (`Busy`) is kept for real waits. */
function Skeleton({
  lines = 3,
  label = "Loading",
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { lines?: number; label?: string }) {
  return (
    <div
      data-slot="skeleton"
      role="status"
      aria-label={label}
      className={cn("flex flex-col gap-2 py-1", className)}
      {...props}
    >
      {Array.from({ length: lines }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows.
          key={i}
          className={cn(
            "block h-3.5 animate-pulse rounded-base bg-hover motion-reduce:animate-none",
            WIDTHS[i % WIDTHS.length],
          )}
        />
      ))}
    </div>
  );
}

export { Skeleton };
