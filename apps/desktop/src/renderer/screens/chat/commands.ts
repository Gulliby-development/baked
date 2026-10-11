/** Custom slash commands in the composer; kept free of React so tests can import it. */

/** The custom command name being typed: the message so far is one word starting with `/`. */
export function slashAtCaret(text: string, caret: number): { query: string } | null {
  const m = /^\/(\S*)$/.exec(text.slice(0, caret));
  return m ? { query: (m[1] ?? "").toLowerCase() } : null;
}

/** Commands whose name starts with the typed text, then those that contain it. */
export function matchCommands<T extends { name: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  const needle = `/${query}`;
  const starts = commands.filter((c) => c.name.startsWith(needle));
  const contains = query
    ? commands.filter((c) => !c.name.startsWith(needle) && c.name.includes(query))
    : [];
  return [...starts, ...contains];
}
