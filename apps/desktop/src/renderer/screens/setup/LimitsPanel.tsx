import { useState } from "react";
import { type LimitWindow, type ProviderLimits, setup } from "../../client/setup.js";
import { Button } from "../../components/ui/button.js";
import {
  FILL,
  GROW,
  RISE,
  riseDelay,
  Tile,
  type Tone,
  TonePanel,
  useGrown,
} from "../../components/ui/tone.js";
import { cn } from "../../lib/cn.js";
import { useNow } from "../../lib/now.js";
import {
  freshness,
  headlineWindow,
  leftPercent,
  planLabel,
  providerTone,
  resetsIn,
  windowTone,
} from "./limits-model.js";
import { LoadState, NOTE, Tag, useLoad } from "./shared.js";

/** The colour of a ring or meter fill, by tone. */
const STROKE: Record<Tone, string> = {
  accent: "var(--main)",
  ok: "var(--fill-ok)",
  warn: "var(--fill-warn)",
  err: "var(--fill-err)",
  info: "var(--fill-info)",
  plain: "var(--line-strong)",
};

const RING = 30;
const RING_LENGTH = 2 * Math.PI * RING;

/** A ring that fills to how much of the tightest window is left. */
function Ring({ left, tone, grown }: { left: number | null; tone: Tone; grown: boolean }) {
  const shown = grown && left !== null ? left : 0;
  return (
    <span className="relative grid size-[84px] shrink-0 place-items-center" aria-hidden="true">
      <svg viewBox="0 0 76 76" className="absolute inset-0 size-full -rotate-90">
        <title>Left of the tightest window</title>
        <circle cx="38" cy="38" r={RING} fill="none" stroke="var(--line)" strokeWidth="8" />
        <circle
          cx="38"
          cy="38"
          r={RING}
          fill="none"
          stroke={STROKE[tone]}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - shown / 100)}
          className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none"
        />
      </svg>
      <span className="relative flex flex-col items-center leading-none">
        <span
          className={cn(
            "text-[19px] font-bold tabular-nums",
            tone === "err" && "text-[color:var(--err)]",
          )}
        >
          {left === null ? "?" : `${String(Math.round(left))}%`}
        </span>
        <span className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-dim-foreground">
          left
        </span>
      </span>
    </span>
  );
}

/** One usage window: what it is, a meter of what is left, and when it resets. */
function WindowMeter({ w, now, grown }: { w: LimitWindow; now: number; grown: boolean }) {
  const left = leftPercent(w);
  const tone = windowTone(w);
  const reset = resetsIn(w.resetsAt, now);
  const counted =
    !w.unlimited && w.remaining != null && w.entitlement != null
      ? `${String(w.remaining)} of ${String(w.entitlement)}`
      : null;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-semibold">{w.label}</span>
        <span className="tabular-nums text-soft-foreground">
          {w.unlimited
            ? "unlimited"
            : left === null
              ? (w.detail ?? "unknown")
              : `${String(Math.round(left))}% left${counted ? ` · ${counted}` : ""}`}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "block h-[14px] overflow-hidden rounded-base border-2 border-border bg-secondary-background",
          left === null && "border-dashed",
        )}
      >
        <span
          className={cn("block h-full", GROW, FILL[tone], w.unlimited && "opacity-60")}
          style={{ width: grown && left !== null ? `${String(left)}%` : "0%" }}
        />
      </span>
      {(reset || (left !== null && w.detail)) && (
        <span className={cn(NOTE, "text-dim-foreground")}>
          {reset && (
            <span title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>
              {reset === "now" ? "resets now" : `resets in ${reset}`}
            </span>
          )}
          {reset && left !== null && w.detail ? " · " : ""}
          {left !== null && w.detail}
        </span>
      )}
    </li>
  );
}

function ProviderCard({ p, now, step }: { p: ProviderLimits; now: number; step: number }) {
  // Each card mounts when its data arrives, so its ring and meters grow in from zero then.
  const grown = useGrown();
  const tone = providerTone(p);
  const head = headlineWindow(p);
  const fresh = freshness(p, now);
  const plan = planLabel(p.plan);
  return (
    <article
      aria-label={p.name}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-base border-2 border-border bg-background p-3 shadow-shadow",
        RISE,
      )}
      style={riseDelay(step, 80)}
    >
      <header className="flex min-w-0 items-center gap-3">
        {head ? (
          <Ring left={leftPercent(head)} tone={windowTone(head)} grown={grown} />
        ) : (
          <Tile tone={tone} icon="usage" large />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[16px] font-bold">{p.name}</span>
          <span className="flex flex-wrap gap-1">
            {plan && <Tag>{plan}</Tag>}
            {fresh && <Tag>{fresh}</Tag>}
            {p.state === "not-signed-in" && <Tag tone="warn">not signed in</Tag>}
            {p.state === "error" && <Tag tone="err">not read</Tag>}
            {tone === "err" && <Tag tone="err">limit reached</Tag>}
          </span>
          {head && <span className={cn(NOTE, "text-dim-foreground")}>tightest: {head.label}</span>}
        </span>
      </header>
      {p.windows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {p.windows.map((w) => (
            <WindowMeter key={w.id} w={w} now={now} grown={grown} />
          ))}
        </ul>
      )}
      {p.credits && (
        <span className="text-[13px]">
          Credits:{" "}
          <span className="font-semibold">
            {p.credits.unlimited ? "unlimited" : (p.credits.balance ?? "available")}
          </span>
        </span>
      )}
      {p.message && <p className={cn(NOTE, "m-0 text-muted-foreground")}>{p.message}</p>}
    </article>
  );
}

/**
 * Subscription limits on the Providers page: how much of each subscription's usage is left, a
 * ring for the tightest window and a meter per window, with live reset countdowns.
 */
export function LimitsPanel({ projectKey }: { projectKey: string }) {
  const [limits, reload] = useLoad(() => setup.limits(projectKey), [projectKey, "limits"]);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000);
  return (
    <TonePanel
      title="Subscription limits"
      icon="usage"
      tone="info"
      about="How much of each subscription's usage is left. Codex and Copilot are asked directly; Claude Code reports its limits during the turns BAKED runs on it. API keys are billed per token and have no limit."
      actions={
        <Button
          variant="secondary"
          size="md"
          disabled={refreshing || limits.state === "loading"}
          onClick={() => {
            setRefreshing(true);
            reload();
            setTimeout(() => setRefreshing(false), 800);
          }}
        >
          Refresh
        </Button>
      }
    >
      {limits.state === "ready" ? (
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-3">
          {limits.data.limits.map((p, i) => (
            <ProviderCard key={p.provider} p={p} now={now} step={i} />
          ))}
        </div>
      ) : (
        <LoadState value={limits} what="subscription limits" />
      )}
    </TonePanel>
  );
}
