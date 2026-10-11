import type { RunPolicy } from "./schemas.js";
import { PolicySchema } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

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
}

const clip = (text: string, max: number): string => {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const normal = (text: string): string => clip(text, MAX_QUESTION).toLowerCase();

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

/**
 * What earlier runs of this workspace learned that a new run would otherwise ask or discover again:
 * the answers people gave to research and spec questions (any run; the newest answer to a question
 * wins), the assumptions of specifications that completed runs had approved, and the check commands
 * that passed in completed runs. Analysis findings are left out: they are about one run's plan.
 */
export function collectProjectMemory(store: WorkflowStore, limit = MEMORY_RUNS): ProjectMemory {
  const answers: MemoryAnswer[] = [];
  const asked = new Set<string>();
  const assumptions: ProjectMemory["assumptions"] = [];
  const assumed = new Set<string>();
  const passed = new Map<string, Set<string>>();
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
        answers.push({ question, answer: clip(value, MAX_ANSWER), runId: run.id });
      }
    }
    if (run.status !== "completed") continue;
    try {
      for (const text of store.state(run.id).spec?.assumptions ?? []) {
        const key = normal(text);
        if (assumed.has(key)) continue;
        assumed.add(key);
        assumptions.push({ text: clip(text, MAX_ASSUMPTION), runId: run.id });
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
    }
  }
  return {
    answers: answers.slice(0, MAX_ANSWERS),
    assumptions: assumptions.slice(0, MAX_ASSUMPTIONS),
    checks: [...passed]
      .map(([command, runs]) => ({ command, runs: runs.size }))
      .slice(0, MAX_CHECKS),
  };
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
  if (!memory.answers.length && !memory.assumptions.length && !checks.length) return null;
  const run = (id: string) => `run ${id.slice(0, 8)}`;
  return [
    "Project memory from earlier workflow runs in this project, newest first. It is background: the request, user answers in it and this run's policy take precedence. Reuse an earlier answer or assumption only when the same question comes up again, and do not ask a person a question answered here.",
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
