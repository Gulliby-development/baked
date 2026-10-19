/** Sampling gaps beyond three lease heartbeats are host inactivity, not execution time. */
export const EXECUTION_SAMPLE_MS = 1_000;
export const EXECUTION_GAP_MS = 15_000;

/** A process-local clock shared by workflow budgets, deadlines and progress watches. */
export class ExecutionClock {
  private lastWall: number;
  private lastMono: number;
  private elapsed = 0;
  private readonly bornAt: number;
  private gaps: { from: number; to: number }[] = [];

  constructor(
    private wall: () => number = () => Date.now(),
    private mono: () => number = () => performance.now(),
  ) {
    this.lastWall = this.bornAt = wall();
    this.lastMono = mono();
  }

  now(): number {
    const wall = this.wall();
    const mono = this.mono();
    const wallDelta = wall - this.lastWall;
    const delta = Math.max(0, mono - this.lastMono);
    // Monotonic clocks include suspend on some OSes and exclude it on others. Check both
    // clocks, and credit at most one sample when either indicates a missed heartbeat window.
    const credited =
      Math.max(delta, wallDelta) > EXECUTION_GAP_MS ? Math.min(delta, EXECUTION_SAMPLE_MS) : delta;
    this.elapsed += credited;
    if (wallDelta > EXECUTION_GAP_MS && wallDelta > credited)
      this.gaps.push({ from: this.lastWall + credited, to: wall });
    this.lastWall = wall;
    this.lastMono = mono;
    return this.elapsed;
  }

  /** Silence of a durable event, excluding gaps and time before this observer started. */
  since(wallAt: number): number {
    this.now();
    const from = Math.max(this.bornAt, wallAt);
    const skipped = this.gaps.reduce(
      (sum, gap) => sum + Math.max(0, Math.min(this.lastWall, gap.to) - Math.max(from, gap.from)),
      0,
    );
    return Math.max(0, this.lastWall - from - skipped);
  }
}

export const executionClock = new ExecutionClock();
// Sampling must continue during a silent model call; otherwise its whole silence looks like
// a host sleep. Consumers also sample before deciding, regardless of timer callback ordering.
setInterval(() => executionClock.now(), EXECUTION_SAMPLE_MS).unref();

/** Returns a cancellation function. Every callback checks execution time again after wake. */
export function executionTimeout(
  callback: () => void,
  ms: number,
  clock: Pick<ExecutionClock, "now"> = executionClock,
): () => void {
  const until = clock.now() + Math.max(0, ms);
  let timer: ReturnType<typeof setTimeout>;
  const poll = (): void => {
    const left = until - clock.now();
    if (left <= 0) callback();
    else timer = setTimeout(poll, Math.min(EXECUTION_SAMPLE_MS, left));
  };
  timer = setTimeout(poll, Math.min(EXECUTION_SAMPLE_MS, Math.max(0, ms)));
  return () => clearTimeout(timer);
}
