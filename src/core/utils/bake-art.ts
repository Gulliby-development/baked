/**
 * Pixel art for the BAKED terminal brand: the wordmark slab and the bun mascot.
 *
 * Art is drawn on a pixel grid and printed with half blocks, so each terminal cell carries two
 * square pixels (top in the foreground colour of "▀", bottom in its background). Every glyph is
 * in CP437, which keeps the art intact in Windows consoles and fonts without the Runic block.
 * The style follows the desktop's neobrutalism: flat colour blocks, no gradients, and a hard
 * shadow offset one pixel down and right.
 */

/** A pixel colour as `#rrggbb`, or null for a transparent pixel. */
export type Pixel = string | null;
export type PixelGrid = Pixel[][];

/** One terminal cell. A missing background leaves the terminal's own background visible. */
export interface ArtCell {
  ch: string;
  fg?: string;
  bg?: string;
}
export type ArtRows = ArtCell[][];

export interface ArtPalette {
  /** Colour-block fill: the wordmark slab. */
  fill: string;
  /** Text and lines drawn on a fill, and the mascot's eyes. */
  onFill: string;
  /** Hard offset shadow. */
  shadow: string;
  steam: string;
  cheek: string;
  /** Crust ramp from raw dough to fully baked. */
  crust: readonly string[];
  /** Darker underside matching each crust stop. */
  base: readonly string[];
  /** Crumb showing through the scores. */
  crumb: string;
}

const CRUST = ["#f4e4c8", "#f2cf8e", "#eab063", "#df8f42", "#c9742f"] as const;
const BASE = ["#e3cba3", "#dcae66", "#c88a45", "#b8672a", "#a0541f"] as const;

/** Palette for a theme; `light` picks ink shadows, a dark theme gets a warm dark shadow. */
export function artPalette(
  theme: { brand: string; brandDim: string; textMuted: string; bgApp: string },
  light = isLightColor(theme.bgApp),
): ArtPalette {
  return {
    fill: light ? "#ff9d52" : theme.brand,
    onFill: light ? "#302015" : "#191410",
    shadow: light ? "#302015" : theme.brandDim,
    steam: theme.textMuted,
    cheek: "#ff8e86",
    crust: CRUST,
    base: BASE,
    crumb: "#fff1d6",
  };
}

export function isLightColor(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

// ── Grid helpers ────────────────────────────────────────────────────

export function emptyGrid(width: number, height: number): PixelGrid {
  return Array.from({ length: height }, () => Array<Pixel>(width).fill(null));
}

function put(grid: PixelGrid, x: number, y: number, color: string): void {
  const row = grid[y];
  if (row && x >= 0 && x < row.length) row[x] = color;
}

/** Adds the hard shadow: every filled pixel casts one at (+dx, +dy) where nothing is drawn. */
export function withShadow(grid: PixelGrid, color: string, dx = 1, dy = 1): PixelGrid {
  const out = grid.map((row) => [...row]);
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[y]?.length ?? 0); x++) {
      if (grid[y]?.[x] && !grid[y + dy]?.[x + dx]) put(out, x + dx, y + dy, color);
    }
  }
  return out;
}

/** Prints a pixel grid as half-block cells; an odd last row gets a transparent pixel below. */
export function toCells(grid: PixelGrid): ArtRows {
  const rows: ArtRows = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? [];
    const bottom = grid[y + 1] ?? [];
    const width = Math.max(top.length, bottom.length);
    const row: ArtCell[] = [];
    for (let x = 0; x < width; x++) {
      const up = top[x] ?? null;
      const down = bottom[x] ?? null;
      if (!up && !down) row.push({ ch: " " });
      else if (up && !down) row.push({ ch: "▀", fg: up });
      else if (!up && down) row.push({ ch: "▄", fg: down });
      else if (up === down) row.push({ ch: "█", fg: up ?? undefined });
      else row.push({ ch: "▀", fg: up ?? undefined, bg: down ?? undefined });
    }
    rows.push(row);
  }
  return rows;
}

