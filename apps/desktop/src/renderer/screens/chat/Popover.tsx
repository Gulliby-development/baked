import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

/**
 * The chat chip: chat.css's `.chip` with the padding, size and colour the run screens' chip rule
 * gave it. The `!` keeps them above chat.css until that sheet moves to utilities too.
 */
export const CHIP =
  "chip py-[6px]! text-[13px]! text-dim-foreground! hover:text-foreground! aria-expanded:text-foreground!";

/**
 * A button with a small panel under it. Closes on Escape (which it marks as handled, so the chat's
 * Escape-to-interrupt ignores it), on a click outside and when `close` is called.
 */
export function Popover({
  label,
  button,
  buttonLabel,
  className = CHIP,
  align = "left",
  up = false,
  children,
}: {
  label: string;
  button: ReactNode;
  buttonLabel?: string;
  className?: string;
  align?: "left" | "right";
  up?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };
  return (
    <div className="popover-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={buttonLabel}
        onKeyDown={onKeyDown}
        onClick={() => setOpen((v) => !v)}
      >
        {button}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={`popover ${align === "right" ? "align-right" : ""} ${up ? "up" : ""}`}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
