import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { LineLoop } from "../../client/start.js";
import { cn } from "../../lib/cn.js";
import { type Handoff, handoff, loopText, type Station, TYPE_LABEL } from "./line-model.js";

/**
 * The run as a conveyor: stations in a row over a belt, the contract each one makes under its
 * name, and lanes under the belt for the loops that send work back. When a stage finishes, its
 * contract rides the belt to the next station; when a loop restarts an earlier stage, the carried
 * contract travels back along that loop's lane.
 */

const W = 108;
const GAP = 10;
const STATION_H = 88;
const BELT_Y = 98;
const BELT_H = 16;
const LANE_Y = BELT_Y + BELT_H + 22;
const LANE_STEP = 30;
const TRAY_W = 70;

const left = (i: number): number => i * (W + GAP);
const center = (i: number): number => left(i) + W / 2;

const STATION_BASE =
  "absolute top-0 flex h-[88px] w-[108px] cursor-pointer flex-col gap-[2px] rounded-base border-2 border-border px-2 py-[6px] text-left [font:inherit] shadow-sm-hard transition-[background-color,transform] duration-200 hover:-translate-y-[2px] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none";
const STATION_STATE: Record<Station["state"], string> = {
  pending: "bg-background text-foreground",
  current: "bg-main text-main-foreground shadow-shadow",
  waiting: "bg-fill-warn text-main-foreground animate-nudge motion-reduce:animate-none",
  done: "bg-fill-ok text-main-foreground",
  failed: "bg-fill-err text-main-foreground",
  skipped: "border-dashed bg-raised text-dim-foreground line-through",
};

function ContractBar({ station }: { station: Station }) {
  const forming = station.state === "current";
  const made = station.state === "done";
  return (
    <span
      className="h-[6px] min-w-[18px] flex-1 overflow-hidden rounded-[3px] border-[1.5px] border-border bg-[var(--bg-sunken)]"
      aria-hidden="true"
    >
      <span
        className={cn(
          "block h-full",
          made && "w-full bg-fill-info",
          forming &&
            "w-full animate-forming bg-[repeating-linear-gradient(90deg,var(--fill-info)_0_8px,transparent_8px_16px)] bg-[length:16px_100%] motion-reduce:animate-none",
          !made && !forming && "w-0",
        )}
      />
    </span>
  );
}

function stateText(station: Station): string {
  if (station.state === "current") return "working";
  if (station.state === "waiting") return "needs you";
  return station.state;
}

