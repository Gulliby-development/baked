import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

const CHIP_BASE =
  "inline-flex items-center gap-[6px] px-[10px] py-[6px] rounded-base border-2 border-border bg-raised text-dim-foreground font-[inherit] leading-[inherit] text-[13px] font-semibold no-underline cursor-pointer whitespace-nowrap hover:bg-hover hover:text-foreground hover:shadow-sm-hard aria-expanded:bg-hover aria-expanded:text-foreground aria-expanded:shadow-sm-hard";
/** A compact header or composer control: a button or link with an ink outline. */
export const CHIP = `${CHIP_BASE} min-h-[30px]`;
export const CHIP_SMALL = `${CHIP_BASE} min-h-[26px]`;

/** The floating panel; callers add its horizontal and vertical placement. */
export const POPOVER =
  "absolute z-10 min-w-[240px] max-w-[360px] max-h-[420px] overflow-y-auto bg-raised border-2 border-border rounded-base flex flex-col gap-[6px] text-[13px] text-soft-foreground shadow-shadow";
export const POPOVER_ROOT = "relative inline-flex";

export const MENU_LIST = "flex flex-col gap-[2px]";
export const MENU_NOTE = "m-1 text-[12px] text-dim-foreground";
const MENU_ITEM_BASE =
  "flex min-h-[32px] px-2 border-2 border-transparent rounded-base bg-transparent text-soft-foreground font-[inherit] leading-[inherit] text-[13px] text-left no-underline cursor-pointer hover:bg-hover hover:text-foreground aria-pressed:border-border aria-pressed:bg-selected aria-pressed:text-foreground aria-pressed:font-semibold aria-[current=page]:border-border aria-[current=page]:bg-selected aria-[current=page]:text-foreground aria-[current=page]:font-semibold";
/** A row in a popover menu; `aria-pressed` or `aria-current` marks the chosen one. */
export const MENU_ITEM = `${MENU_ITEM_BASE} items-center gap-2 py-1`;
/** A menu row with a title line over a detail line. */
export const MENU_ITEM_STACKED = `${MENU_ITEM_BASE} flex-col items-start gap-[2px] py-[6px]`;

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
    <div className={POPOVER_ROOT} ref={root}>
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
          className={`${POPOVER} p-[10px] ${align === "right" ? "right-0" : "left-0"} ${up ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"}`}
          onKeyDown={onKeyDown}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