export function textCells(text: string, fg?: string, bg?: string): ArtCell[] {
  return [...text].map((ch) => ({ ch, fg, bg }));
}

/** Pads every row with transparent cells so the block is `width` wide and centred. */
export function centerRows(rows: ArtRows, width: number): ArtRows {
  return rows.map((row) => {
    const left = Math.max(0, Math.floor((width - row.length) / 2));
    const padded = [...Array.from({ length: left }, () => ({ ch: " " })), ...row];
    while (padded.length < width) padded.push({ ch: " " });
    return padded.slice(0, Math.max(width, row.length));
  });
}

export function rowsWidth(rows: ArtRows): number {
  return Math.max(0, ...rows.map((row) => row.length));
}

// ── Wordmark slab ───────────────────────────────────────────────────

const LETTERS: Record<string, readonly string[]> = {
  B: ["111110", "110011", "110011", "111110", "110011", "110011", "111110"],
  A: ["011110", "110011", "110011", "111111", "110011", "110011", "110011"],
  K: ["110011", "110110", "111100", "111000", "111100", "110110", "110011"],
  E: ["111111", "110000", "110000", "111110", "110000", "110000", "111111"],
  D: ["111110", "110011", "110011", "110011", "110011", "110011", "111110"],
};
const WORD = "BAKED";
const LETTER_W = 6;
const PAD_X = 3;

export interface SlabPose {
  /** How many letters are stamped in, 0 to 5. */
  letters: number;
  /** A pressed slab sits on its shadow, like a neobrutalist button being pushed. */
  pressed: boolean;
}

/** Cell size of the wordmark slab including its shadow. */
export const SLAB_WIDTH = WORD.length * LETTER_W + (WORD.length - 1) + PAD_X * 2 + 1;
export const SLAB_HEIGHT = 5;

/** The BAKED wordmark: dark pixel letters stamped on a flat orange block with a hard shadow. */
export function slabRows(pose: SlabPose, palette: ArtPalette): ArtRows {
  const inner = SLAB_WIDTH - 1;
  const grid = emptyGrid(SLAB_WIDTH, SLAB_HEIGHT * 2);
  const shift = pose.pressed ? 1 : 0;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < inner; x++) put(grid, x + shift, y + shift, palette.fill);
  }
  [...WORD].slice(0, Math.max(0, Math.min(WORD.length, pose.letters))).forEach((letter, index) => {
    const left = PAD_X + index * (LETTER_W + 1);
    (LETTERS[letter] ?? []).forEach((line, row) => {
      [...line].forEach((bit, column) => {
        if (bit === "1") put(grid, left + column + shift, 1 + row + shift, palette.onFill);
      });
    });
  });
  return toCells(pose.pressed ? grid : withShadow(grid, palette.shadow));
}

// ── Oven logo ───────────────────────────────────────────────────────

/** Window colour of the oven logo; the same in both themes, as in the logo SVG. */
const OVEN_WINDOW = "#191410";
const OVEN_W = 16;
const OVEN_H = 9;
const OVEN_GAP = 2;
const KNOB = "#fff4e5";

/** Cell size of the oven logo including its shadow. */
export const OVEN_WIDTH = OVEN_W + 1;
/** Cell width of the oven and the wordmark slab side by side. */
export const LOCKUP_WIDTH = OVEN_WIDTH + OVEN_GAP + SLAB_WIDTH;

/**
 * The BAKED logo, after the oven app icon: an orange body with two knobs and a dial on the
 * control strip, and a dark window holding a `>_` prompt.
 */
