import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { TOOLTIP_POPUP } from "./tooltip.js";

/** Hover time before a tooltip opens; moving to the next titled element while one is open is instant. */
const OPEN_DELAY_MS = 350;
/** Gap between the element and its tooltip, and the least distance to the window edge. */
const GAP = 6;
const EDGE = 8;

interface Tip {
  text: string;
  anchor: DOMRect;
}

/** The nearest element with a `title` that the system would show as a native tooltip. */
function titled(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest("[title]");
  // An iframe's title names the frame for screen readers; the frame's page owns its pointer.
  if (!element || element instanceof HTMLIFrameElement) return null;
  return element.getAttribute("title") ? element : null;
}

/**
 * Shows every `title` attribute in the app as a BAKED tooltip instead of the system's native one,
 * so plain `title=` keeps working everywhere. While an element is hovered its title moves aside
 * (the native tooltip needs it) and comes back when the pointer leaves; tests and screen readers
 * see the attribute the rest of the time. Mounted once, at the root of the app.
 */
export function TitleTooltips() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let current: Element | null = null;
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let open = false;

    const release = (): void => {
      clearTimeout(timer);
      // React may have set a new title meanwhile; that one wins.
      if (current?.isConnected && !current.hasAttribute("title"))
        current.setAttribute("title", text);
      current = null;
      open = false;
      setTip(null);
    };
    const show = (): void => {
      if (!current?.isConnected) {
        release();
        return;
      }
      open = true;
      setTip({ text, anchor: current.getBoundingClientRect() });
    };
    const over = (event: PointerEvent): void => {
      const element = titled(event.target);
      if (!element || element === current) return;
      const warm = open;
      release();
      current = element;
      text = element.getAttribute("title") ?? "";
      element.removeAttribute("title");
      if (warm) show();
      else timer = setTimeout(show, OPEN_DELAY_MS);
    };
    const out = (event: PointerEvent): void => {
      if (!current) return;
      const next = event.relatedTarget;
      if (next instanceof Node && current.contains(next)) return;
      release();
    };
    const close = (): void => {
      if (current) release();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      release();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, []);

  return tip ? createPortal(<TitleTip tip={tip} />, document.body) : null;
}

function TitleTip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const { width, height } = popup.getBoundingClientRect();
    const { anchor } = tip;
    const below = anchor.bottom + GAP;
    const top =
      below + height <= window.innerHeight - EDGE
        ? below
        : Math.max(EDGE, anchor.top - GAP - height);
    const centered = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(EDGE, centered), window.innerWidth - EDGE - width);
    setPlace({ left, top });
  }, [tip]);

  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        TOOLTIP_POPUP,
        "pointer-events-none fixed z-[60] whitespace-pre-line [overflow-wrap:anywhere]",
        !place && "opacity-0",
      )}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0 }}
    >
      {tip.text}
    </div>
  );
}
