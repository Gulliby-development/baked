import { useEffect, useRef } from "react";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC character required for terminal mouse event parsing
const MOUSE_SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const SCROLL_UP = 64;
const SCROLL_DOWN = 65;
const LEFT_CLICK = 0;

interface UseMouseOptions {
  onScroll?: (direction: "up" | "down") => void;
  onClick?: (col: number, row: number) => void;
  isActive?: boolean;
}

export function useMouse({ onScroll, onClick, isActive = true }: UseMouseOptions): void {
  const onScrollRef = useRef(onScroll);
  const onClickRef = useRef(onClick);
  onScrollRef.current = onScroll;
  onClickRef.current = onClick;

  const needsTracking = !!onClick || !!onScroll;

  useEffect(() => {
    if (!isActive || !needsTracking) return;

    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    const stdin = process.stdin;
    const originalRead = stdin.read.bind(stdin);

    const patchedRead = (size?: number) => {
      const chunk = originalRead(size);
      if (chunk === null) return null;

      const str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");

      MOUSE_SGR_RE.lastIndex = 0;
      if (!MOUSE_SGR_RE.test(str)) return chunk;

      MOUSE_SGR_RE.lastIndex = 0;
      for (let m = MOUSE_SGR_RE.exec(str); m !== null; m = MOUSE_SGR_RE.exec(str)) {
        const button = Number(m[1]);
        const col = Number(m[2]);
        const row = Number(m[3]);
        const isPress = m[4] === "M";

        if (button === SCROLL_UP && onScrollRef.current) onScrollRef.current("up");
        if (button === SCROLL_DOWN && onScrollRef.current) onScrollRef.current("down");
        if (button === LEFT_CLICK && isPress && onClickRef.current) onClickRef.current(col, row);
      }

      const cleaned = str.replace(MOUSE_SGR_RE, "");
      if (cleaned.length === 0) return null;
      if (typeof chunk === "string") return cleaned;
      return Buffer.from(cleaned, "utf-8");
    };

    stdin.read = patchedRead as typeof stdin.read;

    return () => {
      stdin.read = originalRead;
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [isActive, needsTracking]);
}