export function ovenPixels(pressed: boolean, palette: ArtPalette): PixelGrid {
  const grid = emptyGrid(OVEN_W + 1, SLAB_HEIGHT * 2);
  const s = pressed ? 1 : 0;
  for (let y = 0; y < OVEN_H; y++) {
    for (let x = 0; x < OVEN_W; x++) {
      const corner = (y === 0 || y === OVEN_H - 1) && (x === 0 || x === OVEN_W - 1);
      if (!corner) put(grid, x + s, y + s, palette.fill);
    }
  }
  put(grid, 2 + s, 1 + s, KNOB);
  put(grid, 4 + s, 1 + s, KNOB);
  for (let x = 9; x <= 13; x++) put(grid, x + s, 1 + s, palette.onFill);
  for (let x = 1; x < OVEN_W - 1; x++) put(grid, x + s, 2 + s, palette.onFill);
  for (let y = 3; y <= 7; y++) {
    for (let x = 2; x <= 13; x++) put(grid, x + s, y + s, OVEN_WINDOW);
  }
  for (const [x, y] of [
    [4, 4],
    [5, 5],
    [4, 6],
    [7, 6],
    [8, 6],
    [9, 6],
  ] as const) {
    put(grid, x + s, y + s, palette.fill);
  }
  return pressed ? grid : withShadow(grid, palette.shadow);
}

export function ovenRows(pressed: boolean, palette: ArtPalette): ArtRows {
  return toCells(ovenPixels(pressed, palette));
}

/** The oven logo beside the stamped wordmark; both press together while the letters land. */
export function lockupRows(pose: SlabPose, palette: ArtPalette): ArtRows {
  const oven = ovenRows(pose.pressed, palette);
  const slab = slabRows(pose, palette);
  return slab.map((row, index) => [
    ...(oven[index] ?? []),
    ...Array.from({ length: OVEN_GAP }, () => ({ ch: " " })),
    ...row,
  ]);
}

/**
 * The oven mark for one-line places such as the header: orange body, dark window, `>` prompt.
 */
export function ovenMarkCells(palette: ArtPalette): ArtCell[] {
  return [
    { ch: " ", bg: palette.fill },
    { ch: ">", fg: palette.fill, bg: OVEN_WINDOW },
    ...textCells(" BAKED ", palette.onFill, palette.fill),
  ];
}

/** The header's brand chip: the oven mark with a one-cell hard shadow. */
export function brandChipCells(palette: ArtPalette): ArtCell[] {
  return [...ovenMarkCells(palette), { ch: "▌", fg: palette.shadow }];
}

// ── Bun mascot ──────────────────────────────────────────────────────

export type BunFace = "none" | "sleep" | "open" | "blink" | "left" | "right" | "focus" | "happy";

export interface BunPose {
  /** 0 raw dough to 1 fully baked; picks the crust colour. */
  bake: number;
  /** 0 flat dough to 1 risen; sets the dome height and width. */
  rise: number;
  face: BunFace;
  /** Steam phase, or null for no steam. */
  steam: number | null;
}

/** Cell size of the mascot including steam rows and shadow. */
export const BUN_WIDTH = 26;
export const BUN_HEIGHT = 8;
const BUN_PX_H = BUN_HEIGHT * 2;
const BUN_BASE_Y = BUN_PX_H - 2;

/** The bun: a flat, boxy loaf with three scores, a face and steam, over its hard shadow. */
export function bunRows(pose: BunPose, palette: ArtPalette): ArtRows {
  return toCells(bunPixels(pose, palette));
}

