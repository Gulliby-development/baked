/**
 * The refusals of a write the tool policy makes because the file is not what the task's write
 * expects, by code, with the message each throws. A refusal is a host fact, so the invalid-output
 * repeat key is built from these (code, path) pairs, never from the model's account of them (#2520).
 */
export const WRITE_REFUSALS = {
  changed: "File changed outside this attempt",
  exists: "Create target already exists",
  missing: "Modify target is missing",
} as const;
export type WriteRefusal = keyof typeof WRITE_REFUSALS;

/** The refusal a failed call's journaled error names, with its path; null for any other error. */
export function writeRefusalOf(error: string): { code: WriteRefusal; path: string } | null {
  for (const [code, text] of Object.entries(WRITE_REFUSALS) as [WriteRefusal, string][])
    if (error.startsWith(`${text}: `)) return { code, path: error.slice(text.length + 2) };
  return null;
}
