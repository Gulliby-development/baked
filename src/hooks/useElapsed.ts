import { useEffect, useRef, useState } from "react";

export function formatElapsed(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${String(h)}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${String(m)}m ${String(s).padStart(2, "0")}s`;
  return `${String(s)}s`;
}

/**
 * Tracks elapsed seconds while `active` is true.
 * Resets when `active` transitions from false → true.
 * Returns raw seconds — use `formatElapsed` for display.
 */
export function useElapsed(active: boolean): number {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    startRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [active]);

  return elapsed;
}
