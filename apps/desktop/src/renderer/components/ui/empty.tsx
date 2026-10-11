import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// The dashed placeholder shown where a list or panel has nothing yet.
const emptyClass =
  "rounded-base border-2 border-dashed border-border p-7 text-center text-muted-foreground";

function Empty({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty" className={cn(emptyClass, className)} {...props} />;
}

export { Empty, emptyClass };
