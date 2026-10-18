import { DEFAULT_STALL_SETTINGS } from "./stall.js";
import type { LeaseRow } from "./store.js";

/**
 * Detects a driver process whose main thread stopped (#1533). Every protection of a run inside
 * the driver (the tool deadlines, the step watchdog, the lease heartbeat) is a timer on that
 * thread, so a synchronous call that never returns, or a suspended process, disables all of them
 * at once. The leases are renewed every 5 s; a lease of the driver that stays expired while the
 * supervisor itself keeps running means the driver's thread is not running its timers.
 */
export interface StallDetectorOptions {
  /** How long a lease must stay expired, in the supervisor's own running time, before takeover. */
  graceMs: number;
  /** The supervisor's poll interval; a gap of several polls means the host slept. */
  pollMs: number;
}

/** The defaults: `workflows.stall.supervisorGraceMs`, past the lease's 15 s lifetime. */
export const DEFAULT_SUPERVISOR: StallDetectorOptions = {
  graceMs: DEFAULT_STALL_SETTINGS.supervisorGraceMs,
  pollMs: 5_000,
};

export class StallDetector {
  private stale = new Map<string, { expiresAt: number; since: number }>();
  private last: number | null = null;
  constructor(private options: StallDetectorOptions = DEFAULT_SUPERVISOR) {}

  /**
   * The runs whose leases, held by the process `pid`, have stayed expired and unrenewed for
   * `graceMs` of the supervisor's running time. A lease renewed in between starts over, and so
   * does every lease after a gap in the supervisor's own polls: a host that slept stopped both
   * processes, and the driver renews its leases when it wakes.
   */
  check(
    leases: readonly LeaseRow[],
    pid: number,
    now: number = Date.now(),
    clock: number = performance.now(),
  ): string[] {
    if (this.last !== null && clock - this.last > this.options.pollMs * 3) this.stale.clear();
    this.last = clock;
    const stuck = new Set<string>();
    const seen = new Set<string>();
    for (const lease of leases) {
      if (!lease.run_id || ownerPid(lease) !== pid || lease.expires_at > now) continue;
      seen.add(lease.resource);
      const earlier = this.stale.get(lease.resource);
      if (!earlier || earlier.expiresAt !== lease.expires_at) {
        this.stale.set(lease.resource, { expiresAt: lease.expires_at, since: clock });
        continue;
      }
      if (clock - earlier.since >= this.options.graceMs) stuck.add(lease.run_id);
    }
    for (const resource of this.stale.keys()) if (!seen.has(resource)) this.stale.delete(resource);
    return [...stuck];
  }
}

function ownerPid(lease: LeaseRow): number | null {
  try {
    const owner = JSON.parse(lease.process_identity_json) as { pid?: unknown };
    return typeof owner.pid === "number" ? owner.pid : null;
  } catch {
    return null;
  }
}
