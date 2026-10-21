import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ADAPTIVE_FIRST_BYTE_SAMPLES, type CallTiming } from "./provider-health.js";

/** How many healthy first responses of one call shape are kept. */
const KEPT = 50;

/**
 * The healthy first-response times of each call shape (model, stage, effort) that the adaptive
 * first-response deadline is taken from (#1766): seeded from the recorded attempts of the
 * workspace, then every call that answers. With a `shared` file, a shape the workspace has too
 * few answers for is completed from the answers of every workspace on this machine (#1880).
 */
export class FirstByteHistory {
  private readonly samples = new Map<string, number[]>();
  private shared: Map<string, number[]> | null = null;

  constructor(private readonly sharedFile?: string) {}

  /**
   * Keeps a call that got an answer; a refusal or an outage says nothing about latency. `share`
   * also adds it to the shared file, for the next workspace that has no answers of its shape.
   */
  record(model: string, call: CallTiming, share = false): void {
    if (call.firstByteMs === null || call.status !== undefined) return;
    const key = shapeKey(model, call.stage, call.effort);
    keep(this.samples, key, call.firstByteMs);
    if (share && this.sharedFile) this.persist(key, call.firstByteMs);
  }

  /**
   * The answers of a call shape: the workspace's own, completed from the shared file with
   * `shared` while the workspace has fewer than `ADAPTIVE_FIRST_BYTE_SAMPLES` of them. In bench
   * round 58 the first specify calls of a fresh workspace waited the 10 minute ceiling each,
   * while the round's other workspaces answered their spec calls in 4 to 126 s.
   */
  healthy(model: string, stage?: string, effort?: string, shared = false): readonly number[] {
    const key = shapeKey(model, stage, effort);
    const own = this.samples.get(key) ?? [];
    if (!shared || !this.sharedFile || own.length >= ADAPTIVE_FIRST_BYTE_SAMPLES) return own;
    return [...(this.sharedSamples().get(key) ?? []), ...own].slice(-KEPT);
  }

  private sharedSamples(): Map<string, number[]> {
    this.shared ??= readShared(this.sharedFile as string);
    return this.shared;
  }

  /** Read, add and write back, so answers other processes added since are kept. */
  private persist(key: string, firstByteMs: number): void {
    const file = this.sharedFile as string;
    const current = readShared(file);
    keep(current, key, firstByteMs);
    this.shared = current;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ schemaVersion: 1, shapes: Object.fromEntries(current) }),
      );
      renameSync(temporary, file);
    } catch {
      // A history that cannot be written only leaves the next workspace on the ceiling.
    }
  }
}

function keep(samples: Map<string, number[]>, key: string, firstByteMs: number): void {
  const kept = samples.get(key) ?? [];
  kept.push(firstByteMs);
  if (kept.length > KEPT) kept.splice(0, kept.length - KEPT);
  samples.set(key, kept);
}

function readShared(file: string): Map<string, number[]> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { shapes?: Record<string, unknown> };
    const shapes = new Map<string, number[]>();
    for (const [key, value] of Object.entries(parsed.shapes ?? {}))
      if (Array.isArray(value))
        shapes.set(
          key,
          value.filter((ms): ms is number => typeof ms === "number" && ms >= 0).slice(-KEPT),
        );
    return shapes;
  } catch {
    return new Map();
  }
}

const shapeKey = (model: string, stage?: string, effort?: string) =>
  `${model}|${stage ?? ""}|${effort ?? ""}`;
