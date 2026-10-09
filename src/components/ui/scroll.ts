/**
 * Scroll acceleration — shared instances + opentui-friendly props builder.
 *
 * One per chat-stream surface, one per modal/picker surface, one per long-list
 * surface. Reusing instances keeps the velocity history alive across rerenders
 * so trackpad bursts stay smooth.
 *
 * Re-export ScrollAcceleration so the rest of the codebase never imports
 * @opentui/core for scroll types directly.
 */
import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core";

export type { ScrollAcceleration };

/** Long, append-driven content (message lists, logs). Tuned for sustained scrolling. */
export const chatScrollAccel: ScrollAcceleration = new MacOSScrollAccel({
  A: 0.35,
  tau: 110,
  maxMultiplier: 6,
});

/** Bounded vertical lists (pickers, modals, settings tables). */
export const listScrollAccel: ScrollAcceleration = new MacOSScrollAccel({
  A: 0.25,
  tau: 140,
  maxMultiplier: 4,
});

/** Compact lists (autocomplete dropdowns, command palette). */
export const compactScrollAccel: ScrollAcceleration = new MacOSScrollAccel({
  A: 0.18,
  tau: 160,
  maxMultiplier: 3,
});

export type ScrollKind = "chat" | "list" | "compact";

const REGISTRY: Record<ScrollKind, ScrollAcceleration> = {
  chat: chatScrollAccel,
  list: listScrollAccel,
  compact: compactScrollAccel,
};

/**
 * Resolve the scroll-accel instance for a given surface kind.
 * Helper exists so callers can write `scrollAcceleration={getScrollAccel("list")}`
 * without importing the named exports.
 */
export function getScrollAccel(kind: ScrollKind): ScrollAcceleration {
  return REGISTRY[kind];
}

/**
 * Build a spread-friendly props bundle for `<scrollbox>` — pairs scroll accel
 * with sticky-bottom defaults so streaming chat snaps to the latest message.
 */
export function streamScrollProps(): {
  scrollAcceleration: ScrollAcceleration;
  stickyScroll: true;
  stickyStart: "bottom";
} {
  return {
    scrollAcceleration: chatScrollAccel,
    stickyScroll: true,
    stickyStart: "bottom",
  };
}
