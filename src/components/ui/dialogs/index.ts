/**
 * Dialog primitives — surface-rendered pieces of the dialog stack.
 *
 * The STACK lives in `src/stores/dialog.ts` (surface-agnostic). The
 * primitives here render TUI variants. Each primitive ships with an
 * imperative helper (`confirm`/`alert`/`openSelect`) so callers don't
 * have to push manually.
 */
export { AlertDialog, alert } from "./AlertDialog.js";
export { ConfirmDialog, confirm } from "./ConfirmDialog.js";
export {
  DialogSelect,
  type DialogSelectAction,
  type DialogSelectOption,
  type DialogSelectProps,
  openSelect,
} from "./DialogSelect.js";
