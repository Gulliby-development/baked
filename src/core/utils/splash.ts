export const BAKED_COLORS = {
  orange: "#ff8a2a",
  highlight: "#ffbd70",
  shadow: "#a84310",
  ember: "#ffad42",
};

export const BIG_WORDMARK = [
  "██████╗   █████╗  ██╗  ██╗ ███████╗ ██████╗ ",
  "██╔══██╗ ██╔══██╗ ██║ ██╔╝ ██╔════╝ ██╔══██╗",
  "██████╔╝ ███████║ █████╔╝  █████╗   ██║  ██║",
  "██╔══██╗ ██╔══██║ ██╔═██╗  ██╔══╝   ██║  ██║",
  "██████╔╝ ██║  ██║ ██║  ██╗ ███████╗ ██████╔╝",
  "╚═════╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝ ",
].map((row) => row.padEnd(44));

export const SMALL_WORDMARK = ["╔╗ ╔═╗╦╔═╔═╗╔╦╗", "╠╩╗╠═╣╠╩╗║╣  ║║", "╚═╝╩ ╩╩ ╩╚═╝═╩╝"];

export const WORDMARK = SMALL_WORDMARK;

export function pickWordmark(cols: number): string[] {
  for (const wordmark of [BIG_WORDMARK, SMALL_WORDMARK]) {
    if (cols >= Math.max(...wordmark.map((row) => row.length)) + 4) return wordmark;
  }
  return ["Baked"];
}

const GLITCH_POOL = "░▒▓█▄▀▐▌┤├┼─│┌┐└┘╔╗╚╝";

export const WISP_FRAMES = ["~∿~", "∿~∿", "·∿·", "∿·∿"];

export function garble(text: string): string {
  return [...text]
    .map((ch) =>
      ch === " " ? " " : (GLITCH_POOL[Math.floor(Math.random() * GLITCH_POOL.length)] ?? "█"),
    )
    .join("");
}
