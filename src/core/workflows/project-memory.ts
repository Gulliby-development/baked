import { hashBytes } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import type { RunPolicy } from "./schemas.js";
import { PolicySchema } from "./schemas.js";
import { newId, type WorkflowStore } from "./store.js";

/** Logical path of the project memory a run captures at creation. */
export const PROJECT_MEMORY_ARTIFACT = "project/run-memory.md";
/** Earlier runs read for project memory, newest first. */
export const MEMORY_RUNS = 30;
const MAX_ANSWERS = 12;
const MAX_ASSUMPTIONS = 12;
const MAX_CHECKS = 8;
const MAX_QUESTION = 240;
const MAX_ANSWER = 480;
const MAX_ASSUMPTION = 400;

export interface MemoryAnswer {
  question: string;
  answer: string;
  runId: string;
}
export interface MemoryCheck {
  command: string;
  runs: number;
}
export interface ProjectMemory {
  answers: MemoryAnswer[];
  assumptions: { text: string; runId: string }[];
  checks: MemoryCheck[];
  /** Notes people added themselves; absent in memory captured before notes existed. */
  notes?: string[];
}

export type MemoryEntryKind = "note" | "answer" | "assumption" | "check";
/** One entry of project memory as people review and edit it. */
export interface MemoryEntry {
  /** Stable across runs: derived from the question, assumption or command; random for a note. */
  id: string;
  kind: MemoryEntryKind;
  /** The answer, assumption, command or note a new run reads (a person's rewording when edited). */
  text: string;
  /** The question an answer answers. */
  question?: string;
  /** The newest run that recorded the entry; absent for a note. */
  runId?: string;
  /** For a check: how many completed runs it passed in. */
  runs?: number;
  /** What runs recorded, when a person reworded the entry. */
  recorded?: string;
  hidden: boolean;
}
export type MemoryEdit =
  | { action: "add"; text: string }
  | { action: "edit"; id: string; text: string }
  | { action: "forget"; id: string }
  | { action: "restore"; id: string };
export interface ProjectMemoryView {
  /** False when the workspace policy turns project memory off (`projectMemory: false`). */
  enabled: boolean;
  /** What a run started now would read, in order: notes, answers, assumptions, checks. */
  entries: (MemoryEntry & { sent: boolean })[];
  /** Entries a person forgot; `restore` brings them back. */
  hidden: MemoryEntry[];
  /** The text a run started now would receive, or null when there is nothing to say. */
  rendered: string | null;
}

const MAX_NOTES = 12;
export const MAX_NOTE = 600;
const LIMITS: Record<Exclude<MemoryEntryKind, "note">, number> = {
  answer: MAX_ANSWERS,
  assumption: MAX_ASSUMPTIONS,
  check: MAX_CHECKS,
};

