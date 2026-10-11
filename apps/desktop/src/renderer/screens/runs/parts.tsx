import type { ReactNode } from "react";
import type { RunState } from "../../../shared/api.js";
import { cn } from "../../lib/cn.js";
import { LABEL, PANEL } from "../../lib/styles.js";
import { STATUS_TEXT, STATUS_TONE } from "./model.js";

/** Text in a status colour, by tone; the empty tone keeps the inherited colour. */
export const TONE_TEXT: Record<string, string> = {
  ok: "text-[var(--ok)]",
  warn: "text-[var(--warn)]",
  err: "text-[var(--err)]",
  info: "text-[var(--info)]",
  "": "",
};

const PILL =
  "inline-block whitespace-nowrap rounded-[10px] px-[9px] py-[2px] text-[12px] font-medium";
const PILL_TONE: Record<string, string> = {
  ok: `${PILL} bg-[var(--ok)] text-[var(--accent-text)]`,
  warn: `${PILL} bg-[var(--warn)] text-[var(--accent-text)]`,
  err: `${PILL} bg-[var(--err)] text-[var(--accent-text)]`,
  info: `${PILL} bg-[var(--info)] text-[var(--accent-text)]`,
  "": `${PILL} bg-hover text-soft-foreground`,
};

export function StatusPill({ status, children }: { status: RunState; children?: ReactNode }) {
  return (
    <span className={PILL_TONE[STATUS_TONE[status]]}>
      {STATUS_TEXT[status]}
      {children}
    </span>
  );
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={PILL_TONE[tone] ?? PILL_TONE[""]}>{children}</span>;
}

/** A labelled bar; without a limit it shows the value alone. */
export function Meter({
  label,
  value,
  limit,
  text,
}: {
  label: string;
  value: number;
  limit: number | null;
  text: string;
}) {
  const share = limit && limit > 0 ? Math.min(1, value / limit) : null;
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex justify-between gap-[10px] text-[13px] text-soft-foreground">
        <span>{label}</span>
        <span className="font-mono">{text}</span>
      </div>
      {share !== null && (
        <div className="h-[6px] rounded-[3px] bg-hover" aria-hidden="true">
          <div
            className={`h-full rounded-[3px] ${share >= 0.9 ? "bg-[var(--warn)]" : "bg-[var(--accent)]"}`}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(PANEL, "flex flex-col gap-[10px]", className)} aria-label={title}>
      <h3 className={LABEL}>{title}</h3>
      {children}
    </section>
  );
}
