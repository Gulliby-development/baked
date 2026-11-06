import { posix } from "node:path";
import { type Fence, fences } from "../verification/doc-examples.js";
import { isDocumentationPath } from "./affected-tests.js";
import type { TaskGraph } from "./schemas.js";

/**
 * Delivered documents compared with the command transcripts the request says they must hold
 * exactly (#2648). R88 pokerank: the request gave a fenced `$` transcript the README had to hold
 * "exactly as shown", the implementer wrote its `printf 'board ...\n...'` line with a doubled
 * backslash, the reviewer found it with no repro, so the review gate kept it as a note, and the
 * run completed with the README's first example failing as written (R87 citeseek, Python, the
 * same). `suppliedDrifts` compares a whole file, a section or a diff the request gives for a
 * path; a transcript the request gives for part of a document was compared by nothing.
 *
 * A request block is a transcript when one of its lines starts with the `$ ` prompt, and it fixes
 * a document's text when the sentence right before it says so: a word of exactness (`exactly`,
 * `verbatim`, `as shown`, `word for word`) and a document (`README`, a Markdown path, `docs`,
 * `documentation`). Each such block is compared with the documents the plan writes that the prose
 * names (every document the plan writes when it names none by file): a document that holds any
 * line of the block, exactly or nearly, must hold every line of it. A line the document has
 * nearly (`closest`, such as the same line with a doubled backslash) is `differs`; a line it lacks
 * while it holds the others is `missing`. Line ends and trailing spaces are not compared.
 *
 * The `transcript_drift` reason records each as a would-stop (shadow); its promotion makes it a
 * finding the host proved, which the review gate repairs in any round.
 */

export interface TranscriptDrift {
  /** The tasks of the plan that write the document. */
  tasks: string[];
  path: string;
  /** The request line where the transcript's block starts, from 1. */
  block: number;
  problem: "differs" | "missing";
  /** The transcript's line, cut to `EXCERPT` characters. */
  expected: string;
  /** The document's line nearest to it and its number, or null when it has none. */
  actual: { line: number; text: string } | null;
}

const EXCERPT = 200;
const cut = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text);
const EXACT =
  /\b(?:exactly|verbatim|word for word|unchanged|character for character)\b|\bas (?:shown|given|written)\b/i;
const DOCUMENT = /\bREADME\b|\.(?:md|mdx|markdown|rst|adoc)\b|\bdocs?\b|\bdocumentation\b/i;
/**
 * The prose a transcript's block is read with: its last sentence before the block, which may wrap
 * over several lines (a line that ends a sentence, `.`, `!`, `?` or `:`, ends the one before).
 */
function leadIn(prose: string): string {
  const lines = prose.trim().split("\n");
  let from = lines.length - 1;
  while (from > 0 && !/[.!?:]$/.test(lines[from - 1] ?? "")) from--;
  return lines.slice(Math.max(from, 0)).join(" ");
}

/** The request's transcript blocks whose prose says a document must hold them exactly. */
export function exactTranscripts(request: string): Fence[] {
  return fences(request).filter((fence) => {
    if (fence.diff || !fence.lines.some((line) => /^\s*\$ \S/.test(line))) return false;
    const prose = leadIn(fence.prose);
    return EXACT.test(prose) && DOCUMENT.test(prose);
  });
}

const compared = (lines: readonly string[]): string[] =>
  lines.map((line) => line.replace(/\r$/, "").trimEnd()).filter((line) => line.trim());

/** The document's line most like `expected`: the longest shared start and end, at least half of it. */
function closest(file: readonly string[], expected: string): TranscriptDrift["actual"] {
  let best: TranscriptDrift["actual"] = null;
  let score = 0;
  for (const [index, text] of file.entries()) {
    const max = Math.min(text.length, expected.length);
    let start = 0;
    while (start < max && text[start] === expected[start]) start++;
    let end = 0;
    while (end < max - start && text[text.length - 1 - end] === expected[expected.length - 1 - end])
      end++;
    if (start + end > score) {
      score = start + end;
      best = { line: index + 1, text: cut(text) };
    }
  }
  return score * 2 >= expected.length && score > 0 ? best : null;
}

/** How `delivered` leaves one transcript, or null when it holds it or holds none of it. */
export function transcriptDrift(
  tasks: string[],
  path: string,
  fence: Pick<Fence, "start" | "lines">,
  delivered: string,
): TranscriptDrift | null {
  const expected = compared(fence.lines);
  const file = delivered.split("\n").map((line) => line.replace(/\r$/, "").trimEnd());
  const present = new Set(file);
  const absent = expected.filter((line) => !present.has(line));
  if (!absent.length) return null;
  const near = absent.map((line) => ({ line, actual: closest(file, line) }));
  const differs = near.find((n) => n.actual !== null);
  const block = fence.start - 1;
  if (differs)
    return {
      tasks,
      path,
      block,
      problem: "differs",
      expected: cut(differs.line),
      actual: differs.actual,
    };
  // None of it nearly there and none of it exactly: the document does not show this transcript.
  if (absent.length === expected.length) return null;
  return { tasks, path, block, problem: "missing", expected: cut(absent[0] ?? ""), actual: null };
}

/**
 * Every document the plan writes that leaves a transcript the request says it must hold exactly,
 * read through `read` (null: no file), once per document and block.
 */
export function transcriptDrifts(
  request: string,
  graph: Pick<TaskGraph, "tasks">,
  read: (path: string) => string | null,
): TranscriptDrift[] {
  const transcripts = exactTranscripts(request);
  if (!transcripts.length) return [];
  const writers = new Map<string, string[]>();
  for (const task of graph.tasks)
    for (const write of task.writes)
      if (write.action !== "delete" && isDocumentationPath(write.path))
        writers.set(write.path, [...(writers.get(write.path) ?? []), task.id]);
  const out: TranscriptDrift[] = [];
  for (const fence of transcripts) {
    const prose = leadIn(fence.prose).toLowerCase();
    const named = [...writers.keys()].filter(
      (path) =>
        prose.includes(path.toLowerCase()) || prose.includes(posix.basename(path).toLowerCase()),
    );
    for (const path of named.length ? named : [...writers.keys()]) {
      const delivered = read(path);
      if (delivered === null) continue;
      const drift = transcriptDrift([...new Set(writers.get(path))], path, fence, delivered);
      if (drift) out.push(drift);
    }
  }
  return out;
}

/** The would-stop summary of one drift, in the words of the finding its promotion makes. */
export function transcriptDriftSummary(drift: TranscriptDrift): string {
  const where = `the request's transcript (its block at line ${drift.block})`;
  return drift.problem === "differs" && drift.actual
    ? `${drift.tasks.join(", ")} delivered ${drift.path}, which has ${JSON.stringify(drift.actual.text)} at line ${drift.actual.line} where ${where} gives ${JSON.stringify(drift.expected)}. A repair task would rewrite it from the request's text.`
    : `${drift.tasks.join(", ")} delivered ${drift.path}, which shows ${where} without its line ${JSON.stringify(drift.expected)}. A repair task would add it from the request's text.`;
}