export function bunPixels(pose: BunPose, palette: ArtPalette): PixelGrid {
  const grid = emptyGrid(BUN_WIDTH, BUN_PX_H);
  const rise = clamp01(pose.rise);
  const stop = Math.round(clamp01(pose.bake) * (palette.crust.length - 1));
  const crust = palette.crust[stop] ?? palette.crust[0] ?? "#f2cf8e";
  const base = palette.base[stop] ?? crust;
  const cx = (BUN_WIDTH - 2) / 2 - 0.5;
  const rx = 10 + rise * 2;
  const dome = Math.round(6 + rise * 4);
  const tops: number[] = [];
  for (let x = 0; x < BUN_WIDTH - 1; x++) {
    const dx = Math.abs(x - cx) / rx;
    if (dx > 1) {
      tops.push(BUN_PX_H);
      continue;
    }
    // A superellipse keeps the loaf boxy rather than round, which reads better as flat art.
    const height = Math.round(dome * (1 - dx ** 3) ** (1 / 3));
    const top = BUN_BASE_Y - height + 1;
    tops.push(top);
    for (let y = top; y <= BUN_BASE_Y; y++) put(grid, x, y, y >= BUN_BASE_Y - 1 ? base : crust);
  }

  // Scores: three short diagonal cuts across the top, opening as the dough rises.
  const top = BUN_BASE_Y - dome + 1;
  const length = rise > 0.5 ? 3 : 2;
  const eyeY = BUN_BASE_Y - Math.round(dome * 0.42);
  for (const offset of [-6, 0, 6]) {
    const x0 = Math.round(cx + offset - 1);
    const span = tops.slice(x0, x0 + length);
    const y0 = Math.max(top, ...span) + 1;
    if (pose.face !== "none" && y0 + length > eyeY - 1) continue;
    for (let i = 0; i < length; i++) put(grid, x0 + i, y0 + (length - 1 - i), palette.crumb);
  }

  drawFace(grid, pose.face, Math.round(cx), eyeY, palette);
  const shaded = withShadow(grid, palette.shadow);
  if (pose.steam !== null) drawSteam(shaded, pose.steam, cx, top - 1, palette.steam);
  return shaded;
}

function drawFace(grid: PixelGrid, face: BunFace, cx: number, y: number, palette: ArtPalette) {
  if (face === "none") return;
  const ink = palette.onFill;
  const look = face === "left" ? -1 : face === "right" ? 1 : 0;
  for (const side of [-1, 1]) {
    const x = cx + side * 4 + (side > 0 ? 0 : -1) + look;
    if (face === "open" || face === "left" || face === "right") {
      put(grid, x, y - 1, ink);
      put(grid, x, y, ink);
    } else if (face === "happy") {
      put(grid, x - 1, y, ink);
      put(grid, x, y - 1, ink);
      put(grid, x + 1, y, ink);
    } else if (face === "focus") {
      put(grid, x - 1, y, ink);
      put(grid, x, y, ink);
    } else {
      // sleep and blink: a closed lid.
      put(grid, x - 1, y, ink);
      put(grid, x, y, ink);
      put(grid, x + 1, y, ink);
    }
    put(grid, cx + side * 7 + (side > 0 ? 0 : -1), y + 1, palette.cheek);
  }
  if (face === "happy" || face === "open" || face === "left" || face === "right") {
    put(grid, cx - 1, y + 2, ink);
    put(grid, cx, y + 2, ink);
  }
}

function drawSteam(grid: PixelGrid, phase: number, cx: number, top: number, color: string) {
  [-6, 0, 6].forEach((offset, index) => {
    for (let k = 0; k < 2; k++) {
      const travel = (phase + index * 1.7 + k * 2) % 4;
      const y = Math.round(top - travel);
      const x = Math.round(cx + offset + Math.sin(phase * 0.9 + index * 2 + k) * 1.2);
      if (y >= 0 && !grid[y]?.[x]) put(grid, x, y, color);
    }
  });
}

// ── Chips and bars ──────────────────────────────────────────────────

/** A filled label block with a one-cell hard shadow on its right: ` BAKING `▌ */
export function chipCells(label: string, fill: string, onFill: string, shadow?: string): ArtCell[] {
  const cells = textCells(` ${label} `, onFill, fill);
  if (shadow) cells.push({ ch: "▌", fg: shadow });
  return cells;
}

const DARK_INK = "#191410";
const LIGHT_INK = "#fff4e5";

/** Text colour that stays readable on a chip filled with `fill`, in either theme. */
export function inkOn(fill: string): string {
  return isLightColor(fill) ? DARK_INK : LIGHT_INK;
}

/** A chunky progress bar: filled blocks for done, light shade for the rest. */
export function barCells(progress: number, width: number, fill: string, track: string): ArtCell[] {
  const done = Math.round(clamp01(progress) * width);
  return [...textCells("█".repeat(done), fill), ...textCells("░".repeat(width - done), track)];
}

// ── Colour ──────────────────────────────────────────────────────────

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) || 0) as [
    number,
    number,
    number,
  ];
}

