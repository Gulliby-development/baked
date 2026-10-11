import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

export type DotTone = "ok" | "warn" | "err" | "busy" | "";

const TONE: Record<DotTone, string> = {
  ok: "bg-[var(--ok)]",
  warn: "bg-[var(--warn)]",
  err: "bg-[var(--err)]",
  busy: "bg-[var(--info)]",
  "": "bg-[var(--text-4)]",
};

// A small status dot in one of BAKED's status colours; no tone is the muted grey.
function Dot({ className, tone = "", ...props }: ComponentProps<"span"> & { tone?: DotTone }) {
  return (
    <span
      data-slot="dot"
      className={cn("size-2 flex-none rounded-full", TONE[tone], className)}
      {...props}
    />
  );
}

export { Dot };
