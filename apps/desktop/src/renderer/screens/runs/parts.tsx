import type { ReactNode } from "react";
import type { RunState } from "../../../shared/api.js";
import { STATUS_TEXT, STATUS_TONE } from "./model.js";

export function StatusPill({ status, children }: { status: RunState; children?: ReactNode }) {
  return (
    <span className={`pill ${STATUS_TONE[status]}`}>
      {STATUS_TEXT[status]}
      {children}
    </span>
  );
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
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
    <div className="meter">
      <div className="meter-row">
        <span>{label}</span>
        <span className="mono">{text}</span>
      </div>
      {share !== null && (
        <div className={`meter-bar${share >= 0.9 ? " hot" : ""}`} aria-hidden="true">
          <div style={{ width: `${Math.round(share * 100)}%` }} />
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
    <section className={`card panel ${className ?? ""}`} aria-label={title}>
      <h3 className="label">{title}</h3>
      {children}
    </section>
  );
}
