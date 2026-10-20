/** Timers and time readings of a supervisor, independent of the driver it watches. */
export interface SupervisorClock {
  now(): number;
  wallNow(): number;
  every(ms: number, callback: () => void): () => void;
}

export const systemSupervisorClock: SupervisorClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};
