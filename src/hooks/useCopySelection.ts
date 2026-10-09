import type { MouseEvent } from "@opentui/core";
import { MouseButton } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback } from "react";
import { IS_WIN } from "../core/platform/index.js";
import { copyOsc52, copyToClipboard as nativeCopyToClipboard } from "../utils/clipboard.js";

export interface CopySelectionHandlers {
  copySelection: () => boolean;
  onMouseDown: (evt: MouseEvent) => void;
  onMouseUp: (() => void) | undefined;
}

export function useCopySelection(): CopySelectionHandlers {
  const renderer = useRenderer();

  // Copy the active selection to clipboard. `clear` controls whether the
  // highlight is dropped afterwards:
  //   - true  → explicit copy gesture (right-click, Ctrl/Cmd+C): clear, the
  //             user is done with the selection.
  //   - false → copy-on-select-release (mouse-up): KEEP the highlight so the
  //             selection doesn't vanish the instant the button is released.
  //             Clearing here is what made drag-select feel impossible — the
  //             text deselected before it could be seen or extended.
  const copySelectionInner = useCallback(
    (clear: boolean): boolean => {
      const sel = renderer.getSelection();
      if (!sel) return false;
      const text = sel.getSelectedText();
      if (!text) return false;
      const focus = renderer.currentFocusedRenderable as
        | { getClipboardText?: (text: string) => string }
        | null
        | undefined;
      const clipboardText =
        focus?.getClipboardText && sel.selectedRenderables.includes(focus as never)
          ? focus.getClipboardText(text)
          : text;
      // The renderer's OSC-52 path silently no-ops when terminal capability
      // detection didn't report osc52 support — common over SSH (PowerShell /
      // Tabby → sshd), where capability queries get lost. Fall back to writing
      // the escape sequence directly to stdout, like opencode does. Native
      // copy still runs, but over SSH it only reaches the REMOTE clipboard
      // (or fails without a display), so OSC-52 is the only path home.
      if (!renderer.copyToClipboardOSC52(clipboardText)) copyOsc52(clipboardText);
      nativeCopyToClipboard(clipboardText);
      if (clear) renderer.clearSelection();
      return true;
    },
    [renderer],
  );

  // Explicit copy — clears the selection. Bound to right-click + Ctrl/Cmd+C.
  const copySelection = useCallback(() => copySelectionInner(true), [copySelectionInner]);

  // Copy on select-release — preserves the highlight.
  const copyOnSelect = useCallback(() => copySelectionInner(false), [copySelectionInner]);

  const onMouseDown = useCallback(
    (evt: MouseEvent) => {
      if (IS_WIN) return;
      if (evt.button !== MouseButton.RIGHT) return;
      if (!copySelection()) return;
      evt.preventDefault();
      evt.stopPropagation();
    },
    [copySelection],
  );

  // Windows opts out (native terminal selection owns the gesture). Elsewhere we
  // copy on release but never clear — the selection stays visible until the
  // user starts a new one or presses Escape.
  const onMouseUp = IS_WIN ? undefined : copyOnSelect;

  return { copySelection, onMouseDown, onMouseUp };
}
