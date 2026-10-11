import type { EventEmitter } from "node:events";
import type { KeyEvent } from "@opentui/core";
import { useAppContext, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

/**
 * Drop-in replacements for `useKeyboard` and `useTerminalDimensions` from
 * `@opentui/react`. Those hooks add one EventEmitter listener per mounted
 * component, and the TUI keeps every modal mounted (hidden via `visible`), so
 * the listener count grew with each new modal until Node's leak warning fired.
 * Here every emitter/event pair gets a single listener that fans out to the
 * mounted handlers, so the count stays constant however many components
 * subscribe.
 */

type Emitter = Pick<EventEmitter, "on" | "off">;

type Handler = (...args: unknown[]) => void;

interface Channel {
  handlers: Set<Handler>;
  dispatch: Handler;
}

const channels = new WeakMap<Emitter, Map<string, Channel>>();

function stopsPropagation(event: string, args: unknown[]): boolean {
  if (event !== "keypress" && event !== "keyrelease") return false;
  const key = args[0] as { propagationStopped?: boolean } | undefined;
  return key?.propagationStopped === true;
}

/**
 * Subscribe `handler` to `event` on `emitter` through one shared listener.
 * Handlers run in subscription order, and a key event whose propagation was
 * stopped is not passed to later handlers, matching opentui's own dispatch.
 * Returns the unsubscribe function.
 */
export function subscribeShared(emitter: Emitter, event: string, handler: Handler): () => void {
  let byEvent = channels.get(emitter);
  if (!byEvent) {
    byEvent = new Map();
    channels.set(emitter, byEvent);
  }
  let channel = byEvent.get(event);
  if (!channel) {
    const handlers = new Set<Handler>();
    const dispatch: Handler = (...args) => {
      // Snapshot so a handler that unsubscribes mid-dispatch doesn't skip others.
      for (const fn of [...handlers]) {
        if (!handlers.has(fn)) continue;
        fn(...args);
        if (stopsPropagation(event, args)) return;
      }
    };
    channel = { handlers, dispatch };
    byEvent.set(event, channel);
    emitter.on(event, dispatch);
  }
  channel.handlers.add(handler);

  const owned = channel;
  const events = byEvent;
  return () => {
    owned.handlers.delete(handler);
    if (owned.handlers.size > 0 || events.get(event) !== owned) return;
    emitter.off(event, owned.dispatch);
    events.delete(event);
  };
}

/** Number of handlers sharing the listener for `event` on `emitter`. */
export function sharedHandlerCount(emitter: Emitter, event: string): number {
  return channels.get(emitter)?.get(event)?.handlers.size ?? 0;
}

function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export interface UseKeyboardOptions {
  /** Also receive key release events. */
  release?: boolean;
}

export function useKeyboard(
  handler: (key: KeyEvent) => void,
  options: UseKeyboardOptions = {},
): void {
  const { keyHandler } = useAppContext();
  const latest = useLatest(handler);
  const release = options.release === true;
  useEffect(() => {
    if (!keyHandler) return;
    const forward: Handler = (key) => latest.current(key as KeyEvent);
    const offPress = subscribeShared(keyHandler, "keypress", forward);
    const offRelease = release ? subscribeShared(keyHandler, "keyrelease", forward) : undefined;
    return () => {
      offPress();
      offRelease?.();
    };
  }, [keyHandler, release, latest]);
}

export function useTerminalDimensions(): { width: number; height: number } {
  const renderer = useRenderer();
  const [dimensions, setDimensions] = useState({ width: renderer.width, height: renderer.height });
  useEffect(() => {
    // Catch a resize that landed between the first render and this effect.
    setDimensions((prev) =>
      prev.width === renderer.width && prev.height === renderer.height
        ? prev
        : { width: renderer.width, height: renderer.height },
    );
    return subscribeShared(renderer, "resize", (width, height) => {
      setDimensions({ width: width as number, height: height as number });
    });
  }, [renderer]);
  return dimensions;
}
