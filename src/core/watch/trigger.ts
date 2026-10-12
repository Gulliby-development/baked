import { type Marker, type MarkerKind, parseMarkers } from "./markers.js";

/** A marker together with the file it is in (project-relative, `/` separators). */
export interface FileMarker extends Marker {
  path: string;
}

export interface Trigger {
  /** The new `baked!` and `baked?` markers that start this turn. */
  requests: FileMarker[];
  /** `baked` comments that go along as context. */
  context: FileMarker[];
}

function key(marker: Marker): string {
  return `${marker.kind}\u0000${marker.text}`;
}

/**
 * Remembers the markers seen in each file, so a save starts a turn only when it adds a `baked!` or
 * `baked?` marker. Markers are compared by kind and text, not line, so code moving above an old
 * marker does not repeat it. A file seen for the first time counts all its markers as new.
 */
export class MarkerTracker {
  private seen = new Map<string, Set<string>>();
  private pendingContext = new Map<string, FileMarker>();

  constructor(private readonly marker = "baked") {}

  /** Reads changed files; returns a trigger when one of them added a request. */
  update(files: readonly { path: string; text: string | null }[]): Trigger | null {
    const requests: FileMarker[] = [];
    for (const { path, text } of files) {
      const markers = text === null ? [] : parseMarkers(path, text, this.marker);
      const before = this.seen.get(path) ?? new Set<string>();
      this.seen.set(path, new Set(markers.map(key)));
      for (const id of [...this.pendingContext.keys()])
        if (id.startsWith(`${path}\u0000`)) this.pendingContext.delete(id);
      for (const m of markers) {
        const located = { ...m, path };
        if (m.kind === "context") this.pendingContext.set(`${path}\u0000${key(m)}`, located);
        else if (!before.has(key(m))) requests.push(located);
      }
    }
    if (requests.length === 0) return null;
    const context = [...this.pendingContext.values()];
    this.pendingContext.clear();
    return { requests, context };
  }

  /** Records a file's current markers without triggering, e.g. after BAKED itself wrote it. */
  remember(path: string, text: string): void {
    const markers = parseMarkers(path, text, this.marker);
    this.seen.set(path, new Set(markers.map(key)));
    for (const id of [...this.pendingContext.keys()])
      if (id.startsWith(`${path}\u0000`)) this.pendingContext.delete(id);
  }
}

export function kindOf(trigger: Trigger): MarkerKind {
  return trigger.requests.some((r) => r.kind === "act") ? "act" : "ask";
}