const clip = (text: string, max: number): string => {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const normal = (text: string): string => clip(text, MAX_QUESTION).toLowerCase();
const entryId = (prefix: string, key: string): string => `${prefix}-${hashBytes(key).slice(0, 10)}`;

/**
 * The question an answer key names. The terminal app keys answers as "ID: question", the CLI and
 * the local API by the question ID or its position (`Q1`); anything else is taken as the question.
 */
export function answeredQuestion(
  key: string,
  questions: readonly { id?: string; question: string }[],
): string {
  const id = key.match(/^([\w.-]+):\s/)?.[1] ?? key.trim();
  const found =
    questions.find((q) => q.id === id) ??
    (/^Q\d+$/.test(id) ? questions[Number(id.slice(1)) - 1] : undefined);
  if (found) return found.question;
  return key.match(/^[\w.-]+:\s(.+)$/s)?.[1] ?? key;
}

const commandOf = (check: RunPolicy["checks"][number]): string =>
  [check.cwd === "." ? null : `(in ${check.cwd})`, check.executable, ...check.args]
    .filter(Boolean)
    .join(" ");

/** Everything earlier runs recorded, newest first per kind, before limits and edits apply. */
function recordedEntries(store: WorkflowStore, limit: number): MemoryEntry[] {
  const answers: MemoryEntry[] = [];
  const asked = new Set<string>();
  const assumptions: MemoryEntry[] = [];
  const assumed = new Set<string>();
  const passed = new Map<string, Set<string>>();
  const newest = new Map<string, string>();
  for (const run of store.pastRuns(limit)) {
    for (const request of store.requests(run.id).reverse()) {
      if (request.kind !== "clarification" || request.status !== "accepted") continue;
      if (request.actor !== "user" || !request.answer_json) continue;
      let questions: { id?: string; question: string }[] = [];
      let given: Record<string, unknown> = {};
      try {
        const body = JSON.parse(request.body_json) as { questions?: unknown };
        if (!Array.isArray(body.questions)) continue;
        questions = body.questions.filter(
          (q): q is { id?: string; question: string } =>
            !!q &&
            typeof q === "object" &&
            typeof (q as { question?: unknown }).question === "string",
        );
        const decision = JSON.parse(request.answer_json) as { answers?: unknown };
        if (decision.answers && typeof decision.answers === "object")
          given = decision.answers as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(given)) {
        if (typeof value !== "string" || !value.trim()) continue;
        const question = clip(answeredQuestion(key, questions), MAX_QUESTION);
        if (asked.has(normal(question))) continue;
        asked.add(normal(question));
        answers.push({
          id: entryId("a", normal(question)),
          kind: "answer",
          question,
          text: clip(value, MAX_ANSWER),
          runId: run.id,
          hidden: false,
        });
      }
    }
    if (run.status !== "completed") continue;
    try {
      for (const text of store.state(run.id).spec?.assumptions ?? []) {
        const key = normal(text);
        if (assumed.has(key)) continue;
        assumed.add(key);
        assumptions.push({
          id: entryId("s", key),
          kind: "assumption",
          text: clip(text, MAX_ASSUMPTION),
          runId: run.id,
          hidden: false,
        });
      }
    } catch {
      // A state written by an older version that no longer parses has nothing to add.
    }
    let policy: RunPolicy;
    try {
      policy = PolicySchema.parse(JSON.parse(run.policy_json));
    } catch {
      continue;
    }
    const passing = new Set(
      store
        .checks(run.id)
        .filter((c) => c.status === "passed")
        .map((c) => c.check_id),
    );
    for (const check of policy.checks) {
      if (!passing.has(check.id)) continue;
      const command = commandOf(check);
      passed.set(command, (passed.get(command) ?? new Set()).add(run.id));
      if (!newest.has(command)) newest.set(command, run.id);
    }
  }
  const checks: MemoryEntry[] = [...passed].map(([command, runs]) => ({
    id: entryId("c", command),
    kind: "check",
    text: command,
    runs: runs.size,
    runId: newest.get(command) ?? "",
    hidden: false,
  }));
  return [...answers, ...assumptions, ...checks];
}

/**
 * Project memory as people see it: notes they added, then what earlier runs recorded with their
 * edits applied. Hidden entries make room for the next ones, so each kind still fills its limit.
 */
function memoryEntries(store: WorkflowStore, limit: number): MemoryEntry[] {
  const edits = new Map(store.memoryEdits().map((e) => [e.id, e]));
  const notes: MemoryEntry[] = [...edits.values()]
    .filter((e) => e.note && e.text)
    .map((e) => ({ id: e.id, kind: "note", text: e.text ?? "", hidden: false }));
  const visible: Record<string, number> = {};
  const recorded = recordedEntries(store, limit).flatMap((entry) => {
    const edit = edits.get(entry.id);
    const hidden = edit?.hidden === 1;
    if (!hidden) {
      const count = (visible[entry.kind] ?? 0) + 1;
      visible[entry.kind] = count;
      if (count > LIMITS[entry.kind as keyof typeof LIMITS]) return [];
    }
    return [
      edit?.text
        ? { ...entry, text: edit.text, recorded: entry.text, hidden }
        : { ...entry, hidden },
    ];
  });
  return [...notes.slice(0, MAX_NOTES), ...recorded];
}

/**
 * What earlier runs of this workspace learned that a new run would otherwise ask or discover again:
 * the answers people gave to research and spec questions (any run; the newest answer to a question
 * wins), the assumptions of specifications that completed runs had approved, and the check commands
 * that passed in completed runs. Analysis findings are left out: they are about one run's plan.
 * People's notes and edits (`editProjectMemory`) apply: forgotten entries are left out.
 */
export function collectProjectMemory(store: WorkflowStore, limit = MEMORY_RUNS): ProjectMemory {
  const entries = memoryEntries(store, limit).filter((e) => !e.hidden);
  const notes = entries.filter((e) => e.kind === "note").map((e) => e.text);
  return {
    answers: entries
      .filter((e) => e.kind === "answer")
      .map((e) => ({ question: e.question ?? "", answer: e.text, runId: e.runId ?? "" })),
    assumptions: entries
      .filter((e) => e.kind === "assumption")
      .map((e) => ({ text: e.text, runId: e.runId ?? "" })),
    checks: entries
      .filter((e) => e.kind === "check")
      .map((e) => ({ command: e.text, runs: e.runs ?? 0 })),
    ...(notes.length ? { notes } : {}),
  };
}

/** Project memory as a person reviews it before the next run, with what that run would read. */
export function projectMemoryView(
  store: WorkflowStore,
  policy: Pick<RunPolicy, "checks" | "projectMemory">,
  limit = MEMORY_RUNS,
): ProjectMemoryView {
  const entries = memoryEntries(store, limit);
  const own = new Set(policy.checks.map(commandOf));
  return {
    enabled: policy.projectMemory !== false,
    entries: entries
      .filter((e) => !e.hidden)
      .map((e) => ({ ...e, sent: !(e.kind === "check" && own.has(e.text)) })),
    hidden: entries.filter((e) => e.hidden),
    rendered: renderProjectMemory(collectProjectMemory(store, limit), policy),
  };
}

/**
 * Applies a person's change to project memory and returns the entry's ID. `add` writes a note,
 * `edit` rewords a note, an answer or an assumption, `forget` deletes a note or hides a recorded
 * entry, and `restore` brings back a recorded entry as runs recorded it. Runs started afterwards
 * read the result; started runs keep the memory they captured.
 */
export function editProjectMemory(
  store: WorkflowStore,
  edit: MemoryEdit,
  limit = MEMORY_RUNS,
): string {
  const text = "text" in edit ? clip(edit.text, MAX_NOTE) : "";
  if ("text" in edit && !text)
    throw new WorkflowFault("INVALID_DEFINITION", "Memory text must not be empty");
  if (edit.action === "add") {
    if (store.memoryEdits().filter((e) => e.note).length >= MAX_NOTES)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Project memory keeps at most ${String(MAX_NOTES)} notes; forget one first`,
      );
    const id = `n-${newId().replaceAll("-", "").slice(0, 10)}`;
    store.saveMemoryEdit({ id, note: 1, hidden: 0, text });
    return id;
  }
  const note = store.memoryEdits().find((e) => e.id === edit.id && e.note);
  if (note) {
    if (edit.action === "restore")
      throw new WorkflowFault("INVALID_DEFINITION", "A note has nothing to restore");
    if (edit.action === "forget") store.deleteMemoryEdit(note.id);
    else store.saveMemoryEdit({ id: note.id, note: 1, hidden: 0, text });
    return note.id;
  }
  const entry = memoryEntries(store, limit).find((e) => e.id === edit.id);
  if (!entry || entry.kind === "note")
    throw new WorkflowFault("NOT_FOUND", `No project memory entry ${edit.id}`);
  if (edit.action === "edit" && entry.kind === "check")
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "A check command cannot be reworded; forget it or change the workspace checks",
    );
  const current = store.memoryEdits().find((e) => e.id === entry.id);
  if (edit.action === "forget")
    store.saveMemoryEdit({ id: entry.id, note: 0, hidden: 1, text: current?.text ?? null });
  else if (edit.action === "restore")
    store.saveMemoryEdit({ id: entry.id, note: 0, hidden: 0, text: null });
  else store.saveMemoryEdit({ id: entry.id, note: 0, hidden: 0, text });
  return entry.id;
}

/**
 * Project memory as the research, specification and planning agents read it, or null when there
 * is nothing to say. Checks of the new run's own policy are left out; its execution contract
 * already lists them.
 */
export function renderProjectMemory(
  memory: ProjectMemory,
  policy: Pick<RunPolicy, "checks">,
): string | null {
  const own = new Set(policy.checks.map(commandOf));
  const checks = memory.checks.filter((c) => !own.has(c.command));
  const notes = memory.notes ?? [];
  if (!notes.length && !memory.answers.length && !memory.assumptions.length && !checks.length)
    return null;
  const run = (id: string) => `run ${id.slice(0, 8)}`;
  return [
    "Project memory from earlier workflow runs in this project, newest first. It is background: the request, user answers in it and this run's policy take precedence. Reuse an earlier answer or assumption only when the same question comes up again, and do not ask a person a question answered here.",
    ...(notes.length
      ? ["", "Notes people keep for this project:", ...notes.map((n) => `- ${n}`)]
      : []),
    ...(memory.answers.length
      ? [
          "",
          "Answers people gave to clarification questions:",
          ...memory.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer} (${run(a.runId)})`),
        ]
      : []),
    ...(memory.assumptions.length
      ? [
          "",
          "Assumptions in specifications people approved:",
          ...memory.assumptions.map((a) => `- ${a.text} (${run(a.runId)})`),
        ]
      : []),
    ...(checks.length
      ? [
          "",
          "Check commands that passed in completed runs:",
          ...checks.map(
            (c) => `- \`${c.command}\` (${String(c.runs)} run${c.runs === 1 ? "" : "s"})`,
          ),
        ]
      : []),
  ].join("\n");
}
