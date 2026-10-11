import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

// Adapted from neobrutalism.dev (MIT): an outlined block with the full hard shadow over a dimmed
// window. Escape, the backdrop and the close button dismiss it.

function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-base border-2 border-border bg-background p-5 text-foreground shadow-shadow outline-hidden",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <DialogPrimitive.Title className="m-0 text-[18px] font-bold">{title}</DialogPrimitive.Title>
        {children && (
          <DialogPrimitive.Description className="m-0 text-[13px] text-muted-foreground">
            {children}
          </DialogPrimitive.Description>
        )}
      </div>
      <DialogPrimitive.Close
        aria-label="Close"
        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-base border-2 border-transparent bg-transparent text-[18px] leading-none text-soft-foreground hover:border-border hover:bg-hover hover:text-foreground"
      >
        ×
      </DialogPrimitive.Close>
    </div>
  );
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />;
}

export { Dialog, DialogContent, DialogFooter, DialogHeader };
