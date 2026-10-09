/**
 * useHover — tiny hover-state hook.
 *
 * Returns `[hovered, hoverHandlers]` — spread the handlers onto any opentui
 * <box>/<text> via JSX. Cheap: a single boolean state; no global listeners,
 * no portals, no measure pass. Per-element + per-frame.
 *
 * Why a hook (not a CSS-like ":hover" pseudo-class): opentui has no style
 * cascade — hover effects live in component render. The hook is the
 * pragmatic seam.
 */
import { useMemo, useState } from "react";

export interface HoverHandlers {
  onMouseOver: () => void;
  onMouseOut: () => void;
}

export function useHover(): readonly [boolean, HoverHandlers] {
  const [hovered, setHovered] = useState(false);
  const handlers = useMemo<HoverHandlers>(
    () => ({
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
    }),
    [],
  );
  return [hovered, handlers] as const;
}
