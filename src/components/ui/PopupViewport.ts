import { createContext, useContext } from "react";

export const PopupViewport = createContext<{ width: number; height: number } | null>(null);

export function useListViewport(width: number, rows: number, rowHeight = 1) {
  const popup = useContext(PopupViewport);
  return {
    width: Math.max(1, Math.min(width, popup ? popup.width - 4 : width)),
    rows: Math.max(1, Math.min(rows, popup ? Math.floor((popup.height - 7) / rowHeight) : rows)),
  };
}
