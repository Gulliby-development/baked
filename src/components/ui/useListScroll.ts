import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useRef } from "react";

import { useScrollLayout } from "./useScrollLayout.js";

export function useListScroll(selectedIndex: number, rowHeight = 1) {
  const ref = useRef<ScrollBoxRenderable>(null);
  const revealSelection = useCallback(() => {
    const scroll = ref.current;
    if (!scroll || selectedIndex < 0) return;
    const top = selectedIndex * rowHeight;
    const bottom = top + rowHeight;
    if (top < scroll.scrollTop) scroll.scrollTo(top);
    else if (bottom > scroll.scrollTop + scroll.viewport.height) {
      scroll.scrollTo(Math.max(0, bottom - scroll.viewport.height));
    }
  }, [selectedIndex, rowHeight]);

  useScrollLayout(ref, revealSelection);
  return { ref, revealSelection };
}
