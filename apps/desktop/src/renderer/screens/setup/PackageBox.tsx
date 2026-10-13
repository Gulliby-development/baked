import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon.js";
import { cn } from "../../lib/cn.js";
import { BOX_SLOTS, type BoxItem, DROP_GAP_MS } from "./packages-model.js";

/** open: the flaps up, tiles hovering above; packing: the tiles drop in; closed: shut and taped. */
export type BoxPhase = "open" | "packing" | "closed";

// Geometry of the stage in px: a 180px box with tiles in two rows of three above it. Each tile
// falls to a spot inside the box, behind its front, so it disappears as it lands.
const COLS = [10, 120, 230];
const ROWS = [10, 46];
const LAND_X = [70, 0, -70];
const LAND_Y = [120, 104];
const TILT = [-8, 5, -3, 9, -6, 4];
const FLAP =
  "absolute top-[94px] h-3 w-[90px] rounded-[3px] border-2 border-border bg-main transition-transform duration-500 ease-in-out motion-reduce:transition-none";

function slots(items: BoxItem[]): { key: string; kind: BoxItem["kind"] | null; name: string }[] {
  if (items.length <= BOX_SLOTS) return items;
  const shown = items.slice(0, BOX_SLOTS - 1);
  return [...shown, { key: "more", kind: null, name: `+${items.length - shown.length} more` }];
}

/**
 * The package as a box: what it carries floats above it while the plan is shown, drops in one tile
 * at a time while it installs or packs, and the box shuts, is taped and gets `label` as its sticker.
 * Under reduced motion the tiles skip the fall and the box is simply shown shut.
 */
export function PackageBox({
  items,
  phase,
  label,
  className,
}: {
  items: BoxItem[];
  phase: BoxPhase;
  label?: string;
  className?: string;
}) {
  const closed = phase === "closed";
  const tiles = closed ? [] : slots(items);
  return (
    <div
      role="img"
      aria-label={
        closed
          ? `Packed: ${label ?? "the package"}`
          : items.length
            ? `Box with ${items.length} ${items.length === 1 ? "item" : "items"} to pack`
            : "Open box"
      }
      className={cn("relative mx-auto h-[196px] w-[340px] shrink-0 select-none", className)}
    >
      <div className="absolute top-[90px] left-[80px] h-3 w-[180px] rounded-t-[3px] border-2 border-border bg-[color-mix(in_oklab,var(--fill-accent)_62%,var(--ink))]" />
      <div
        className={cn(FLAP, "left-[80px] origin-left", closed ? "z-30" : "z-10")}
        style={{ transform: closed ? "rotate(0deg)" : "rotate(-124deg)" }}
      />
      <div
        className={cn(FLAP, "left-[170px] origin-right", closed ? "z-30" : "z-10")}
        style={{ transform: closed ? "rotate(0deg)" : "rotate(124deg)" }}
      />
      {tiles.map((item, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const position = {
          left: COLS[col],
          top: ROWS[row],
          "--dx": `${LAND_X[col]}px`,
          "--dy": `${LAND_Y[row]}px`,
          "--tilt": `${TILT[i]}deg`,
          animationDelay: `${phase === "packing" ? i * DROP_GAP_MS : i * 60}ms`,
        } as CSSProperties;
        return (
          <span
            key={item.key}
            data-tile={item.kind ?? "more"}
            className={cn(
              "absolute z-[15] w-[100px]",
              phase === "packing"
                ? "animate-pkg-drop motion-reduce:hidden"
                : "animate-rise motion-reduce:animate-none",
            )}
            style={position}
          >
            <span
              className={cn(
                "flex h-6 items-center gap-1 rounded-base border-2 border-border bg-background px-1.5 font-mono text-[11px] text-foreground shadow-sm-hard",
                phase === "open" && "animate-pkg-float motion-reduce:animate-none",
              )}
              style={{ animationDelay: `${i * 210}ms` }}
              title={item.name}
            >
              {item.kind && <Icon name={item.kind} size={12} className="shrink-0" />}
              <span className="truncate">{item.name}</span>
            </span>
          </span>
        );
      })}
      <div
        className={cn(
          "absolute top-[100px] left-[80px] z-20 flex h-[88px] w-[180px] origin-bottom items-center justify-center rounded-b-base border-2 border-border bg-main text-main-foreground shadow-shadow",
          closed && "animate-pkg-settle [animation-delay:380ms] motion-reduce:animate-none",
        )}
      >
        {!closed && <Icon name="packages" size={30} className="opacity-35" />}
      </div>
      {closed && (
        <>
          <div className="absolute top-[92px] left-[156px] z-40 h-11 w-7 origin-top animate-pkg-tape border-2 border-border bg-fill-info [animation-delay:520ms] motion-reduce:animate-none" />
          <div className="absolute top-[146px] left-[80px] z-40 flex w-[180px] justify-center">
            <span className="flex max-w-[164px] animate-pkg-stamp items-center gap-1 rounded-base border-2 border-border bg-background px-2 py-0.5 font-mono text-[11px] font-bold text-foreground shadow-sm-hard [animation-delay:760ms] motion-reduce:animate-none">
              <Icon name="ok" size={12} className="shrink-0" />
              <span className="truncate">{label}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
