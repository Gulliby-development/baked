/**
 * Whether the failing checks of a task moved between two of its attempts (#1351): the number of
 * failing tests dropped, or the first failure is a different one. A task that used its
 * continuation and its restart gets one more attempt only on such progress.
 */

export interface CheckState {
  status: "passed" | "failed";
  /** Failing tests the output reports, or null when it names no count. */
  failed: number | null;
  /** The first failure line, without timings, or null when none is recognised. */
  first: string | null;
}

const COUNT = /(\d+)\s+(?:tests?\s+)?fail(?:ed|ures?|s)?\b/gi;
const FAIL_LINE = /^\s*(?:\(fail\)|--- FAIL:|FAIL\b|not ok\b|✗|×)/;
const FIRST =
  /\(fail\)|--- FAIL:|\bFAIL\b|not ok\b|✗|×|\berror\b|AssertionError|panicked at|\bExpected\b/i;
const TIMING = /\[?\d+(?:\.\d+)?\s?(?:ms|s)\]?/g;

/** The failure count and first failure of a check's output. */
export function checkState(status: "passed" | "failed", output: string): CheckState {
  if (status === "passed") return { status, failed: 0, first: null };
  const counts = [...output.matchAll(COUNT)].map((match) => Number(match[1]));
  const lines = output.split(/\r?\n/);
  const failLines = lines.filter((line) => FAIL_LINE.test(line)).length;
  const failed = counts.length ? (counts.at(-1) ?? null) : failLines || null;
  const line = lines.find((candidate) => FIRST.test(candidate));
  const first = line ? line.replace(TIMING, "").replace(/\s+/g, " ").trim().slice(0, 300) : null;
  return { status, failed, first };
}

/**
 * Whether `current` shows progress over `previous` on the checks both ran: a failing check
 * passes now, fewer tests fail, or the first failure moved. Nothing to compare is no progress.
 */
export function checksProgressed(
  previous: Map<string, CheckState>,
  current: Map<string, CheckState>,
): boolean {
  for (const [id, now] of current) {
    const before = previous.get(id);
    if (!before || before.status === "passed") continue;
    if (now.status === "passed") return true;
    if (now.failed !== null && before.failed !== null && now.failed < before.failed) return true;
    if (now.first !== null && before.first !== null && now.first !== before.first) return true;
  }
  return false;
}
