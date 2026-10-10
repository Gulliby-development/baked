import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// Adapted from neobrutalism.dev (MIT).
function Progress({
  className,
  indicatorClassName,
  children,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("flex w-full flex-wrap gap-2", className)}
      {...props}
    >
      {children}
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className="relative h-4 w-full overflow-hidden rounded-full border-2 border-border bg-secondary-background"
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full border-r-2 border-border bg-main transition-all",
            indicatorClassName,
          )}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
