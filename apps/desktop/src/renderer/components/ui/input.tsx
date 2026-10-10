import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// Adapted from neobrutalism.dev (MIT).
export const fieldClass =
  "w-full rounded-base border-2 border-border bg-secondary-background px-3 py-2 text-sm font-base text-foreground selection:bg-main selection:text-main-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary-background disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-fill-err";

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn("flex h-10", fieldClass, className)}
      {...props}
    />
  );
}

export { Input };
