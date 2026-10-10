import { useEffect, useState } from "react";
import type { WindowAction } from "../../shared/bridge.js";
import { bridge, isMock } from "../client/bridge.js";

const GLYPHS: Record<"minimize" | "maximize" | "restore" | "close", string> = {
  minimize: "M2 6h8",
  maximize: "M2.5 2.5h7v7h-7z",
  restore: "M2.5 4.5h5v5h-5zM4.5 4.5v-2h5v5h-2",
  close: "M2.5 2.5l7 7M9.5 2.5l-7 7",
};

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
      className={`window-btn${action === "close" ? " close" : ""}`}
      aria-label={label}
      title={label}
      onClick={() => void bridge.windowAction(action)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d={GLYPHS[glyph]} stroke="currentColor" strokeWidth="1.1" />
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
    <header className={`titlebar${mac ? " mac" : ""}`}>
      <span className="titlebar-brand">
        <span className="titlebar-logo" aria-hidden="true">
          B
        </span>
        BAKED
      </span>
      {!mac && (
        <div className="window-controls">
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
