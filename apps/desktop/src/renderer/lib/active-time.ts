/** Plan-time sizing's active-time estimate against the active-time cap (`sizing.ts` in the core). */
export interface ActiveTime {
  tokensPerMinute: number;
  /** `initiative` when the initiative's own finished runs set the pace. */
  basis: "initiative" | "history" | "default";
  runs: number;
  estimatedMs: number;
  before: number;
  after: number;
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** The approval's line for the sized active time (`activeTimeText` in the core). */
export function activeTimeText(time: ActiveTime): string {
  const rate = `${Math.round(time.tokensPerMinute / 1000)}k tokens per minute, ${
    time.basis === "initiative"
      ? `the median of ${time.runs} finished runs of this initiative`
      : time.basis === "history"
        ? `the median of ${time.runs} runs`
        : "the default rate"
  }`;
  const cap =
    time.after > time.before
      ? `; sizing raised the cap to ${minutes(time.after)} min`
      : time.estimatedMs > time.before
        ? "; the run may stop at the cap"
        : "";
  return `Estimated active time at the observed rate (${rate}): ${minutes(time.estimatedMs)} min against maxActiveMs ${minutes(time.before)} min${cap}`;
}
