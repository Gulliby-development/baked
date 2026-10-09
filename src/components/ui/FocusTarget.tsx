import type { ScrollBoxRenderable } from "@opentui/core";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
} from "react";

export const PopupScroll = createContext<RefObject<ScrollBoxRenderable | null>>({ current: null });

export function FocusTarget({ active, children }: { active: boolean; children: ReactNode }) {
  const scroll = useContext(PopupScroll);
  const id = useId();
  const reveal = useCallback(() => {
    if (active) scroll.current?.scrollChildIntoView(id);
  }, [active, scroll, id]);
  useEffect(reveal, [reveal]);
  return (
    <box id={id} flexDirection="column" flexShrink={0} onSizeChange={reveal}>
      {children}
    </box>
  );
}
