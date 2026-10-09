import { hash32Hex } from "../utils/hash.js";

/**
 * A frozen bake-map artifact for a single tab.
 *
 * The whole point: the system-prompt prefix that contains the Baked map should
 * be byte-identical across many requests so the provider's prompt cache hits.
 * Even providers without explicit `cache_control` (OpenAI, DeepSeek, etc.)
 * benefit from a stable prefix because their implicit caches key on it.
 *
 * Lifetime semantics — idle TTL, not birth TTL:
 *   - On every read, `lastAccessedAt` bumps to now.
 *   - The snapshot expires when `now - lastAccessedAt >= ttlMs`.
 *   - An hour of continuous use stays hot; 5 minutes of inactivity expires it.
 *   - Mirrors how Anthropic's ephemeral cache actually behaves.
 *
 * Mutations land in a separate delta channel — never in the snapshot.
 * Refresh on TTL idle, compaction, /clear, explicit force.
 */
export interface BakeMapSnapshotData {
  content: string;
  paths: ReadonlySet<string>;
  ttlMs: number;
  /** Optional opaque cache breakpoint key for telemetry. */
  cacheKey?: string;
}

export class BakeMapSnapshot {
  readonly content: string;
  readonly paths: ReadonlySet<string>;
  readonly builtAt: number;
  readonly hash: string;
  readonly ttlMs: number;
  readonly cacheKey: string;
  private _lastAccessedAt: number;

  constructor(data: BakeMapSnapshotData, now: number = Date.now()) {
    this.content = data.content;
    this.paths = data.paths;
    this.ttlMs = data.ttlMs;
    this.builtAt = now;
    this._lastAccessedAt = now;
    this.hash = hash32Hex(data.content);
    this.cacheKey = data.cacheKey ?? this.hash;
  }

  /** Returns the frozen content and bumps `lastAccessedAt`. */
  read(now: number = Date.now()): string {
    this._lastAccessedAt = now;
    return this.content;
  }

  /** Whether the snapshot has been idle past its TTL. */
  isIdleExpired(now: number = Date.now()): boolean {
    return now - this._lastAccessedAt >= this.ttlMs;
  }

  get lastAccessedAt(): number {
    return this._lastAccessedAt;
  }
}
