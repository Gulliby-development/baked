import { hashBytes } from "../specs/hash.js";

/**
 * The bound on the evidence section of an agent's input (#2617). R85 md-site: the implementer
 * T012 prompts were 472 to 504 KB with `input.evidence` 379 to 393 KB, 224 KB of it fourteen
 * identical copies of a passing `biome check .` (17,604 bytes each), and the section is resent on
 * every step. The content of the listed entries, as escaped in the prompt's JSON, stays within
 * this many characters; what does not fit is shortened, newest and most telling entries first.
 */
export const EVIDENCE_BUDGET_CHARS = 60_000;

/** A shortened entry keeps at least this much of its text, or none of it. */
const MIN_KEPT_CHARS = 1_000;

/** The longest one-line summary of a passing check's output. */
const SUMMARY_CHARS = 200;

/** A current evidence entry, read, before it is bounded. */
export interface EvidenceItem {
  id: string;
  handle: string | undefined;
  kind: string;
  /** The entry's text (a command record, a diff, a review); absent for a read. */
  content?: string;
  /** A read's summary, which takes the place of what it read. */
  read?: unknown;
  /** The check run the entry records, when it is one, with `checkFacts` of its whole record. */
  check?: { id: string; status: string; exitCode: number | null } & Partial<CheckFacts>;
}

/** What the bound did to the section, recorded in the attempt's `prompt` record. */
export interface EvidenceBound {
  /** The budget, in characters of escaped entry content. */
  budget: number;
  /** Current entries the input selected. */
  entries: number;
  /** Entries listed: each repeated run once, with its count. */
  listed: number;
  /** Entries left out as repeats of a listed one (same check definition and output). */
  collapsed: number;
  /** Passing checks listed by their status and one line instead of their output. */
  summarized: number;
  /** Characters of content the budget left out, and the handles of the entries shortened. */
  cutChars: number;
  cut: string[];
  /** Characters of content listed. */
  keptChars: number;
}

const escaped = (text: string) => JSON.stringify(text).length - 2;

