import { useEffect, useState } from "react";
import type { WindowAction } from "../../shared/bridge.js";
import { bridge, isMock } from "../client/bridge.js";
import { cn } from "../lib/cn.js";
import { BakedMark } from "./BakedMark.js";

const GLYPHS: Record<"minimize" | "maximize" | "restore" | "close", string> = {
  minimize: "M2 6h8",
  maximize: "M2.5 2.5h7v7h-7z",
  restore: "M2.5 4.5h5v5h-5zM4.5 4.5v-2h5v5h-2",
  close: "M2.5 2.5l7 7M9.5 2.5l-7 7",
};

/** Lets an element inside the bar take clicks instead of dragging the window. */
const NO_DRAG = "[-webkit-app-region:no-drag] [app-region:no-drag]";

function WindowButton({
  action,
  glyph,
  label,
}: {
  action: WindowAction;
  glyph: keyof typeof GLYPHS;
  label: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "grid h-full w-12 cursor-default place-items-center border-l-2 border-border bg-transparent text-main-foreground hover:bg-main-foreground/15 focus-visible:-outline-offset-2",
        action === "close" && "hover:bg-fill-err",
        NO_DRAG,
      )}
      aria-label={label}
      title={label}
      onClick={() => void bridge.windowAction(action)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d={GLYPHS[glyph]} stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </button>
  );
}

/**
 * The window's title bar, drawn by the app instead of the system frame. The bar drags the window;
 * macOS keeps its own traffic lights on the left, other systems get the buttons on the right.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => bridge.onMaximized(setMaximized), []);
  // A plain browser preview has no window to control.
  if (isMock) return null;
  const mac = bridge.platform === "darwin";
  return (
    <header
      className={cn(
        "flex shrink-0 select-none items-center border-b-[3px] border-border bg-main text-main-foreground [-webkit-app-region:drag] [app-region:drag]",
        mac ? "h-10 justify-center" : "h-9",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center rounded-[4px] bg-main-foreground px-1.5 py-0.5 font-mono text-xs font-heading tracking-[0.14em] text-main",
          !mac && "ml-3",
        )}
      >
        <BakedMark size={13} className="mr-1.5" />
        BAKED
      </span>
      {!mac && (
        <div className="ml-auto flex h-full">
          <WindowButton action="minimize" glyph="minimize" label="Minimize" />
          <WindowButton
            action="maximize"
            glyph={maximized ? "restore" : "maximize"}
            label={maximized ? "Restore" : "Maximize"}
          />
          <WindowButton action="close" glyph="close" label="Close" />
        </div>
      )}
    </header>
  );
}
