import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ADAPTIVE_FIRST_BYTE_SAMPLES,
  type CallTiming,
  type FirstByteInputs,
  firstByteDeadline,
  firstByteInputs,
  type SizedFirstByte,
} from "./provider-health.js";

/** How many healthy first responses of one call shape are kept. */
const KEPT = 50;

/**
 * The healthy first-response times of each call shape (model, stage, effort) that the adaptive
 * first-response deadline is taken from (#1766): seeded from the recorded attempts of the
 * workspace, then every call that answers. With a `shared` file, a shape the workspace has too
 * few answers for is completed from the answers of every workspace on this machine (#1880).
 * Each answer keeps the size of its prompt, so a larger call gets a longer deadline (#2041).
 */
export class FirstByteHistory {
  private readonly samples = new Map<string, SizedFirstByte[]>();
  private shared: Map<string, SizedFirstByte[]> | null = null;
  /**
   * Shapes whose call ran out its adaptive deadline unanswered (#2041), with the largest prompt
   * that did (0 when the call recorded no size). Only an answer to a prompt at least that large
   * clears it (#2193).
   */
  private readonly expired = new Map<string, number>();

  constructor(private readonly sharedFile?: string) {}

  /**
   * Keeps a call that got an answer; a refusal or an outage says nothing about latency. `share`
   * also adds it to the shared file, for the next workspace that has no answers of its shape.
   */
  record(model: string, call: CallTiming, share = false): void {
    if (call.status !== undefined) return;
    const key = shapeKey(model, call.stage, call.effort);
    if (call.firstByteMs === null) {
      if (call.limitMs !== undefined && call.durationMs >= call.limitMs)
        this.expired.set(key, Math.max(this.expired.get(key) ?? 0, call.promptChars ?? 0));
      return;
    }
    // A retry attempt opens with short calls of the same shape (a resumed turn's continuations
    // answer in seconds): they say nothing about the large call that expired. R69 skillplumb's
    // plan call (142k characters) expired three times at 180 s while each retry's first 8 s answer
    // had cleared the ceiling before it (#2193).
    if ((call.promptChars ?? 0) >= (this.expired.get(key) ?? 0)) this.expired.delete(key);
    const sample = {
      ms: call.firstByteMs,
      ...(call.promptChars !== undefined ? { chars: call.promptChars } : {}),
    };
    keep(this.samples, key, sample);
    if (share && this.sharedFile) this.persist(key, sample);
  }

  /**
   * The first-response deadline of a call of this shape and prompt size (`adaptiveFirstByteMs`).
   * After a call of the shape ran out its adaptive deadline unanswered, every call of it gets the
   * ceiling until one at least as large answers: the adaptive deadline is a guess from smaller
   * calls, and the recovery ladder would otherwise repeat the same input under the same deadline
   * (R66 nodepluck syntax, five attempts cut off at 180 s, #2041; R69 skillplumb plan, #2193).
   */
  deadline(
    ceilingMs: number,
    model: string,
    call: { stage?: string | undefined; effort?: string | undefined; promptChars?: number },
    shared = false,
  ): number {
    return this.decide(ceilingMs, model, call, shared).ms;
  }

  /**
   * `deadline` with what it was computed from, which the executor keeps in the call's timing
   * (`deadlineInputs`): the shared answers and the history the process started with are not in
   * the run's database, so a replay decides the call from these (#2283).
   */
  decide(
    ceilingMs: number,
    model: string,
    call: { stage?: string | undefined; effort?: string | undefined; promptChars?: number },
    shared = false,
  ): { ms: number; inputs: FirstByteInputs } {
    const key = shapeKey(model, call.stage, call.effort);
    const healthy = this.healthy(model, call.stage, call.effort, shared);
    const own = this.samples.get(key)?.length ?? 0;
    const inputs: FirstByteInputs = {
      ...firstByteInputs(healthy),
      ...(healthy.length > own ? { shared: healthy.length - own } : {}),
      ...(this.expired.has(key) ? { expired: true as const } : {}),
    };
    return { ms: firstByteDeadline(ceilingMs, inputs, call.promptChars), inputs };
  }

  /**
   * The answers of a call shape: the workspace's own, completed from the shared file with
   * `shared` while the workspace has fewer than `ADAPTIVE_FIRST_BYTE_SAMPLES` of them. In bench
   * round 58 the first specify calls of a fresh workspace waited the 10 minute ceiling each,
   * while the round's other workspaces answered their spec calls in 4 to 126 s.
   */
  healthy(
    model: string,
    stage?: string,
    effort?: string,
    shared = false,
  ): readonly SizedFirstByte[] {
    const key = shapeKey(model, stage, effort);
    const own = this.samples.get(key) ?? [];
    if (!shared || !this.sharedFile || own.length >= ADAPTIVE_FIRST_BYTE_SAMPLES) return own;
    return [...(this.sharedSamples().get(key) ?? []), ...own].slice(-KEPT);
  }

  private sharedSamples(): Map<string, SizedFirstByte[]> {
    this.shared ??= readShared(this.sharedFile as string);
    return this.shared;
  }

  /** Read, add and write back, so answers other processes added since are kept. */
  private persist(key: string, sample: SizedFirstByte): void {
    const file = this.sharedFile as string;
    const current = readShared(file);
    keep(current, key, sample);
    this.shared = current;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({
          schemaVersion: 1,
          // An answer without a size stays a number, as BAKED wrote it before #2041.
          shapes: Object.fromEntries(
            [...current].map(([shape, kept]) => [
              shape,
              kept.map((sample) => (sample.chars === undefined ? sample.ms : sample)),
            ]),
          ),
        }),
      );
      renameSync(temporary, file);
    } catch {
      // A history that cannot be written only leaves the next workspace on the ceiling.
    }
  }
}

function keep(samples: Map<string, SizedFirstByte[]>, key: string, sample: SizedFirstByte): void {
  const kept = samples.get(key) ?? [];
  kept.push(sample);
  if (kept.length > KEPT) kept.splice(0, kept.length - KEPT);
  samples.set(key, kept);
}

/** An entry of the shared file: a number before #2041, `{ ms, chars }` after. */
function sharedSample(entry: unknown): SizedFirstByte[] {
  if (typeof entry === "number") return entry >= 0 ? [{ ms: entry }] : [];
  const { ms, chars } = (entry ?? {}) as { ms?: unknown; chars?: unknown };
  if (typeof ms !== "number" || ms < 0) return [];
  return [{ ms, ...(typeof chars === "number" && chars > 0 ? { chars } : {}) }];
}

function readShared(file: string): Map<string, SizedFirstByte[]> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { shapes?: Record<string, unknown> };
    const shapes = new Map<string, SizedFirstByte[]>();
    for (const [key, value] of Object.entries(parsed.shapes ?? {}))
      if (Array.isArray(value)) shapes.set(key, value.flatMap(sharedSample).slice(-KEPT));
    return shapes;
  } catch {
    return new Map();
  }
}

const shapeKey = (model: string, stage?: string, effort?: string) =>
  `${model}|${stage ?? ""}|${effort ?? ""}`;
