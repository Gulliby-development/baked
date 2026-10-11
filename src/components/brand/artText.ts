import { bg as bgStyle, fg as fgStyle, StyledText, type TextChunk } from "@opentui/core";
import type { ArtCell, ArtRows } from "../../core/utils/bake-art.js";

/** Converts pixel-art cells into one StyledText, merging runs that share colours. */
export function artText(rows: ArtRows): StyledText {
  const chunks: TextChunk[] = [];
  rows.forEach((row, index) => {
    let run = "";
    let style: ArtCell | undefined;
    const flush = () => {
      if (!run) return;
      chunks.push(styleChunk(run, style));
      run = "";
    };
    for (const cell of row) {
      if (!style || cell.fg !== style.fg || cell.bg !== style.bg) {
        flush();
        style = cell;
      }
      run += cell.ch;
    }
    flush();
    if (index < rows.length - 1) chunks.push(styleChunk("\n"));
  });
  return new StyledText(chunks);
}

function styleChunk(text: string, cell?: ArtCell): TextChunk {
  let chunk: TextChunk = cell?.fg ? fgStyle(cell.fg)(text) : { __isChunk: true, text };
  if (cell?.bg) chunk = bgStyle(cell.bg)(chunk);
  return chunk;
}
