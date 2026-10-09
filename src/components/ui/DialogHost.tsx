import { useKeyboard } from "@opentui/react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTheme } from "../../core/theme/index.js";
import { selectTopDialog, useDialogStore } from "../../stores/dialog.js";
import { Overlay } from "../layout/shared.js";
import { AlertDialog } from "./dialogs/AlertDialog.js";
import { ConfirmDialog } from "./dialogs/ConfirmDialog.js";

/**
 * DialogHost — renders the top of the dialog stack as an overlay.
 *
 * Mount once near the top of the app tree (under all providers, above
 * everything else). Listens for Escape to pop. Each payload kind dispatches
 * to a renderer; `custom` payloads render whatever `render()` returns.
 *
 * Surface boundary: the dialog STACK is in `stores/dialog.ts` (core-ish),
 * the RENDERING lives here (TUI). A future GUI surface mounts its own host
 * that consumes the same store.
 */
export function DialogHost() {
  const top = useDialogStore(useShallow(selectTopDialog));
  const pop = useDialogStore((s) => s.pop);
  useTheme();

  useKeyboard((evt) => {
    if (!top) return;
    if (evt.name === "escape") {
      pop();
    }
  });

  useEffect(() => {
    if (!top) return;
    // Keep textareas/inputs in the underlying app from eating keystrokes meant
    // for the dialog. Each dialog renderer manages its own focus.
    return () => {};
  }, [top]);

  if (!top) return null;

  const sizeWidth: Record<typeof top.size, number> = {
    compact: 50,
    medium: 70,
    large: 100,
    xlarge: 140,
    full: -1, // sentinel — Overlay handles full size separately
  };
  const w = sizeWidth[top.size];

  return (
    <Overlay>
      <DialogBody width={w} />
    </Overlay>
  );
}

function DialogBody({ width }: { width: number }) {
  const top = useDialogStore(useShallow(selectTopDialog));
  const pop = useDialogStore((s) => s.pop);
  if (!top) return null;

  const close = () => pop();

  switch (top.payload.kind) {
    case "confirm":
      return (
        <ConfirmDialog
          width={width}
          title={top.payload.title}
          message={top.payload.message}
          danger={top.payload.danger}
          onClose={close}
        />
      );
    case "alert":
      return (
        <AlertDialog
          width={width}
          title={top.payload.title}
          message={top.payload.message}
          variant={top.payload.variant}
          onClose={close}
        />
      );
    case "select":
      // DialogSelect is the next primitive — wired in step-6.
      return null;
    case "custom": {
      const rendered = top.payload.render();
      // biome-ignore lint/suspicious/noExplicitAny: payload contract is opaque
      return rendered as any;
    }
  }
}
