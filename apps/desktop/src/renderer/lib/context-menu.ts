/**
 * What the app's right-click menu offers for the element under the pointer (#2677). Pure apart from
 * `readContextTarget`, which reads the DOM; components/ui/context-menu.tsx renders the result.
 */

export type ContextAction = "cut" | "copy" | "paste" | "selectAll" | "copyLink";

/** The editable field the menu was opened on. */
export interface ContextField {
  /** Read-only fields can be copied from but not cut or pasted into. */
  readOnly: boolean;
  /** A password field: its text never leaves it, so Cut and Copy stay off. */
  secret: boolean;
  /** Part of the field's text is selected. */
  hasSelection: boolean;
  /** The field holds any text. */
  hasText: boolean;
}

/** What was under the pointer when the menu opened. */
export interface ContextTarget {
  field: ContextField | null;
  /** The page's selected text outside a field; "" when nothing is selected. */
  selection: string;
  /** The address of the link under the pointer, if any. */
  link: string | null;
}

export interface ContextItem {
  action: ContextAction;
  label: string;
  /** The key that does the same with Ctrl or Cmd, shown next to the label. */
  key?: string;
  disabled: boolean;
}

/**
 * The menu's items in groups, separated by a line. Empty when the menu has nothing to offer there,
 * in which case it does not open.
 */
export function contextMenuItems(target: ContextTarget): ContextItem[][] {
  const groups: ContextItem[][] = [];
  const { field } = target;
  if (field) {
    const canTake = field.hasSelection && !field.secret;
    groups.push([
      { action: "cut", label: "Cut", key: "X", disabled: !canTake || field.readOnly },
      { action: "copy", label: "Copy", key: "C", disabled: !canTake },
      { action: "paste", label: "Paste", key: "V", disabled: field.readOnly },
    ]);
    groups.push([{ action: "selectAll", label: "Select all", key: "A", disabled: !field.hasText }]);
  } else if (target.selection.trim()) {
    groups.push([{ action: "copy", label: "Copy", key: "C", disabled: false }]);
  }
  if (target.link) groups.push([{ action: "copyLink", label: "Copy link", disabled: false }]);
  return groups;
}

/** Input types that hold free text the edit actions apply to. */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

/** The editable field `element` belongs to: a text input, a textarea or contenteditable content. */
export function editableOf(element: Element): HTMLElement | null {
  const field = element.closest("input, textarea, [contenteditable]");
  if (!field || !(field instanceof HTMLElement)) return null;
  if (field instanceof HTMLInputElement) {
    return TEXT_INPUTS.has(field.type) && !field.disabled ? field : null;
  }
  if (field instanceof HTMLTextAreaElement) return field.disabled ? null : field;
  return field.isContentEditable ? field : null;
}

/** Reads what the menu should act on from the element that was right-clicked. */
export function readContextTarget(element: Element): ContextTarget {
  const field = editableOf(element);
  const selection = element.ownerDocument.getSelection();
  const anchor = element.closest("a[href]");
  const href = anchor instanceof HTMLAnchorElement ? anchor.href : null;
  const link = href && !href.startsWith("javascript:") ? href : null;
  if (!field) return { field: null, selection: selection?.toString() ?? "", link };
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    let hasSelection = false;
    try {
      hasSelection = (field.selectionStart ?? 0) !== (field.selectionEnd ?? 0);
    } catch {
      // A number input has no text selection to read.
    }
    return {
      field: {
        readOnly: field.readOnly,
        secret: field instanceof HTMLInputElement && field.type === "password",
        hasSelection,
        hasText: field.value.length > 0,
      },
      selection: "",
      link,
    };
  }
  const inField =
    !!selection &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed &&
    field.contains(selection.getRangeAt(0).commonAncestorContainer);
  return {
    field: {
      readOnly: false,
      secret: false,
      hasSelection: inField,
      hasText: (field.textContent ?? "").length > 0,
    },
    selection: "",
    link,
  };
}