/** The last line of a check's output that says something, at most `SUMMARY_CHARS` long. */
function summaryLine(output: string): string {
  const line =
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS)}...` : line;
}

/** What a check record's whole text says, before the per-entry cut. */
export interface CheckFacts {
  definitionHash: string;
  /** The hash of the command's output. */
  outputHash: string;
  /** The last line of the output that says something. */
  summary: string;
}

/** The facts of a check record (`checks/<id>/<effect>.json`); null when the text is not one. */
export function checkFacts(content: string): CheckFacts | null {
  try {
    const record = JSON.parse(content) as { output?: unknown; definitionHash?: unknown };
    return typeof record.output === "string" && typeof record.definitionHash === "string"
      ? {
          definitionHash: record.definitionHash,
          outputHash: hashBytes(record.output),
          summary: summaryLine(record.output),
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * The longest head of a text whose escaped form, with the note after it, fits in `room`
 * characters; empty when not even `MIN_KEPT_CHARS` of it fit.
 */
function head(text: string, room: number, note: string): string {
  let size = Math.min(text.length, room - escaped(note));
  while (size >= MIN_KEPT_CHARS && escaped(text.slice(0, size)) + escaped(note) > room)
    size = Math.floor(size * 0.9);
  return size >= MIN_KEPT_CHARS ? `${text.slice(0, size)}${note}` : "";
}

/**
 * Bounds the evidence section (#2617), entries in their stored order (oldest first):
 *  1. a check that passed is its status, not its output: listed with its check id, status, exit
 *     code and the last line of its output, unless the input asked for it (`only`);
 *  2. runs with the same check definition, status and output are listed once, at the latest,
 *     with the handles of the earlier ones (`sameAs`);
 *  3. the content of what is listed stays within `budget` characters: entries the input asked
 *     for first, then failing or unsettled command output, diffs, everything else, newest first in
 *     each; an entry that does not fit is shortened, and one with no room left keeps its id and
 *     a note.
 */
export function boundEvidence(
  items: readonly EvidenceItem[],
  options: { only?: ReadonlySet<string>; budget?: number } = {},
): { entries: Record<string, unknown>[]; bound: EvidenceBound } {
  const budget = options.budget ?? EVIDENCE_BUDGET_CHARS;
  const asked = (item: EvidenceItem) => options.only?.has(item.id) === true;
  // One key per distinct run: a check's definition, status and output, or any entry's whole text.
  const shaped = items.map((item) => {
    const check = item.check;
    const passed = item.check?.status === "passed" && !asked(item);
    const key =
      item.read !== undefined
        ? `read:${item.id}`
        : check?.definitionHash && check.outputHash
          ? `check:${check.id}:${check.status}:${check.definitionHash}:${check.outputHash}`
          : `${item.kind}:${hashBytes(item.content ?? "")}`;
    return { item, passed, key };
  });
  const latest = new Map<string, number>();
  for (const [index, entry] of shaped.entries()) latest.set(entry.key, index);
  const earlier = new Map<string, string[]>();
  for (const [index, entry] of shaped.entries())
    if (latest.get(entry.key) !== index)
      earlier.set(entry.key, [
        ...(earlier.get(entry.key) ?? []),
        entry.item.handle ?? entry.item.id,
      ]);
  const listed = shaped.filter((entry, index) => latest.get(entry.key) === index);
  const tier = ({ item, passed }: (typeof listed)[number]) =>
    asked(item)
      ? 0
      : item.kind === "command" && !passed
        ? 1
        : item.kind === "diff"
          ? 2
          : passed
            ? 4
            : 3;
  const order = listed
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => tier(a.entry) - tier(b.entry) || b.index - a.index);
  let room = budget;
  let cutChars = 0;
  const cut: string[] = [];
  const entries = new Map<number, Record<string, unknown>>();
  for (const { entry, index } of order) {
    const { item, passed, key } = entry;
    const base: Record<string, unknown> = { id: item.id, handle: item.handle, kind: item.kind };
    const repeats = earlier.get(key);
    if (repeats) Object.assign(base, { repeats: repeats.length + 1, sameAs: repeats });
    if (item.read !== undefined) {
      const size = JSON.stringify(item.read).length;
      if (size <= room) {
        room -= size;
        entries.set(index, { ...base, read: item.read });
      } else {
        cutChars += size;
        cut.push(item.handle ?? item.id);
        entries.set(index, {
          ...base,
          cut: "Left out over the evidence budget; read the file again.",
        });
      }
      continue;
    }
    if (passed && item.check) {
      const summary = item.check.summary ?? "";
      room -= escaped(summary);
      entries.set(index, {
        ...base,
        check: item.check.id,
        status: item.check.status,
        exitCode: item.check.exitCode,
        summary,
        note: "The check passed; its output is left out.",
      });
      continue;
    }
    const content = item.content ?? "";
    const size = escaped(content);
    if (size <= room) {
      room -= size;
      entries.set(index, { ...base, content });
      continue;
    }
    const kept = head(
      content,
      room,
      `\n... cut at the evidence budget (${budget} characters for all entries)${item.kind === "diff" ? "; read the files for the rest" : ""}`,
    );
    room -= escaped(kept);
    cutChars += content.length - Math.min(content.length, kept.length);
    cut.push(item.handle ?? item.id);
    entries.set(
      index,
      kept
        ? { ...base, content: kept }
        : {
            ...base,
            ...(item.check ? { check: item.check.id, status: item.check.status } : {}),
            cut: `Left out over the evidence budget (${budget} characters for all entries)${item.kind === "diff" ? "; read the files it changed" : ""}.`,
          },
    );
  }
  const result = listed.map((_, index) => entries.get(index) ?? {});
  return {
    entries: result,
    bound: {
      budget,
      entries: items.length,
      listed: listed.length,
      collapsed: items.length - listed.length,
      summarized: listed.filter((entry) => entry.passed).length,
      cutChars,
      cut,
      keptChars: budget - room,
    },
  };
}
