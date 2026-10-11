import type { BakeMode } from "../../types/index.js";
import type { SessionMeta } from "./types.js";

type LegacyMode = { bakeMode?: BakeMode; forgeMode?: BakeMode };

/** Moves a `forgeMode` saved before the main agent was renamed to `bakeMode`. */
function withBakeMode<T extends LegacyMode>(entry: T): T {
  const { forgeMode, ...rest } = entry;
  const bakeMode = rest.bakeMode ?? forgeMode;
  return (bakeMode ? { ...rest, bakeMode } : rest) as T;
}

/** Parses a session's meta.json, reading the legacy `forgeMode` key as `bakeMode`. */
export function parseSessionMeta(raw: string): SessionMeta {
  const meta = withBakeMode(JSON.parse(raw) as SessionMeta & LegacyMode);
  return {
    ...meta,
    bakeMode: meta.bakeMode ?? "default",
    tabs: (meta.tabs ?? []).map(withBakeMode),
  };
}
