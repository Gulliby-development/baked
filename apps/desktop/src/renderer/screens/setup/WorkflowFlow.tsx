import { useEffect, useMemo, useState } from "react";
import type { WorkflowLine } from "../../client/start.js";
import { Icon } from "../../components/Icon.js";
import { Button } from "../../components/ui/button.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { cn } from "../../lib/cn.js";
import { LABEL, PANEL } from "../../lib/styles.js";
import { Conveyor } from "../runs/Conveyor.js";
import { GATE_KIND, stageIcon } from "../runs/line-model.js";
import {
  frameAt,
  narrate,
  SCENARIO_LABEL,
  type Scenario,
  scenariosFor,
  stepAt,
  walkStations,
  walkthrough,
} from "./workflow-studio-model.js";

/**
 * A run played along a workflow's line on the run screen's conveyor: each station works in turn,
 * and in the failure scenarios a loop carries the work back. Play, pause, step, change the speed,
 * or click a station to jump there. `compact` keeps only the conveyor and one line of narration,
 * playing on its own (the gallery's banner).
 */

const SPEEDS = [1, 2, 0.5] as const;
const TICK_MS = 1700;

const reducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function WorkflowFlow({
  line,
  compact = false,
  scenario: initial,
  onEditStation,
}: {
  line: WorkflowLine;
  compact?: boolean;
  scenario?: Scenario;
  /** Opens a station in the editor; the Now panel offers it for the current station. */
  onEditStation?: (id: string) => void;
}) {
  const scenarios = scenariosFor(line);
  const [scenario, setScenario] = useState<Scenario>(
    initial && scenarios.includes(initial) ? initial : (scenarios[1] ?? "happy"),
  );
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const walk = useMemo(() => walkthrough(line, scenario), [line, scenario]);
  const last = walk.events.length - 1;

  useEffect(() => {
    if (!playing) return;
    // The last step stays a little longer before the run starts again.
    const wait = (step >= last ? TICK_MS * 2 : TICK_MS) / speed;
    const timer = setTimeout(() => setStep((s) => (s >= last ? 0 : s + 1)), wait);
    return () => clearTimeout(timer);
  }, [playing, step, last, speed]);

  const frame = frameAt(walk, step);
  const stations = walkStations(walk, frame);
  const event = frame.event;
  const station = walk.stations[event.at];
  const told = narrate(walk, event);
  const pick = (next: Scenario) => {
    setScenario(next);
    setStep(0);
  };

  const conveyor = (
    <Conveyor
      stations={stations}
      loops={walk.loops}
      selected={stations[event.at]?.id ?? ""}
      running={playing}
      onSelect={(id) => {
        setPlaying(false);
        setStep(
          stepAt(
            walk,
            stations.findIndex((s) => s.id === id),
          ),
        );
      }}
    />
  );

  if (compact)
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {conveyor}
        <p
          className="m-0 min-h-[20px] truncate text-[13px] text-soft-foreground"
          aria-live="polite"
        >
          <span className="font-semibold text-foreground">{told.title}.</span> {told.text}
        </p>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="md"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            if (!playing && step >= last) setStep(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Play"}
        </Button>
        <Button
          variant="secondary"
          size="md"
          aria-label="Step back"
          disabled={step === 0}
          onClick={() => {
            setPlaying(false);
            setStep(Math.max(0, step - 1));
          }}
        >
          ‹
        </Button>
        <Button
          variant="secondary"
          size="md"
          aria-label="Step forward"
          disabled={step >= last}
          onClick={() => {
            setPlaying(false);
            setStep(Math.min(last, step + 1));
          }}
        >
          ›
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            setStep(0);
            setPlaying(true);
          }}
        >
          Restart
        </Button>
        <Button
          variant="secondary"
          size="md"
          aria-label={`Speed ${speed}×, change`}
          className="font-mono"
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1)}
        >
          {speed}×
        </Button>
        <span
          className="mx-1 h-[10px] min-w-[120px] flex-1 overflow-hidden rounded-full border-2 border-border bg-secondary-background"
          role="progressbar"
          aria-label="Walkthrough progress"
          aria-valuemin={1}
          aria-valuemax={last + 1}
          aria-valuenow={step + 1}
        >
          <span
            className="block h-full bg-main transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${((step + 1) / (last + 1)) * 100}%` }}
          />
        </span>
        <span className="font-mono text-[12px] text-muted-foreground">
          step {step + 1} / {last + 1}
        </span>
      </div>
      {scenarios.length > 1 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL}>What happens</span>
          <SegmentGroup aria-label="What happens in the run">
            {scenarios.map((s) => (
              <Segment key={s} aria-pressed={s === scenario} onClick={() => pick(s)}>
                {SCENARIO_LABEL[s]}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
      )}
      <div className={cn(PANEL, "bg-secondary-background py-3")}>{conveyor}</div>
      <div className="flex flex-wrap items-stretch gap-4">
        <section
          aria-label="Now"
          aria-live="polite"
          className={cn(PANEL, "flex min-w-0 flex-[999_1_480px] flex-col gap-3")}
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-11 flex-none items-center justify-center rounded-base border-2 border-border text-main-foreground",
                event.kind === "fail"
                  ? "bg-fill-err"
                  : event.kind === "back"
                    ? "bg-fill-warn"
                    : station?.finish
                      ? "bg-fill-ok"
                      : "bg-main",
              )}
            >
              <Icon
                name={
                  station?.finish
                    ? "accept"
                    : event.kind === "fail"
                      ? "failed"
                      : station
                        ? stageIcon(station)
                        : "workflows"
                }
                size={22}
              />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={LABEL}>
                {event.kind === "work"
                  ? station?.finish
                    ? "Finished"
                    : `Station ${event.at + 1} of ${walk.stations.length - 1}`
                  : "Repair loop"}
              </span>
              <span className="text-[19px] font-bold wrap-anywhere text-foreground">
                {told.title}
              </span>
            </span>
          </div>
          <p className="m-0 max-w-[760px] text-[14px] leading-relaxed text-soft-foreground">
            {told.text}
          </p>
          {onEditStation && station && !station.finish && (
            <span>
              <Button variant="secondary" size="sm" onClick={() => onEditStation(station.id)}>
                <Icon name="edit" size={13} />
                Set up {station.id}
              </Button>
            </span>
          )}
          {station && !station.finish && (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              Takes
              {(station.consumes.length ? station.consumes : ["your goal"]).map((c) => (
                <span
                  key={c}
                  className="rounded-[4px] border-2 border-border bg-background px-2 py-[1px] font-mono text-foreground"
                >
                  {c}
                </span>
              ))}
              <span aria-hidden="true">→</span> makes
              <span className="rounded-[4px] border-2 border-border bg-main px-2 py-[1px] font-mono font-bold text-main-foreground">
                {station.produces}
              </span>
            </div>
          )}
          {station?.gates?.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 border-t-2 border-[var(--line)] p-0 pt-2 text-[13px]">
              {station.gates.map((g) => (
                <li key={`${g.id}-${g.transition?.id ?? ""}`} className="flex flex-wrap gap-x-2">
                  <span className="font-mono font-semibold text-foreground">{g.id}</span>
                  <span className="text-muted-foreground">
                    {GATE_KIND[g.type ?? "unknown"]} · {g.does} ·{" "}
                    {g.mode === "required" ? "blocks" : "advises"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section
          aria-label="What happened"
          className={cn(
            PANEL,
            "flex max-h-[300px] min-w-0 flex-[1_1_280px] flex-col gap-2 overflow-auto",
          )}
        >
          <h3 className={LABEL}>What happened</h3>
          <ol className="m-0 flex list-none flex-col-reverse gap-1 p-0">
            {walk.events.slice(0, step + 1).map((e, n) => (
              <li
                // Steps are replayed in order, so the index is the step's identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: steps have no other ID
                key={n}
                className={cn(
                  "flex items-baseline gap-2 text-[13px] text-soft-foreground",
                  n === step && "font-semibold text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-[10px] flex-none rounded-full border-2 border-border",
                    e.kind === "fail"
                      ? "bg-fill-err"
                      : e.kind === "back"
                        ? "bg-fill-warn"
                        : "bg-fill-ok",
                  )}
                />
                <span className="w-6 flex-none font-mono text-[11px] text-dim-foreground">
                  {n + 1}
                </span>
                <span className="min-w-0 wrap-anywhere">{narrate(walk, e).title}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
