import type { CallTiming } from "./provider-health.js";

/** How many healthy first responses of one call shape are kept. */
const KEPT = 50;

/**
 * The healthy first-response times of each call shape (model, stage, effort) that the adaptive
 * first-response deadline is taken from (#1766): seeded from the recorded attempts of the
 * workspace, then every call that answers.
 */
export class FirstByteHistory {
  private readonly samples = new Map<string, number[]>();

  /** Keeps a call that got an answer; a refusal or an outage says nothing about latency. */
  record(model: string, call: CallTiming): void {
    if (call.firstByteMs === null || call.status !== undefined) return;
    const key = shapeKey(model, call.stage, call.effort);
    const kept = this.samples.get(key) ?? [];
    kept.push(call.firstByteMs);
    if (kept.length > KEPT) kept.splice(0, kept.length - KEPT);
    this.samples.set(key, kept);
  }

  healthy(model: string, stage?: string, effort?: string): readonly number[] {
    return this.samples.get(shapeKey(model, stage, effort)) ?? [];
  }
}

const shapeKey = (model: string, stage?: string, effort?: string) =>
  `${model}|${stage ?? ""}|${effort ?? ""}`;
