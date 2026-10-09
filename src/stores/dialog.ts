import { create } from "zustand";

/**
 * Dialog stack — surface-agnostic modal state.
 *
 * Why a stack: nested flows (confirm-over-select, error-over-confirm) need
 * "go back one level" not "close everything". `push`/`pop`/`replace`/`clear`
 * compose. Each entry carries an `onClose` hook the surface invokes when
 * unwinding so callers can roll back side-effects (revert theme preview,
 * cancel pending confirm, etc).
 *
 * The store stores opaque payloads (`unknown`) — the TUI surface owns the
 * mapping from payload kind → renderable. A future GUI surface can render
 * the same stack into native dialogs without touching this file.
 */

export type DialogSize = "compact" | "medium" | "large" | "xlarge" | "full";

export interface DialogEntry {
  /** Stable id for keying + targeted close. Caller-supplied or auto-generated. */
  id: string;
  /** Surface-rendered payload. TUI maps payload→component via `kind`. */
  payload: DialogPayload;
  size: DialogSize;
  /** Invoked when the entry leaves the stack (pop/replace/clear or programmatic). */
  onClose?: () => void;
}

/**
 * Payload registry — extend as new dialogs migrate to the stack.
 * Each payload is a plain object. The TUI surface owns rendering.
 */
export type DialogPayload =
  | { kind: "confirm"; title: string; message: string; danger?: boolean }
  | { kind: "alert"; title: string; message: string; variant?: "info" | "warning" | "error" }
  | { kind: "select"; config: unknown }
  | { kind: "custom"; render: () => unknown };

export interface DialogState {
  stack: DialogEntry[];

  /** Push a new dialog on top of the stack. Returns the entry id. */
  push: (entry: Omit<DialogEntry, "id"> & { id?: string }) => string;
  /** Replace the top of the stack with a new entry (fires onClose of replaced). */
  replace: (entry: Omit<DialogEntry, "id"> & { id?: string }) => string;
  /** Pop the top entry (fires its onClose). No-op when empty. */
  pop: () => void;
  /** Pop a specific entry by id. No-op if not present. */
  popById: (id: string) => void;
  /** Drain the stack, firing every onClose in LIFO order. */
  clear: () => void;
  /** Resize the topmost entry. */
  setSize: (size: DialogSize) => void;
}

let counter = 0;
function nextId(): string {
  counter = (counter + 1) >>> 0;
  return `dlg-${counter.toString(36)}`;
}

function fire(entry: DialogEntry | undefined): void {
  if (!entry?.onClose) return;
  try {
    entry.onClose();
  } catch {}
}

export const useDialogStore = create<DialogState>()((set, get) => ({
  stack: [],

  push: (input) => {
    const id = input.id ?? nextId();
    const entry: DialogEntry = { ...input, id };
    set((s) => ({ stack: [...s.stack, entry] }));
    return id;
  },

  replace: (input) => {
    const id = input.id ?? nextId();
    const entry: DialogEntry = { ...input, id };
    set((s) => {
      const top = s.stack.at(-1);
      fire(top);
      const next = top ? s.stack.slice(0, -1) : s.stack;
      return { stack: [...next, entry] };
    });
    return id;
  },

  pop: () => {
    const top = get().stack.at(-1);
    if (!top) return;
    set((s) => ({ stack: s.stack.slice(0, -1) }));
    fire(top);
  },

  popById: (id) => {
    const idx = get().stack.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const entry = get().stack[idx];
    set((s) => ({ stack: [...s.stack.slice(0, idx), ...s.stack.slice(idx + 1)] }));
    fire(entry);
  },

  clear: () => {
    const drained = get().stack;
    set({ stack: [] });
    for (let i = drained.length - 1; i >= 0; i--) fire(drained[i]);
  },

  setSize: (size) => {
    set((s) => {
      if (s.stack.length === 0) return s;
      const next = s.stack.slice(0, -1);
      const top = s.stack[s.stack.length - 1];
      if (!top) return s;
      next.push({ ...top, size });
      return { stack: next };
    });
  },
}));

/** Selector — `true` while any dialog is on the stack. */
export const selectHasDialog = (s: DialogState): boolean => s.stack.length > 0;

/** Selector — topmost entry, or `null`. */
export const selectTopDialog = (s: DialogState): DialogEntry | null => s.stack.at(-1) ?? null;
