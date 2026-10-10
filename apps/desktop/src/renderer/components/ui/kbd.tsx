import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// Adapted from neobrutalism.dev (MIT).
function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 w-fit select-none items-center justify-center gap-1 rounded-[4px] border-2 border-border bg-background px-1 font-mono text-[11px] font-heading text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
