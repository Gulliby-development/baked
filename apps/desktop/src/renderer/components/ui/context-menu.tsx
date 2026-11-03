import { Menu } from "@base-ui/react/menu";
import { Fragment, useEffect, useRef, useState } from "react";
import { bridge } from "../../client/bridge.js";
import { cn } from "../../lib/cn.js";
import {
  type ContextAction,
  type ContextItem,
  contextMenuItems,
  editableOf,
  readContextTarget,
} from "../../lib/context-menu.js";

/** The look of a menu popup: the kit's outline and hard shadow, popping in from the pointer. */
export const MENU_POPUP =
  "min-w-[180px] origin-[var(--transform-origin)] rounded-base border-2 border-border bg-raised p-1 text-[13px] text-foreground shadow-shadow outline-hidden transition-[opacity,scale] duration-100 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none";

/** The look of one menu row; the highlighted row (pointer or arrow keys) takes the accent fill. */
export const MENU_ITEM =
  "flex min-h-8 cursor-pointer items-center gap-6 rounded-[4px] border-2 border-transparent px-2 select-none outline-hidden data-highlighted:border-border data-highlighted:bg-main data-highlighted:text-main-foreground data-disabled:cursor-default data-disabled:text-dim-foreground data-disabled:data-highlighted:border-transparent data-disabled:data-highlighted:bg-transparent";

/** What an open menu acts on, captured at the right-click before focus moves into the menu. */
interface Opened {
  x: number;
  y: number;
  groups: ContextItem[][];
  field: HTMLElement | null;
  /** The field's selection, or the page's selected range, to put back before acting. */
  fieldRange: [number, number] | null;
  range: Range | null;
  link: string | null;
}

/** Writes `text` to the clipboard, falling back to the editing command when the API is refused. */
function writeClipboard(text: string): void {
  const fallback = (): void => {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

/** Puts the focus and selection back where they were at the right-click, then runs the action. */
function run(action: ContextAction, opened: Opened): void {
  if (action === "copyLink") {
    if (opened.link) writeClipboard(opened.link);
    return;
  }
  const { field } = opened;
  if (field) {
    field.focus();
    if (
      opened.fieldRange &&
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
    ) {
      try {
        field.setSelectionRange(...opened.fieldRange);
      } catch {
        // A number input keeps whatever selection it has.
      }
    }
  }
  if (
    opened.range &&
    (!field || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
  ) {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(opened.range);
  }
  if (action === "paste") {
    // Pasting through the clipboard API keeps the field's undo history and fires its input event.
    const paste = (): void => {
      document.execCommand("paste");
    };
    if (!navigator.clipboard?.readText) {
      paste();
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) document.execCommand("insertText", false, text);
      })
      .catch(paste);
    return;
  }
  if (action === "copy" && !field) {
    const text = opened.range?.toString() ?? "";
    if (!document.execCommand("copy") && text) writeClipboard(text);
    return;
  }
  document.execCommand(action);
}

/**
 * The app's right-click menu: Cut, Copy, Paste and Select all in text fields, Copy on selected
 * text and Copy link on links, drawn with the kit instead of a native menu. It listens on the
 * whole document and stays closed where it has nothing to offer. Mounted once, at the root of
 * the app.
 */
export function ContextMenu() {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [open, setOpen] = useState(false);
  const openedRef = useRef<Opened | null>(null);
  openedRef.current = opened;

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const target = readContextTarget(event.target);
      const groups = contextMenuItems(target);
      if (groups.length === 0) return;
      event.preventDefault();
      const field = editableOf(event.target);
      let fieldRange: [number, number] | null = null;
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        try {
          fieldRange = [field.selectionStart ?? 0, field.selectionEnd ?? 0];
        } catch {
          fieldRange = null;
        }
      }
      const selection = document.getSelection();
      const range =
        selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      setOpened({
        x: event.clientX,
        y: event.clientY,
        groups,
        field,
        fieldRange,
        range,
        link: target.link,
      });
      setOpen(true);
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!opened) return null;
  const mod = bridge.platform === "darwin" ? "⌘" : "Ctrl+";
  const anchor = {
    getBoundingClientRect: () =>
      DOMRect.fromRect({ x: opened.x, y: opened.y, width: 0, height: 0 }),
  };

  return (
    <Menu.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => {
        if (!next) setOpened(null);
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={2}
          collisionPadding={8}
          className="z-[70] outline-hidden"
        >
          <Menu.Popup
            aria-label="Edit"
            className={MENU_POPUP}
            finalFocus={() => openedRef.current?.field ?? true}
          >
            {opened.groups.map((group, index) => (
              <Fragment key={group[0]?.action ?? index}>
                {index > 0 && <Menu.Separator className="mx-1 my-1 h-[2px] bg-border" />}
                {group.map((item) => (
                  <Menu.Item
                    key={item.action}
                    disabled={item.disabled}
                    className={MENU_ITEM}
                    onClick={() => run(item.action, opened)}
                  >
                    <span>{item.label}</span>
                    {item.key && (
                      <span
                        className={cn(
                          "ml-auto font-mono text-[11px] text-dim-foreground",
                          "[[data-highlighted]>&]:text-main-foreground",
                        )}
                      >
                        {mod}
                        {item.key}
                      </span>
                    )}
                  </Menu.Item>
                ))}
              </Fragment>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
