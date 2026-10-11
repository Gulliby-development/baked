import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { busyLine, meterCells } from "../src/components/layout/LoadingStatus.js";
import { LandingPage } from "../src/components/layout/LandingPage.js";
import { DARK_THEME, LIGHT_THEME } from "../src/core/theme/tokens.js";
import {
  artPalette,
  bootPose,
  BUN_HEIGHT,
  BUN_WIDTH,
  type BunFace,
  bunRows,
  idlePose,
  LOCKUP_WIDTH,
  lockupRows,
  ovenMarkCells,
  rowsToAnsi,
  SLAB_HEIGHT,
  SLAB_WIDTH,
  slabIntroPose,
  slabRows,
  supportsTruecolor,
} from "../src/core/utils/bake-art.js";
import { BOOT_SPLASH_PAINTER, bootSplashFrames } from "../src/core/utils/boot-splash.js";
import { envReducedMotion, getMotion, setMotion } from "../src/core/utils/motion.js";

const ART_GLYPHS = new Set([" ", "▀", "▄", "█"]);
const FACES: BunFace[] = ["none", "sleep", "open", "blink", "left", "right", "focus", "happy"];

afterEach(() => setMotion("full"));

for (const [name, theme] of [["dark", DARK_THEME], ["light", LIGHT_THEME]] as const) {
  const palette = artPalette(theme);

  test(`bun fits its box in every face and stage (${name})`, () => {
    for (const face of FACES) {
      for (const bake of [0, 0.5, 1]) {
        const rows = bunRows({ bake, rise: bake, face, steam: bake > 0.7 ? 2.5 : null }, palette);
        expect(rows).toHaveLength(BUN_HEIGHT);
        for (const row of rows) {
          expect(row).toHaveLength(BUN_WIDTH);
          for (const cell of row) expect(ART_GLYPHS.has(cell.ch)).toBe(true);
        }
      }
    }
  });

  test(`wordmark slab stamps letters in and casts a shadow (${name})`, () => {
    const rest = slabRows({ letters: 5, pressed: false }, palette);
    expect(rest).toHaveLength(SLAB_HEIGHT);
    expect(rest.every((row) => row.length === SLAB_WIDTH)).toBe(true);
    // The shadow fills the right-most column below the first row; a pressed slab covers it.
    const shadowColumn = (rows: typeof rest) => rows.slice(1).map((row) => row.at(-1)?.fg ?? row.at(-1)?.bg);
    expect(shadowColumn(rest).every((colour) => colour === palette.shadow)).toBe(true);
    expect(shadowColumn(slabRows({ letters: 5, pressed: true }, palette))).toContain(palette.fill);
    const ink = (rows: typeof rest) => rows.flat().filter((c) => c.fg === palette.onFill || c.bg === palette.onFill).length;
    expect(ink(slabRows({ letters: 0, pressed: true }, palette))).toBe(0);
    expect(ink(rest)).toBeGreaterThan(ink(slabRows({ letters: 2, pressed: false }, palette)));
  });
}

test("oven logo sits beside the wordmark and marks one-line places", () => {
  const palette = artPalette(DARK_THEME);
  const rows = lockupRows({ letters: 5, pressed: false }, palette);
  expect(rows).toHaveLength(SLAB_HEIGHT);
  expect(rows.every((row) => row.length === LOCKUP_WIDTH)).toBe(true);
  expect(rows.flat().every((cell) => ART_GLYPHS.has(cell.ch))).toBe(true);
  expect(ovenMarkCells(palette).map((cell) => cell.ch).join("")).toBe(" > BAKED ");
  expect(bootSplashFrames(LOCKUP_WIDTH + 2, 24, DARK_THEME, { reduced: true, truecolor: true }).slabCol).toBe(2);
});

test("timelines: the slab finishes stamping and the dough bakes with progress", () => {
  expect(slabIntroPose(0)).toEqual({ letters: 1, pressed: true });
  expect(slabIntroPose(5000)).toEqual({ letters: 5, pressed: false });
  expect(bootPose(0, 0)).toMatchObject({ bake: 0, rise: 0, face: "sleep", steam: null });
  expect(bootPose(1, 0)).toMatchObject({ bake: 1, rise: 1, face: "open" });
  expect(idlePose(0).face).toBe("open");
  expect(idlePose(3900).face).toBe("blink");
});

