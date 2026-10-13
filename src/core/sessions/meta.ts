import type { SessionMeta } from "./types.js";

/** Parses a session's meta.json, filling the mode and tabs a partial file leaves out. */
export function parseSessionMeta(raw: string): SessionMeta {
  const meta = JSON.parse(raw) as SessionMeta;
  return { ...meta, bakeMode: meta.bakeMode ?? "default", tabs: meta.tabs ?? [] };
}
