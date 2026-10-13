import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icon, type IconName } from "../Icon.js";

/** The colour blocks of a screen: each kind of data and each section owns one. */
export type Tone = "accent" | "ok" | "warn" | "err" | "info" | "plain";

export const FILL: Record<Tone, string> = {
  accent: "bg-main text-main-foreground",
  ok: "bg-fill-ok text-main-foreground",
  warn: "bg-fill-warn text-main-foreground",
  err: "bg-fill-err text-main-foreground",
  info: "bg-fill-info text-main-foreground",
  plain: "bg-secondary-background text-foreground",
};

/** Bars that grow from zero to their width. */
export const GROW = "transition-[width] duration-700 ease-out motion-reduce:transition-none";
/** Blocks that rise into place when they mount. */
export const RISE = "animate-rise motion-reduce:animate-none";

/** Staggers the rise of the `step`th block. */
export const riseDelay = (step: number, ms = 60): CSSProperties => ({
  animationDelay: `${step * ms}ms`,
});

/** False on the first frame, so widths set from it grow in from zero. */
export function useGrown(): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return grown;
}

/** A square colour block with a line icon: the identity of a section or a kind of data. */
export function Tile({
  tone,
  icon,
  large = false,
  small = false,
}: {
  tone: Tone;
  icon: IconName;
  large?: boolean;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-base border-2 border-border shadow-sm-hard",
        large ? "size-10" : small ? "size-7" : "size-9",
        FILL[tone],
      )}
    >
      <Icon name={icon} size={large ? 20 : small ? 15 : 18} />
    </span>
  );
}

/** A section: a header strip in the section's colour with what it shows, then its body. */
export function TonePanel({
  id,
  title,
  icon,
  tone,
  about,
  actions,
  step = 0,
  children,
}: {
  id?: string;
  title: string;
  icon: IconName;
  tone: Tone;
  about: ReactNode;
  actions?: ReactNode;
  /** Position on the screen, for the staggered rise. */
  step?: number;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className={cn(
        "min-w-0 scroll-mt-4 overflow-hidden rounded-base border-2 border-border bg-background shadow-shadow",
        RISE,
      )}
      style={riseDelay(step, 70)}
    >
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-3 border-b-2 border-border px-4 py-3",
          FILL[tone],
        )}
      >
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-base border-2 border-border bg-background text-foreground shadow-sm-hard"
        >
          <Icon name={icon} size={20} />
        </span>
        <div className="min-w-[240px] flex-1">
          <h2 className="m-0 text-[17px] font-bold">{title}</h2>
          <p className="m-0 mt-0.5 text-[12px] leading-snug">{about}</p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="flex min-w-0 flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

/** A figure at a glance: a large tile, a label, the value and a note under it. */
export function GlanceCard({
  tone,
  icon,
  label,
  value,
  note,
  step = 0,
  onClick,
}: {
  tone: Tone;
  icon: IconName;
  label: string;
  value: ReactNode;
  note: ReactNode;
  step?: number;
  /** Makes the card a button, for example one that scrolls to its section. */
  onClick?: () => void;
}) {
  const body = (
    <>
      <Tile tone={tone} icon={icon} large />
      <span className="flex min-w-0 flex-col">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-dim-foreground">
          {label}
        </span>
        <span className="text-[19px] leading-tight font-bold tabular-nums">{value}</span>
        <span
          className="truncate text-[12px] text-muted-foreground"
          title={typeof note === "string" ? note : undefined}
        >
          {note}
        </span>
      </span>
    </>
  );
  const box = cn(
    "flex min-w-0 items-center gap-3 rounded-base border-2 border-border bg-background px-3 py-3 text-left [font:inherit] text-foreground shadow-shadow",
    RISE,
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        box,
        "cursor-pointer transition-[transform,box-shadow] duration-100 hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none motion-reduce:transition-none",
      )}
      style={riseDelay(step, 50)}
    >
      {body}
    </button>
  ) : (
    <div className={box} style={riseDelay(step, 50)}>
      {body}
    </div>
  );
}
