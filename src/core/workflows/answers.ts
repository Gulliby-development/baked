import { WorkflowFault } from "./errors.js";

/**
 * The answer keys a clarification request offers: its questions' ids, or its findings' ids
 * (`SPEC-CONFLICT-T006`), with the positional keys the terminal UI uses when an item has none.
 */
export function clarificationKeys(body: unknown): string[] {
  const { questions, findings } = (body ?? {}) as {
    questions?: { id?: unknown }[];
    findings?: { id?: unknown }[];
  };
  if (Array.isArray(questions) && questions.length)
    return questions.map((q, i) => (typeof q?.id === "string" ? q.id : `Q${i + 1}`));
  if (Array.isArray(findings) && findings.length)
    return findings.map((f, i) => (typeof f?.id === "string" ? f.id : `F${i + 1}`));
  return [];
}

const describe = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "an array"
      : typeof value === "object"
        ? "an object"
        : `a ${typeof value}`;

/**
 * Reads the answers to a clarification from the CLI's `--answers-file` or the API body. The
 * expected shape is a flat object of strings keyed by question id; the shape the run stores and
 * `workflow status --json` shows (`{"answers": {...}}`) is accepted too (#1463). Anything else
 * fails with the offending key and the ids the request asks about.
 */
export function clarificationAnswers(
  raw: unknown,
  expected: readonly string[] = [],
): Record<string, string> {
  const unwrapped =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw).length === 1 &&
    "answers" in raw &&
    (raw as { answers: unknown }).answers &&
    typeof (raw as { answers: unknown }).answers === "object" &&
    !Array.isArray((raw as { answers: unknown }).answers)
      ? (raw as { answers: unknown }).answers
      : raw;
  const example = `{"${expected[0] ?? "Q1"}": "your answer"}`;
  const hint = `${expected.length ? ` The request asks about ${expected.join(", ")}.` : ""} Expected a JSON object of strings keyed by question id, for example ${example}.`;
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped))
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `Answers must be a JSON object of strings, not ${describe(unwrapped)}.${hint}`,
    );
  const entries = Object.entries(unwrapped);
  const wrong = entries.find(([, value]) => typeof value !== "string");
  if (wrong)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `Answers must be a JSON object of strings; question id "${wrong[0]}" has ${describe(wrong[1])} value.${hint}`,
    );
  if (!entries.length) throw new WorkflowFault("INVALID_DEFINITION", `Answers are empty.${hint}`);
  return Object.fromEntries(entries) as Record<string, string>;
}
