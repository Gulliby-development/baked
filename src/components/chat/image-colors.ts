import { ansi256IndexToRgb, RGBA, StyledText, type TextChunk } from "@opentui/core";
import stripAnsi from "strip-ansi";

/** Decode the SGR colors emitted by chafa and the built-in half-block renderer. */
export function styleImageLines(lines: string[]): StyledText[] {
  let foreground: RGBA | undefined;
  let background: RGBA | undefined;
  let reversed = false;

  return lines.map((line) => {
    const chunks: TextChunk[] = [];
    const append = (text: string) => {
      if (!text) return;
      chunks.push({
        __isChunk: true,
        text: stripAnsi(text),
        fg: reversed ? background : foreground,
        bg: reversed ? foreground : background,
      });
    };
    let offset = 0;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences from image rendering
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      append(line.slice(offset, match.index));
      const codes = (match[1] ?? "").split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i] ?? 0;
        if (code === 0) {
          foreground = undefined;
          background = undefined;
          reversed = false;
        } else if (code === 7 || code === 27) {
          reversed = code === 7;
        } else if (code === 39) {
          foreground = undefined;
        } else if (code === 49) {
          background = undefined;
        } else if (code === 38 || code === 48) {
          const mode = codes[i + 1];
          let color: RGBA | undefined;
          if (mode === 2 && i + 4 < codes.length) {
            color = RGBA.fromInts(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
            i += 4;
          } else if (mode === 5 && i + 2 < codes.length) {
            color = indexedColor(codes[i + 2] ?? 0);
            i += 2;
          }
          if (color && code === 38) foreground = color;
          if (color && code === 48) background = color;
        } else if (code >= 30 && code <= 37) {
          foreground = indexedColor(code - 30);
        } else if (code >= 40 && code <= 47) {
          background = indexedColor(code - 40);
        } else if (code >= 90 && code <= 97) {
          foreground = indexedColor(code - 90 + 8);
        } else if (code >= 100 && code <= 107) {
          background = indexedColor(code - 100 + 8);
        }
      }
      offset = match.index + match[0].length;
    }
    append(line.slice(offset));
    return new StyledText(chunks);
  });
}

function indexedColor(index: number): RGBA {
  const [r, g, b] = ansi256IndexToRgb(index);
  return RGBA.fromInts(r, g, b);
}
