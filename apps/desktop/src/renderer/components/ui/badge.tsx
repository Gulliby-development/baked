import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// Adapted from neobrutalism.dev (MIT); tones are BAKED's status colours as colour blocks.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border-2 border-border px-2 py-0.5 font-mono text-[11px] font-heading uppercase tracking-wider text-main-foreground [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-background text-foreground",
        accent: "bg-main",
        ok: "bg-fill-ok",
        warn: "bg-fill-warn",
        err: "bg-fill-err",
        info: "bg-fill-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, tone, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