/** Whether the terminal can show 24-bit colour; otherwise colours go to the 256-colour cube. */
export function supportsTruecolor(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
) {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return true;
  if (env.WT_SESSION || env.TERM_PROGRAM || env.KITTY_WINDOW_ID || env.WEZTERM_PANE) return true;
  if ((env.TERM ?? "").includes("direct") || (env.TERM ?? "").includes("truecolor")) return true;
  return platform === "win32";
}

function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

/** ANSI SGR sequence setting `hex` as the foreground or background colour. */
export function sgr(hex: string, background: boolean, truecolor: boolean): string {
  if (!truecolor) return `\x1b[${background ? 48 : 38};5;${to256(hex)}m`;
  const [r, g, b] = rgb(hex);
  return `\x1b[${background ? 48 : 38};2;${r};${g};${b}m`;
}

/** ANSI reset that keeps `base` as the background, so a themed screen stays painted. */
export function ansiReset(base: string | undefined, truecolor = true): string {
  return `\x1b[0m${base?.startsWith("#") ? sgr(base, true, truecolor) : ""}`;
}

/**
 * Prints rows as ANSI lines, emitting a colour only when it changes. Cells without a
 * background get `base` (the theme background) when given, else the terminal's own.
 */
export function rowsToAnsi(rows: ArtRows, truecolor = true, base?: string): string[] {
  const reset = ansiReset(base, truecolor);
  return rows.map((row) => {
    let out = "";
    let fg: string | undefined;
    let bg: string | undefined;
    let first = true;
    for (const cell of row) {
      if (first || cell.fg !== fg || cell.bg !== bg) {
        out += reset;
        if (cell.fg) out += sgr(cell.fg, false, truecolor);
        if (cell.bg) out += sgr(cell.bg, true, truecolor);
        fg = cell.fg;
        bg = cell.bg;
        first = false;
      }
      out += cell.ch;
    }
    return `${out}${reset}`;
  });
}

// ── Timelines ───────────────────────────────────────────────────────

/** Frame interval for every brand animation: five frames a second is enough for pixel art. */
export const BAKE_ART_TICK_MS = 200;
const IDLE_LOOP_MS = 14_000;

/** The awake bun on the main screen: blinks, glances at the input, smiles, steams. */
export function idlePose(elapsedMs: number): BunPose {
  const t = elapsedMs % IDLE_LOOP_MS;
  let face: BunFace = "open";
  if (t % 4000 >= 3800) face = "blink";
  else if (t >= 6000 && t < 7200) face = "left";
  else if (t >= 8400 && t < 9400) face = "right";
  else if (t >= 11_000 && t < 12_600) face = "happy";
  return { bake: 1, rise: 1, face, steam: elapsedMs / 450 };
}

/** The bun while the agent works: a focused face and faster steam. */
export function busyPose(elapsedMs: number): BunPose {
  return {
    bake: 1,
    rise: 1,
    face: elapsedMs % 3000 >= 2800 ? "blink" : "focus",
    steam: elapsedMs / 220,
  };
}

/** Boot: sleeping dough that rises first and browns as startup progresses. */
export function bootPose(progress: number, elapsedMs: number): BunPose {
  const p = clamp01(progress);
  return {
    bake: clamp01((p - 0.2) / 0.8),
    rise: clamp01(p * 1.6),
    face: p >= 1 ? "open" : "sleep",
    steam: p > 0.7 ? elapsedMs / 300 : null,
  };
}

/** Letters stamp in one at a time; each stamp presses the slab onto its shadow for one frame. */
export function slabIntroPose(elapsedMs: number): SlabPose {
  const step = Math.floor(elapsedMs / 110);
  const letters = Math.min(WORD.length, Math.floor(step / 2) + 1);
  return { letters, pressed: step < WORD.length * 2 && step % 2 === 0 };
}

/** Status chip for a boot or busy phase. */
export function bakeStage(progress: number): "PROOFING" | "BAKING" | "READY" {
  return progress >= 1 ? "READY" : progress < 0.4 ? "PROOFING" : "BAKING";
}
