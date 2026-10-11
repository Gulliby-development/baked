import type { ThemeTokens } from "../theme/tokens.js";
import {
  ansiReset,
  artPalette,
  BUN_HEIGHT,
  BUN_WIDTH,
  barCells,
  bootPose,
  bunRows,
  chipCells,
  LOCKUP_WIDTH,
  lockupRows,
  rowsToAnsi,
  SLAB_HEIGHT,
  SLAB_WIDTH,
  sgr,
  slabIntroPose,
  slabRows,
  type textCells,
} from "./bake-art.js";

/**
 * Boot splash frames. The main thread is busy importing modules during startup, so a child
 * process paints the splash; it receives every frame pre-rendered as ANSI text and only picks
 * which one to show.
 */
export interface BootSplashFrames {
  layout: "full" | "slab" | "line";
  /** 1-based screen rows of each part. */
  rows: { slab: number; bun: number; status: number; bar: number };
  cols: number;
  screenRows: number;
  slabCol: number;
  bunCol: number;
  /** Slab intro steps (one per 110 ms), the last one is the resting slab. */
  slab: string[][];
  /** Bun frames by bake level (index = round(progress * 10)), each with its steam phases. */
  bun: string[][][];
  chips: Record<"PROOFING" | "BAKING" | "READY", string>;
  chipWidth: Record<"PROOFING" | "BAKING" | "READY", number>;
  text: string;
  muted: string;
  bar: { width: number; fill: string; track: string };
  reduced: boolean;
  /** Reset that restores the theme background; also clears the screen on the first paint. */
  reset: string;
}

const LEVELS = 10;
const STEAM_PHASES = 14;
const BAR_WIDTH = 30;

export function bootSplashFrames(
  cols: number,
  rows: number,
  theme: ThemeTokens,
  options: { reduced: boolean; truecolor: boolean },
): BootSplashFrames {
  const palette = artPalette(theme);
  const base = theme.bgApp;
  const ansi = (cells: ReturnType<typeof textCells>) =>
    rowsToAnsi([cells], options.truecolor, base)[0] ?? "";
  const fits = cols >= SLAB_WIDTH + 2;
  const layout =
    fits && rows >= SLAB_HEIGHT + BUN_HEIGHT + 6
      ? "full"
      : fits && rows >= SLAB_HEIGHT + 4
        ? "slab"
        : "line";
  const height =
    layout === "full" ? SLAB_HEIGHT + BUN_HEIGHT + 5 : layout === "slab" ? SLAB_HEIGHT + 3 : 2;
  const top = Math.max(1, Math.floor((rows - height) / 2) + 1);
  const slabRow = top;
  const bunRow = top + SLAB_HEIGHT + 1;
  const statusRow =
    layout === "full" ? bunRow + BUN_HEIGHT + 1 : layout === "slab" ? top + SLAB_HEIGHT + 1 : top;

  // The oven logo sits beside the wordmark when the terminal is wide enough.
  const lockup = cols >= LOCKUP_WIDTH + 2;
  const slab: string[][] = [];
  if (layout !== "line") {
    const last = options.reduced ? 0 : 10;
    for (let step = 0; step <= last; step++) {
      const pose = options.reduced ? { letters: 5, pressed: false } : slabIntroPose(step * 110);
      const art = lockup ? lockupRows(pose, palette) : slabRows(pose, palette);
      slab.push(rowsToAnsi(art, options.truecolor, base));
    }
  }

  const bun: string[][][] = [];
  if (layout === "full") {
    for (let level = 0; level <= LEVELS; level++) {
      const progress = Math.min(level / LEVELS, 0.99);
      const phases: string[][] = [];
      const animated = !options.reduced && bootPose(progress, 0).steam !== null;
      for (let phase = 0; phase < (animated ? STEAM_PHASES : 1); phase++) {
        const pose = bootPose(progress, phase * 300 * 0.5);
        if (!animated) pose.steam = null;
        phases.push(rowsToAnsi(bunRows(pose, palette), options.truecolor, base));
      }
      bun.push(phases);
    }
  }

  const chip = (stage: "PROOFING" | "BAKING" | "READY") =>
    chipCells(
      stage,
      stage === "READY" ? theme.success : palette.fill,
      palette.onFill,
      palette.shadow,
    );
  const stages = ["PROOFING", "BAKING", "READY"] as const;
  return {
    layout,
    rows: { slab: slabRow, bun: bunRow, status: statusRow, bar: statusRow + 1 },
    cols,
    screenRows: rows,
    slabCol: Math.max(1, Math.floor((cols - (lockup ? LOCKUP_WIDTH : SLAB_WIDTH)) / 2) + 1),
    bunCol: Math.max(1, Math.floor((cols - BUN_WIDTH) / 2) + 1),
    slab,
    bun,
    chips: Object.fromEntries(
      stages.map((stage) => [stage, ansi(chip(stage))]),
    ) as BootSplashFrames["chips"],
    chipWidth: Object.fromEntries(
      stages.map((stage) => [stage, chip(stage).length]),
    ) as BootSplashFrames["chipWidth"],
    text: sgr(theme.textSecondary, false, options.truecolor),
    muted: sgr(theme.textMuted, false, options.truecolor),
    bar: {
      width: Math.min(BAR_WIDTH, Math.max(8, cols - 10)),
      fill: ansi(barCells(1, 1, palette.fill, theme.textFaint)),
      track: ansi(barCells(0, 1, palette.fill, theme.textFaint)),
    },
    reduced: options.reduced,
    reset: ansiReset(base, options.truecolor),
  };
}