export function Conveyor({
  stations,
  loops,
  selected,
  running,
  onSelect,
}: {
  stations: Station[];
  loops: LineLoop[];
  selected: string;
  /** The run is executing, so the belt rolls. */
  running: boolean;
  onSelect: (id: string) => void;
}) {
  const index = new Map(stations.map((s, i) => [s.id, i]));
  // Loops drawn under the belt, deepest for the longest, skipping loops onto the same station.
  const lanes = loops
    .filter((l) => l.from !== l.to && index.has(l.from) && index.has(l.to))
    .sort(
      (a, b) =>
        (index.get(a.from) ?? 0) -
        (index.get(a.to) ?? 0) -
        ((index.get(b.from) ?? 0) - (index.get(b.to) ?? 0)),
    );
  const laneY = (i: number): number => LANE_Y + i * LANE_STEP;
  const width = left(stations.length - 1) + W;
  const height = lanes.length ? laneY(lanes.length - 1) + 20 : BELT_Y + BELT_H + 6;

  const previous = useRef<Station[] | null>(null);
  const [tray, setTray] = useState<(Handoff & { key: number }) | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = stations;
    if (!before) return;
    const moved = handoff(before, stations, loops);
    if (moved) setTray({ ...moved, key: Date.now() });
  }, [stations, loops]);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector(`[data-station="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  const trayKey = tray?.key;
  const trayKind = tray?.kind;
  useEffect(() => {
    if (trayKey === undefined) return;
    const timer = setTimeout(() => setTray(null), trayKind === "repair" ? 1900 : 1200);
    return () => clearTimeout(timer);
  }, [trayKey, trayKind]);

  const trayLane =
    tray?.kind === "repair"
      ? lanes.findIndex((l) => l.from === stations[tray.from]?.id && l.to === stations[tray.to]?.id)
      : -1;
  const trayStyle = tray
    ? ({
        "--tray-from": `${center(tray.from) - TRAY_W / 2}px`,
        "--tray-to": `${center(tray.to) - TRAY_W / 2}px`,
        "--tray-drop": `${(trayLane >= 0 ? laneY(trayLane) : LANE_Y) - BELT_Y}px`,
        top: BELT_Y - 4,
        width: TRAY_W,
      } as CSSProperties)
    : undefined;

  return (
    <div ref={strip} className="overflow-x-auto pb-2">
      <div className="relative m-1" style={{ width, height }}>
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={width}
          height={height}
          aria-hidden="true"
        >
          {lanes.map((loop, i) => {
            const from = index.get(loop.from) ?? 0;
            const to = index.get(loop.to) ?? 0;
            const hot = trayLane === i;
            // The label sits left of the lane, clear of other lanes' verticals, when it fits.
            const labelLeft = center(to) > 240;
            return (
              <g key={`${loop.from}-${loop.to}-${loop.on}`}>
                <path
                  d={`M${center(from)} ${BELT_Y + BELT_H} V${laneY(i)} H${center(to)} V${BELT_Y + BELT_H}`}
                  fill="none"
                  strokeDasharray="6 5"
                  className={cn(
                    hot
                      ? "animate-lane stroke-[var(--err)] stroke-[3] motion-reduce:animate-none"
                      : "stroke-[var(--line-strong)] stroke-2",
                  )}
                />
                <text
                  x={labelLeft ? center(to) - 8 : center(from) + 8}
                  y={laneY(i) + 4}
                  textAnchor={labelLeft ? "end" : "start"}
                  className={cn(
                    "font-mono text-[11px] font-semibold",
                    hot ? "fill-[var(--err)]" : "fill-[var(--text-3)]",
                  )}
                >
                  {loopText(loop, stations[from]?.label ?? loop.from)}
                </text>
              </g>
            );
          })}
        </svg>
        <div
          className={cn(
            "absolute inset-x-0 rounded-[9px] border-2 border-border bg-[repeating-linear-gradient(90deg,var(--bg-sunken)_0_14px,var(--line)_14px_18px)] bg-[length:18px_100%]",
            running && "animate-belt motion-reduce:animate-none",
          )}
          style={{ top: BELT_Y, height: BELT_H }}
          aria-hidden="true"
        />
        <ol className="m-0 list-none p-0" aria-label="Stages">
          {stations.map((station, i) => (
            <li key={station.id}>
              <button
                type="button"
                className={cn(
                  STATION_BASE,
                  STATION_STATE[station.state],
                  station.type === "finish" && station.state === "pending" && "border-dashed",
                  station.id === selected && "outline-3 outline-offset-3 outline-[var(--text)]",
                )}
                style={{ left: left(i), height: STATION_H }}
                data-station={station.id}
                aria-pressed={station.id === selected}
                aria-current={
                  station.state === "current" || station.state === "waiting" ? "step" : undefined
                }
                onClick={() => onSelect(station.id)}
              >
                <span className="truncate text-[13px] font-bold">{station.label}</span>
                <span className="font-mono text-[11px] opacity-80">
                  {TYPE_LABEL[station.type]}
                  {station.round > 1 ? ` · round ${station.round}` : ""}
                </span>
                <span className="mt-auto flex items-center gap-1 font-mono text-[10.5px] font-semibold">
                  <span className="truncate">{station.produces ?? "result"}</span>
                  {station.produces && <ContractBar station={station} />}
                </span>
                <span className="sr-only">, {stateText(station)}</span>
              </button>
            </li>
          ))}
        </ol>
        {tray && (
          <div
            key={tray.key}
            className={cn(
              "absolute left-0 z-[2] flex items-center justify-center gap-1 truncate rounded-[4px] border-2 border-border px-1 py-[1px] font-mono text-[11px] font-bold text-main-foreground shadow-sm-hard motion-reduce:hidden",
              tray.kind === "repair"
                ? "animate-tray-back bg-fill-err"
                : "animate-tray bg-fill-info",
            )}
            style={trayStyle}
            aria-hidden="true"
          >
            {tray.contract}
          </div>
        )}
      </div>
    </div>
  );
}
