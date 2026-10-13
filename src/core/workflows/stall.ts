import { WorkflowFault } from "./errors.js";

/**
 * Deadlines and stall limits of workflow runs (`workflows.stall` in the configuration). A stalled
 * run is one that is alive and renewing its lease but has stopped making progress: round 8 runs
 * froze for 20 to 60 minutes inside `edit_file` after the file was written, and nothing noticed.
 */
export interface StallSettings {
  /** Deadline of a file tool call (read, edit, search); these finish in seconds. */
  toolTimeoutMs: number;
  /** Deadline of any other tool call (commands, git, analysis, MCP); they carry their own limits. */
  commandToolMs: number;
  /** A model attempt with no journaled progress for this long is aborted and the step restarts. */
  stepStallMs: number;
  /** Tool calls of one attempt that may hit their deadline before the attempt itself is aborted. */
  maxToolTimeouts: number;
  /** Times a run that stopped on a stall resumes by itself; 0 turns the automatic resume off. */
  autoResumes: number;
  /**
   * Times a run that blocked with `provider_unavailable` (the provider stayed down or the
   * connection kept dropping after the in-call retries) resumes by itself; 0 turns it off.
   */
  providerResumes: number;
  /** Wait before the first provider resume; each later wait is three times the previous one. */
  providerWaitMs: number;
}

export const DEFAULT_STALL_SETTINGS: StallSettings = {
  toolTimeoutMs: 2 * 60_000,
  commandToolMs: 30 * 60_000,
  // A review step took 569 s with no tool call in the middle of one model call; twice that is
  // far beyond any healthy silence.
  stepStallMs: 20 * 60_000,
  maxToolTimeouts: 3,
  autoResumes: 3,
  // 1, 3 and 9 minutes: long enough for a dropped connection or a capacity spike to pass.
  providerResumes: 3,
  providerWaitMs: 60_000,
};

/** The wait before provider resume number `attempt` (1-based). */
export function providerResumeWaitMs(settings: StallSettings, attempt: number): number {
  return settings.providerWaitMs * 3 ** Math.max(0, attempt - 1);
}

export function stallSettings(config?: {
  workflows?: { stall?: Partial<StallSettings> | undefined } | undefined;
}): StallSettings {
  return { ...DEFAULT_STALL_SETTINGS, ...(config?.workflows?.stall ?? {}) };
}

/** Tools that read or edit files and return in seconds; every other tool gets the long deadline. */
const FILE_TOOLS = new Set([
  "read",
  "edit_file",
  "multi_edit",
  "undo_edit",
  "ast_edit",
  "structural_edit",
  "delete_file",
  "list_dir",
  "grep",
  "glob",
  "navigate",
]);

export function toolDeadlineMs(settings: StallSettings, name: string): number {
  return FILE_TOOLS.has(name) ? settings.toolTimeoutMs : settings.commandToolMs;
}

/** Why an attempt was aborted for silence, recognised by the scheduler and the service. */
export const STALL_REASON = "step_stalled";
export function stalledFault(message: string): WorkflowFault {
  return new WorkflowFault("OUTPUT_INVALID", message, { reason: STALL_REASON });
}
export function isStall(error: unknown): boolean {
  return error instanceof WorkflowFault && error.details.reason === STALL_REASON;
}

/** A tool call that did not return within its deadline. */
export class ToolDeadlineError extends Error {
  constructor(
    readonly tool: string,
    readonly deadlineMs: number,
  ) {
    super(
      `Tool ${tool} did not return within ${Math.round(deadlineMs / 1000)} s and was abandoned; its result is unknown.`,
    );
    this.name = "ToolDeadlineError";
  }
}

/** Runs `action` and rejects with a ToolDeadlineError when it has not settled within `ms`. */
export async function withDeadline<T>(
  tool: string,
  ms: number,
  action: () => Promise<T>,
): Promise<T> {
  if (!(ms > 0)) return action();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = action();
  // A call abandoned at its deadline may still fail later; nobody awaits that.
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolDeadlineError(tool, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Progress {
  at: number;
  tools: number;
}
const progress = new Map<string, Progress>();
const entry = (runId: string): Progress => {
  let value = progress.get(runId);
  if (!value) {
    value = { at: Date.now(), tools: 0 };
    progress.set(runId, value);
  }
  return value;
};
/** Marks a sign of life of a run in this process: an event, a tool call, a model step. */
export function touchProgress(runId: string): void {
  entry(runId).at = Date.now();
}
/** Tool calls start and end inside their own deadline, so a call in flight is progress. */
export function toolStarted(runId: string): void {
  const value = entry(runId);
  value.tools++;
  value.at = Date.now();
}
export function toolEnded(runId: string): void {
  const value = entry(runId);
  value.tools = Math.max(0, value.tools - 1);
  value.at = Date.now();
}
/** Milliseconds since the run last showed progress in this process, 0 while a tool is in flight. */
export function silentMs(runId: string, now = Date.now()): number {
  const value = progress.get(runId);
  if (!value || value.tools > 0) return 0;
  return Math.max(0, now - value.at);
}
export function forgetProgress(runId: string): void {
  progress.delete(runId);
}
