import type { ModelMessage } from "@ai-sdk/provider-utils";
import { canonical } from "../specs/hash.js";
import { ARTIFACT_LANGUAGE } from "./context.js";
import type { WorkflowStore } from "./store.js";

/**
 * The prompt sections of an attempt's first step (#2597), recorded as `prompt.sections` in
 * `attempts/ID/usage.json` next to `prompt.firstBytes`. R84 md-site: test tasks' first attempts
 * sent 33 to 37 KB and their re-runs after two correctives 74 to 465 KB, and the record held only
 * the total, so the round could not say which part of the prompt had grown.
 */
export interface PromptSection {
  name: string;
  bytes: number;
}

/** A prompt larger than this many times the median first attempt of the run is noticed. */
export const LARGE_PROMPT_FACTOR = 3;

/** JSON keys, punctuation and the input and snapshot hashes of the workflow context. */
const FRAMING = "framing";
/** The message around the prompt (role, content parts, cache options) and any host notice. */
const ENVELOPE = "envelope";

interface Piece {
  name: string;
  text: string;
}

/**
 * Splits a workflow context (`buildWorkflowContext`) into contiguous named pieces that spell it
 * exactly: the project instructions and skills (`instructions`), the host's fixed rules (`rules`),
 * each run-level document (`request`, `research`, `spec`, `plan`, `graph`) and each key of the
 * attempt's own input (`input.task`, `input.evidence`, `input.taskFiles`, ...). A prompt that is
 * not a workflow context is one piece, `prompt`.
 */
export function contextPieces(text: string): Piece[] {
  const whole = [{ name: "prompt", text }];
  const last = text.lastIndexOf("\n");
  const previous = last > 0 ? text.lastIndexOf("\n", last - 1) : -1;
  if (previous < 0) return whole;
  const documents = objectPieces(text.slice(previous + 1, last), (key) => key);
  const attempt = objectPieces(text.slice(last + 1), (key) => (key === "extra" ? "input" : null));
  if (!documents || !attempt) return whole;
  const header = text.slice(0, previous + 1);
  const rules = header.lastIndexOf(`\n${ARTIFACT_LANGUAGE}\n`);
  return [
    ...(rules < 0
      ? [{ name: "instructions", text: header }]
      : [
          { name: "instructions", text: header.slice(0, rules + 1) },
          { name: "rules", text: header.slice(rules + 1) },
        ]),
    ...documents,
    { name: FRAMING, text: "\n" },
    ...attempt.flatMap((piece) => {
      if (piece.name !== "input") return [piece];
      return objectPieces(piece.text, (key) => `input.${key}`) ?? [piece];
    }),
  ];
}

/**
 * The pieces of one canonical JSON object: each value named by `name(key)`, or framing when that
 * is null, and the keys and punctuation as framing. Null when the line is not canonical JSON.
 */
function objectPieces(line: string, name: (key: string) => string | null): Piece[] | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (canonical(value) !== line) return null;
  const record = value as Record<string, unknown>;
  const pieces: Piece[] = [{ name: FRAMING, text: "{" }];
  for (const [index, key] of Object.keys(record).sort().entries()) {
    pieces.push({ name: FRAMING, text: `${index ? "," : ""}${JSON.stringify(key)}:` });
    pieces.push({ name: name(key) ?? FRAMING, text: canonical(record[key]) });
  }
  pieces.push({ name: FRAMING, text: "}" });
  return pieces;
}

/** The bytes a text takes inside a serialized JSON string, its quotes left out. */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * The messages with the prompt's text taken out of the first user message that carries it whole
 * (as one string or as text parts that join to it); null when no message does.
 */
function withoutPrompt(messages: readonly ModelMessage[], prompt: string): ModelMessage[] | null {
  const index = messages.findIndex((message) => {
    if (message.role !== "user") return false;
    if (typeof message.content === "string") return message.content === prompt;
    return (
      message.content.every((part) => part.type === "text") &&
      message.content.map((part) => (part.type === "text" ? part.text : "")).join("") === prompt
    );
  });
  const message = messages[index];
  if (message?.role !== "user") return null;
  const emptied: ModelMessage =
    typeof message.content === "string"
      ? { ...message, content: "" }
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === "text" ? { ...part, text: "" } : part,
          ),
        };
  return messages.map((m, i) => (i === index ? emptied : m));
}

