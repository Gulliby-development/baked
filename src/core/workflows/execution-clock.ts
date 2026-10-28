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

interface ExecutionSpan {
  from: number;
  to?: number;
}

/** Per-drive time. Unanswered calls are provisional until a response or an outage decides them. */
export class ExecutionBudgetClock {
  private excluded: ExecutionSpan[] = [];
  private working: ExecutionSpan[] = [];
  constructor(private clock: Pick<ExecutionClock, "now"> = executionClock) {}

  now(): number {
    const now = this.clock.now();
    const edges: { at: number; idle: number; working: number }[] = [];
    for (const [spans, working] of [
      [this.excluded, false],
      [this.working, true],
    ] as const)
      for (const span of spans) {
        edges.push({ at: span.from, idle: working ? 0 : 1, working: working ? 1 : 0 });
        edges.push({ at: span.to ?? now, idle: working ? 0 : -1, working: working ? -1 : 0 });
      }
    edges.sort((a, b) => a.at - b.at);
    let idle = 0;
    let working = 0;
    let skipped = 0;
    let last = 0;
    for (const edge of edges) {
      if (idle > 0 && working === 0) skipped += edge.at - last;
      idle += edge.idle;
      working += edge.working;
      last = edge.at;
    }
    return now - skipped;
  }

  /**
   * An unanswered call, or a wait stage with no model work (settled `false` alone). A first
   * response (`true`) charges the wait; a later `false` says the call ended without an answer
   * (no tokens, no tool call: a deadline, ladder or watchdog abort, a cancel), and its whole
   * interval is excluded again (#2414).
   */
  pending(): (responded: boolean) => void {
    const span: ExecutionSpan = { from: this.clock.now() };
    this.excluded.push(span);
    let state: "pending" | "responded" | "settled" = "pending";
    return (responded) => {
      if (state === "settled" || (state === "responded" && responded)) return;
      span.to = this.clock.now();
      if (responded) {
        this.excluded.splice(this.excluded.indexOf(span), 1);
        state = "responded";
        return;
      }
      if (state === "responded") this.excluded.push(span);
      state = "settled";
    };
  }

  /** Other attempts' healthy work still counts while a parallel call is unreachable. */
  track(): { pending: () => (responded: boolean) => void; finish: () => void } {
    let active: ExecutionSpan | undefined = { from: this.clock.now() };
    this.working.push(active);
    let finished = false;
    let open: ((responded: boolean) => void) | undefined;
    const resume = (): void => {
      if (finished) return;
      active = { from: this.clock.now() };
      this.working.push(active);
    };
    return {
      pending: () => {
        const from = this.clock.now();
        if (active) active.to = from;
        active = undefined;
        const end = this.pending();
        let state: "pending" | "responded" | "settled" = "pending";
        let answering: ExecutionSpan | undefined;
        const settle = (responded: boolean): void => {
          if (state === "settled" || (state === "responded" && responded)) return;
          end(responded);
          if (responded) {
            state = "responded";
            open = undefined;
            if (finished) return;
            answering = active = { from };
            this.working.push(active);
            return;
          }
          state = "settled";
          open = undefined;
          // The response that charged the wait was no answer: its working time goes too.
          if (answering) {
            if (answering.to === undefined) answering.to = this.clock.now();
            this.working.splice(this.working.indexOf(answering), 1);
            if (active === answering) active = undefined;
          }
          resume();
        };
        open = settle;
        return settle;
      },
      finish: () => {
        open?.(false);
        if (active) active.to = this.clock.now();
        active = undefined;
        finished = true;
      },
    };
  }
}

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
