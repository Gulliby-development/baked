import type { ReactNode } from "react";
import { Alert } from "./alert.js";
import { Button } from "./button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.js";

/**
 * A yes/no question before an action that is hard to take back. Esc, the close button and Keep
 * leave without acting; the dialog stays open while the action runs so its error shows here.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{children}</DialogDescription>
        </DialogHeader>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
            Keep
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="md"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
