import { useSyncExternalStore } from "react";

/**
 * Whether the full sidebar is shown on screens that collapse it to the icon rail (chat). Kept per
 * window in local storage; the default is the rail.
 */

const KEY = "baked.sidebarExpanded";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let expanded = read();

export function setSidebarExpanded(value: boolean): void {
  expanded = value;
  try {
    window.localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // Storage can be unavailable; the choice then lasts until reload.
  }
  for (const listener of listeners) listener();
}

export function useSidebarExpanded(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => expanded,
  );
}
