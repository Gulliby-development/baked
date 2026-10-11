import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// A colour-block notice: information on the info fill, errors on the error fill.
const alertVariants = cva(
  "rounded-base border-2 border-border px-[14px] py-[10px] text-[13px] font-medium text-main-foreground shadow-sm-hard",
  {
    variants: {
      tone: {
        info: "bg-fill-info",
        error: "bg-fill-err",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

type AlertProps = ComponentProps<"div"> & VariantProps<typeof alertVariants>;

function Alert({ className, tone, ...props }: AlertProps) {
  return <div data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}

export { Alert, alertVariants };
