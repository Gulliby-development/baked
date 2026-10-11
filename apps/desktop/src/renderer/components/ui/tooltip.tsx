import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

const POPUP =
  "z-50 max-w-[320px] rounded-base border-2 border-border bg-background px-3 py-2 text-left text-[12px] leading-[1.45] font-normal normal-case tracking-normal text-foreground shadow-sm-hard transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none";

/** Shows `content` next to `children` on hover and keyboard focus. */
function Tooltip({
  content,
  children,
  className,
}: {
  content: ReactNode;
  /** The trigger; rendered as the trigger element itself, so it must take a ref and props. */
  children: ReactElement;
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={150} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup className={cn(POPUP, className)}>
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** A small "?" after a term that explains it on hover or focus. */
function Hint({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={`About ${label}`}
        className="mx-1 inline-flex size-[18px] shrink-0 cursor-help items-center justify-center rounded-full border-2 border-border bg-background p-0 align-[-3px] font-mono text-[10px] leading-none font-bold text-muted-foreground hover:bg-main hover:text-main-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        ?
      </button>
    </Tooltip>
  );
}

export { Hint, Tooltip };
