import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";
import { fieldClass } from "./input.js";

// Adapted from neobrutalism.dev (MIT).
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn("flex min-h-20 resize-none", fieldClass, className)}
      {...props}
    />
  );
}

export { Textarea };
