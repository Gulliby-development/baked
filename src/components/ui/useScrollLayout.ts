import type { ScrollBoxRenderable } from "@opentui/core";
import { type RefObject, useEffect } from "react";

export function useScrollLayout(
  ref: RefObject<ScrollBoxRenderable | null>,
  onLayout: () => void,
  mountKey: string | boolean = true,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new panel remounts the scrollbox behind the stable ref.
  useEffect(() => {
    const scroll = ref.current;
    if (!scroll) return;
    let disposed = false;
    let queued = false;
    const afterLayout = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) onLayout();
      });
    };
    // OpenTUI uses these callbacks to update scroll bounds; preserve their order.
    const cleanups = [scroll.content, scroll.viewport].map((node) => {
      const internal = node.onSizeChange;
      const listener = () => {
        internal?.call(node);
        afterLayout();
      };
      node.onSizeChange = listener;
      return () => {
        if (node.onSizeChange === listener) node.onSizeChange = internal;
      };
    });
    afterLayout();
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [ref, onLayout, mountKey]);
}
