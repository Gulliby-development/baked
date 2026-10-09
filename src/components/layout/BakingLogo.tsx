import { fg as fgStyle, StyledText, TextAttributes, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";

const LOAVES = [
  [
    "      ▄▄▄▄▄▄▄▄▄▄▄▄▄      ",
    "    ▄████╱██╱██╱████▄    ",
    "   ▐████╱██╱██╱██████▌   ",
    "    ▀━━━━━━━━━━━━━━━▀    ",
  ],
  [
    "     ▄█████████████▄     ",
    "   ▄████╱██╱╱██╱████▄   ",
    "  ▐████╱██╱╱██╱██████▌  ",
    "   ▀━━━━━━━━━━━━━━━━━▀   ",
  ],
  [
    "    ▄▄█████████████▄▄    ",
    "  ▄████╱╱██╱╱██╱╱████▄  ",
    " ▐████╱╱██╱╱██╱╱██████▌ ",
    "  ▀━━━━━━━━━━━━━━━━━━━▀  ",
  ],
] as const;
const LOAF_WIDTH = Math.max(...LOAVES.flat().map((line) => line.length));
const CYCLE_SECONDS = 12;
const STAGES = ["Rising dough", "Golden crust", "Freshly baked"];
type ColoredText = ReturnType<ReturnType<typeof fgStyle>>;

export function BakingLogo({ cols }: { cols: number }) {
  const textRef = useRef<TextRenderable>(null);
  const theme = useTheme();

  useEffect(() => {
    const startedAt = performance.now();
    const paint = () => {
      if (!textRef.current) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      textRef.current.content = renderBakingFrame(cols, elapsed, theme);
    };
    paint();
    const timer = setInterval(paint, 80);
    return () => clearInterval(timer);
  }, [cols, theme]);

  return (
    <box width={cols} flexDirection="column" alignItems="center">
      <text ref={textRef} width={cols} attributes={TextAttributes.BOLD} wrapMode="none">
        {" "}
      </text>
    </box>
  );
}

export function renderBakingFrame(cols: number, elapsed: number, theme: ThemeTokens): StyledText {
  const cycle = (elapsed % CYCLE_SECONDS) / CYCLE_SECONDS;
  const stage = Math.min(2, Math.floor(cycle * STAGES.length));
  const rise = (1 - Math.cos(elapsed * 1.6)) / 2;
  const loaf = LOAVES[Math.round(rise * (LOAVES.length - 1))] ?? LOAVES[0];
  const crust = blendColor(theme.brandSecondary, theme.brand, Math.min(1, cycle * 1.8));
  const breadLines: ColoredText[][] = [
    [fgStyle(theme.textMuted)(steamLine(elapsed, 0))],
    [fgStyle(theme.brandSecondary)(steamLine(elapsed, 1))],
    ...loaf.map((line, row) =>
      [...line.padEnd(LOAF_WIDTH)].map((char, column) => {
        const warmth = (1 + Math.sin(elapsed * 2.4 - column * 0.28 + row * 0.7)) / 2;
        const glow = blendColor(crust, theme.brandSecondary, warmth * 0.5);
        const base = blendColor(theme.brandAlt, theme.brand, warmth);
        return fgStyle(char === "╱" ? theme.bgApp : char === "━" ? base : glow)(char);
      }),
    ),
  ];
  const parts: ColoredText[] = [];
  const space = (count: number) => fgStyle(theme.textMuted)(" ".repeat(count));
  const newline = fgStyle(theme.textMuted)("\n");

  const breadPadding = Math.max(0, Math.floor((cols - LOAF_WIDTH) / 2));
  for (const line of breadLines) parts.push(space(breadPadding), ...line, newline);

  parts.push(newline);
  const fullCaption = `${STAGES[stage]}  ·  Ready for your next idea`;
  const caption = fullCaption.length <= cols ? fullCaption : (STAGES[stage] ?? "Freshly baked");
  parts.push(space(Math.max(0, Math.floor((cols - caption.length) / 2))));
  parts.push(fgStyle(theme.textSecondary)(caption));
  return new StyledText(parts);
}

function steamLine(elapsed: number, row: number): string {
  const line = Array<string>(LOAF_WIDTH).fill(" ");
  for (const [index, offset] of [-6, 0, 6].entries()) {
    const phase = elapsed * 2.8 + row * 1.2 + index * 2.1;
    const x = Math.round((LOAF_WIDTH - 1) / 2 + offset + Math.sin(phase) * 2);
    const curl = Math.cos(phase) > 0;
    line[x] = row === 0 ? (curl ? "~" : "·") : curl ? ")" : "(";
    if (row === 0 && Math.sin(phase) > 0.2) line[x + 1] = "~";
  }
  return line.join("");
}

function blendColor(from: string, to: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16);
    const end = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}
