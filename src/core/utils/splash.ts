const GLITCH_POOL = "░▒▓█▄▀▐▌┤├┼─│┌┐└┘╔╗╚╝";

export function garble(text: string): string {
  return [...text]
    .map((ch) =>
      ch === " " ? " " : (GLITCH_POOL[Math.floor(Math.random() * GLITCH_POOL.length)] ?? "█"),
    )
    .join("");
}
