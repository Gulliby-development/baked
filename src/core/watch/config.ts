/** `watch` in config.json: how watch mode finds marker comments. */
export interface WatchConfig {
  /** The marker word; `baked!` acts, `baked?` asks, `baked` adds context. */
  marker?: string;
  /** Extra gitignore-style patterns to skip, on top of `.gitignore` and `.bakedignore`. */
  ignore?: string[];
  /** How long saves settle before the changed files are read. */
  debounceMs?: number;
  /** Ask the agent to remove the `baked?` comments it answered. */
  removeAnswered?: boolean;
  /** Poll for changes instead of native file events (network drives, WSL mounts). */
  poll?: boolean;
}

export interface WatchOptions {
  marker: string;
  ignore: string[];
  debounceMs: number;
  removeAnswered: boolean;
  poll: boolean;
}

export const WATCH_DEFAULTS: WatchOptions = {
  marker: "baked",
  ignore: [],
  debounceMs: 300,
  removeAnswered: false,
  poll: false,
};

/** Fills in defaults and drops values of the wrong type. */
export function watchOptions(config: WatchConfig | undefined): WatchOptions {
  const c = config ?? {};
  const marker =
    typeof c.marker === "string" && /^[A-Za-z][\w-]*$/.test(c.marker) ? c.marker : null;
  const debounce =
    typeof c.debounceMs === "number" && Number.isFinite(c.debounceMs) ? c.debounceMs : null;
  return {
    marker: marker ?? WATCH_DEFAULTS.marker,
    ignore: Array.isArray(c.ignore) ? c.ignore.filter((p) => typeof p === "string") : [],
    debounceMs:
      debounce === null ? WATCH_DEFAULTS.debounceMs : Math.min(10_000, Math.max(50, debounce)),
    removeAnswered: c.removeAnswered === true,
    poll: c.poll === true,
  };
}