/**
 * The painter that runs in the child process. It reads the frames as the first stdin line, then
 * `[progress, ...messages]` lines, and `EXIT`. Plain JavaScript: it runs under `bun -e`.
 */
export const BOOT_SPLASH_PAINTER = String.raw`
const at = (r, c) => "\x1b[" + r + ";" + c + "H";
let F = null;
let target = 0, shown = 0, msgs = ["Starting"], msgIdx = 0, msgSetAt = Date.now();
let last = "";
const start = Date.now();
process.stdin.setEncoding("utf-8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line === "EXIT") process.exit(0);
    try {
      const data = JSON.parse(line);
      if (!F) { F = data; clear(); paint(true); continue; }
      target = Math.max(target, Number(data[0]) || 0);
      msgs = data.slice(1).length ? data.slice(1) : msgs;
      msgIdx = 0; msgSetAt = Date.now();
    } catch {}
  }
});
// Paints every cell, since not every terminal fills a cleared screen with the current colour.
function clear() {
  let out = F.reset;
  for (let r = 1; r <= F.screenRows; r++) out += at(r, 1) + " ".repeat(F.cols);
  process.stdout.write(out);
}
// Same thresholds as bakeStage() in bake-art.ts.
function stage(p) { return p >= 1 ? "READY" : p < 0.4 ? "PROOFING" : "BAKING"; }
function paint(force) {
  if (!F) return;
  const now = Date.now();
  shown = F.reduced ? target : shown + (target - shown) * 0.3;
  if (target - shown < 0.005) shown = target;
  if (msgs.length > 1 && now - msgSetAt > 1400) { msgIdx = (msgIdx + 1) % msgs.length; msgSetAt = now; }
  const msg = msgs[msgIdx % msgs.length] || "";
  const slabStep = Math.min(F.slab.length - 1, Math.floor((now - start) / 110));
  const level = Math.round(shown * 10);
  const phases = F.bun[level] || [];
  const phase = phases.length ? Math.floor((now - start) / 150) % phases.length : 0;
  const key = slabStep + "|" + level + "|" + phase + "|" + msg + "|" + Math.round(shown * 100);
  if (!force && key === last) return;
  last = key;
  let out = "";
  if (F.slab.length) F.slab[slabStep].forEach((line, i) => { out += at(F.rows.slab + i, F.slabCol) + line; });
  if (phases.length) phases[phase].forEach((line, i) => { out += at(F.rows.bun + i, F.bunCol) + line; });
  const s = stage(shown);
  const text = "  " + msg;
  const width = F.chipWidth[s] + text.length;
  out += F.reset + at(F.rows.status, 1) + "\x1b[2K" + at(F.rows.status, Math.max(1, Math.floor((F.cols - width) / 2) + 1));
  out += F.chips[s] + F.text + text + F.reset;
  const done = Math.round(shown * F.bar.width);
  const pct = String(Math.round(shown * 100)).padStart(3) + "%";
  out += at(F.rows.bar, Math.max(1, Math.floor((F.cols - F.bar.width - 5) / 2) + 1));
  out += F.bar.fill.repeat(done) + F.bar.track.repeat(F.bar.width - done) + F.muted + " " + pct + F.reset;
  process.stdout.write(out);
}
setInterval(() => paint(false), 100);
`;