/**
 * The named sections of the messages an attempt's first step sent, in prompt order, whose bytes sum
 * exactly to their serialized size (`prompt.firstBytes`): the prompt's pieces (`contextPieces`)
 * as they are escaped in the JSON, `framing` for its JSON keys and punctuation, and `envelope` for
 * the rest of the messages. Messages that do not carry the prompt are one section, `messages`.
 */
export function promptSections(messages: readonly ModelMessage[], prompt: string): PromptSection[] {
  const total = Buffer.byteLength(JSON.stringify(messages));
  const coarse = [{ name: "messages", bytes: total }];
  try {
    return splitSections(messages, prompt, total) ?? coarse;
  } catch {
    // Recording only: a prompt the split cannot read keeps its total.
    return coarse;
  }
}

function splitSections(
  messages: readonly ModelMessage[],
  prompt: string,
  total: number,
): PromptSection[] | null {
  const emptied = withoutPrompt(messages, prompt);
  if (!emptied) return null;
  const bytes = new Map<string, number>();
  for (const piece of contextPieces(prompt))
    bytes.set(piece.name, (bytes.get(piece.name) ?? 0) + escapedBytes(piece.text));
  bytes.set(ENVELOPE, Buffer.byteLength(JSON.stringify(emptied)));
  const sections = [...bytes].map(([name, size]) => ({ name, bytes: size }));
  // The pieces spell the prompt, so this holds; a mismatch keeps the total rather than a wrong split.
  return sections.reduce((sum, s) => sum + s.bytes, 0) === total ? sections : null;
}

/** The largest section; the first of equals. */
export function largestSection(sections: readonly PromptSection[]): PromptSection | null {
  return sections.reduce<PromptSection | null>(
    (best, section) => (best && best.bytes >= section.bytes ? best : section),
    null,
  );
}

/** What the large-prompt notice of a task attempt reports (#2597). */
export interface LargePrompt {
  firstBytes: number;
  /** The median `firstBytes` of the first attempt of each other task of the run. */
  medianBytes: number;
  firstAttempts: number;
  largest: PromptSection;
}

/**
 * Whether a task attempt's first prompt is more than `LARGE_PROMPT_FACTOR` times the median of
 * the run's first attempts: the first attempt of each task, other than this one, that recorded a
 * prompt size. Null when it is not, or nothing compares.
 */
export function largePrompt(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
  prompt: { firstBytes: number; sections?: PromptSection[] } | undefined,
): LargePrompt | null {
  const largest = prompt?.sections ? largestSection(prompt.sections) : null;
  if (!prompt || !largest) return null;
  const firsts = new Set<string>();
  const seen = new Set<string>();
  for (const [attempt, { taskId }] of store.attemptTaskGenerations(runId)) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    if (attempt !== attemptId) firsts.add(attempt);
  }
  const sizes = store
    .latestArtifacts(runId, "attempts/%/usage.json")
    .filter((row) => firsts.has(row.logical_path.split("/")[1] ?? ""))
    .flatMap((row) => {
      const bytes = store.readArtifactJson<{ prompt?: { firstBytes?: number } }>(runId, row).prompt
        ?.firstBytes;
      return typeof bytes === "number" ? [bytes] : [];
    })
    .sort((a, b) => a - b);
  if (!sizes.length) return null;
  const mid = Math.floor(sizes.length / 2);
  const medianBytes =
    sizes.length % 2
      ? (sizes[mid] ?? 0)
      : Math.round(((sizes[mid - 1] ?? 0) + (sizes[mid] ?? 0)) / 2);
  if (prompt.firstBytes <= LARGE_PROMPT_FACTOR * medianBytes) return null;
  return { firstBytes: prompt.firstBytes, medianBytes, firstAttempts: sizes.length, largest };
}

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;

/** The progress line of a large-prompt notice. */
export function largePromptText(notice: LargePrompt & { taskId: string | null }): string {
  const times = notice.medianBytes ? (notice.firstBytes / notice.medianBytes).toFixed(1) : "∞";
  return `Large prompt${notice.taskId ? ` for ${notice.taskId}` : ""}: ${kb(notice.firstBytes)}, ${times} times the median first attempt (${kb(notice.medianBytes)}); largest section ${notice.largest.name} (${kb(notice.largest.bytes)})`;
}
