import type { SupervisorClock } from "../../src/core/workflows/supervisor-clock.js";

/** Only supervisor time advances. Process startup, RPC and workflow execution use real I/O. */
export class ManualSupervisorClock implements SupervisorClock {
  private elapsed = 0;
  wall = Date.now();
  private timers = new Set<{ at: number; ms: number; callback: () => void }>();

  now = () => this.elapsed;
  wallNow = () => this.wall;

  every(ms: number, callback: () => void): () => void {
    const timer = { at: this.elapsed + ms, ms, callback };
    this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  }

  advance(ms: number): void {
    const end = this.elapsed + ms;
    for (;;) {
      const next = Math.min(...[...this.timers].map((timer) => timer.at));
      if (next > end) break;
      this.wall += next - this.elapsed;
      this.elapsed = next;
      for (const timer of [...this.timers]) {
        if (timer.at !== next || !this.timers.has(timer)) continue;
        timer.at += timer.ms;
        timer.callback();
      }
    }
    this.wall += end - this.elapsed;
    this.elapsed = end;
  }
}