test("colour falls back to the 256-colour cube without truecolor", () => {
  const rows = bunRows(idlePose(0), artPalette(DARK_THEME));
  expect(rowsToAnsi(rows, true).join("")).toContain("38;2;");
  const fallback = rowsToAnsi(rows, false).join("");
  expect(fallback).toContain("38;5;");
  expect(fallback).not.toContain("38;2;");
  expect(supportsTruecolor({ COLORTERM: "truecolor" }, "linux")).toBe(true);
  expect(supportsTruecolor({ TERM: "xterm-256color" }, "linux")).toBe(false);
  expect(supportsTruecolor({}, "win32")).toBe(true);
});

test("reduced motion comes from the setting or BAKED_REDUCED_MOTION", () => {
  expect(envReducedMotion({ BAKED_REDUCED_MOTION: "1" })).toBe(true);
  expect(envReducedMotion({ BAKED_REDUCED_MOTION: "0" })).toBe(false);
  expect(envReducedMotion({})).toBe(false);
  setMotion("reduced");
  expect(getMotion()).toBe("reduced");
  setMotion(undefined);
  expect(getMotion()).toBe("full");
});

test("busy bar names the state, fits the width and keeps the stop hint", async () => {
  expect(meterCells(0, "#ffffff", "#000000").filter((c) => c.ch === "█")).toHaveLength(3);
  const view = await testRender(<text wrapMode="none" content={busyLine(4, false, "Kneading the plan", 12, 70)} />, {
    width: 70,
    height: 1,
  });
  try {
    await act(async () => view.renderOnce());
    const line = view.captureCharFrame().split("\n")[0] ?? "";
    expect(line).toContain("BAKING");
    expect(line).toContain("Kneading the plan  12s");
    expect(line.trimEnd().endsWith("^X STOP")).toBe(true);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

for (const [width, height, card, bun] of [
  [80, 30, true, true],
  [58, 24, false, true],
  [40, 12, false, false],
] as const) {
  test(`landing at ${width}x${height}: card ${card}, bun ${bun}`, async () => {
    const view = await testRender(
      <box width="100%" height="100%" flexDirection="column">
        <LandingPage bootProviders={[]} bootPrereqs={[]} activeModel="baked-test" />
        <box height={3} width="100%" border />
      </box>,
      { width, height },
    );
    try {
      for (let frame = 0; frame < 3; frame++) await act(async () => view.renderOnce());
      const frame = view.captureCharFrame();
      expect(frame.includes("START HERE")).toBe(card);
      expect(frame.includes("▄") || frame.includes("█")).toBe(bun);
      if (!card) expect(frame).toContain("Ask anything");
      if (bun) {
        const line = frame.split("\n").find((row) => row.includes("█")) ?? "";
        const left = line.search(/\S/);
        const right = line.trimEnd().length - 1;
        expect(Math.abs((left + right) / 2 - (width - 1) / 2)).toBeLessThanOrEqual(2);
      }
    } finally {
      await act(async () => view.renderer.destroy());
    }
  });
}

test("landing without a model points at the model picker", async () => {
  const view = await testRender(<LandingPage bootProviders={[]} bootPrereqs={[]} />, { width: 80, height: 30 });
  try {
    for (let frame = 0; frame < 3; frame++) await act(async () => view.renderOnce());
    expect(view.captureCharFrame()).toContain("No model yet: pick one to start");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("boot splash picks a layout for the terminal size", () => {
  const options = { reduced: false, truecolor: true };
  const full = bootSplashFrames(80, 24, DARK_THEME, options);
  expect(full.layout).toBe("full");
  expect(full.slab).toHaveLength(11);
  expect(full.bun).toHaveLength(11);
  expect(full.rows.bar).toBeLessThanOrEqual(24);
  expect(bootSplashFrames(80, 12, DARK_THEME, options).layout).toBe("slab");
  expect(bootSplashFrames(30, 24, DARK_THEME, options).layout).toBe("line");
  const still = bootSplashFrames(80, 24, LIGHT_THEME, { reduced: true, truecolor: false });
  expect(still.slab).toHaveLength(1);
  expect(still.bun.every((phases) => phases.length === 1)).toBe(true);
});

test("boot splash painter draws the stage and exits on EXIT", async () => {
  const proc = Bun.spawn([process.execPath, "-e", BOOT_SPLASH_PAINTER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BUN_BE_BUN: "1" },
  });
  proc.stdin.write(`${JSON.stringify(bootSplashFrames(80, 24, DARK_THEME, { reduced: true, truecolor: true }))}\n`);
  proc.stdin.write(`${JSON.stringify([0.5, "Checking providers and keys"])}\n`);
  await Bun.sleep(400);
  proc.stdin.write("EXIT\n");
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("BAKING");
  expect(out).toContain("Checking providers and keys");
  expect(out).toContain(" 50%");
});
