import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

// Adapted from neobrutalism.dev (MIT). Pressing moves the block into its own shadow.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-base border-2 border-border text-sm font-heading transition-all cursor-pointer [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary-background disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-main text-main-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        neutral:
          "bg-background text-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        noShadow: "bg-main text-main-foreground",
        ghost:
          "border-transparent bg-transparent text-foreground hover:border-border hover:bg-background",
        danger:
          "bg-fill-err text-main-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        // The compact action buttons of the work screens: a small hard shadow and a 2px press.
        primary:
          "bg-main text-main-foreground shadow-sm-hard hover:translate-x-[2px] hover:translate-y-[2px] hover:text-main-foreground hover:shadow-none",
        secondary:
          "bg-raised text-foreground shadow-sm-hard hover:translate-x-[2px] hover:translate-y-[2px] hover:text-foreground hover:shadow-none",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-8",
        icon: "size-10",
        "icon-sm": "size-8",
        // Inherits the surrounding font and line height, so links styled as buttons match too.
        md: "h-auto min-h-[34px] gap-1.5 px-3 py-0 [font-family:inherit] text-[13px] leading-[inherit] font-bold no-underline",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = ComponentProps<typeof ButtonPrimitive> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
