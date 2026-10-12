import type { RunRequest } from "../../client/runs.js";

/** Request bodies as the core writes them (`body_json`), the fields the run screens read. */
export interface ApprovalBody {
  writes?: { path: string; action: string }[];
  checks?: { id: string }[];
  /** Defaults the agents chose instead of asking (`clarification: "assume"`). */
  assumptions?: string[];
  executionMode?: "inline" | "worktree";
  worktree?: { path: string; branch: string; userChangesInScope: string[] };
  acceptance?: unknown;
}
/** An effect of unknown outcome after an interruption (`recoverRun`, or a delivery step). */
export interface RecoveryBody {
  effectId?: string;
  intent?: Record<string, unknown>;
  delivery?: boolean;
}
/** A convergence that cannot start another repair round (`convergenceBody` in the core). */
export interface ConvergenceBody {
  reason?: "rounds" | "tasks" | "repeat" | "contradiction";
  summary?: string;
  checksPassing?: boolean;
  criteria?: {
    total: number;
    passing: number;
    failing: { id: string; verdict: string; explanation: string }[];
  };
  findings?: {
    id: string;
    severity: string;
    criterionIds: string[];
    file: string | null;
    symbol: string | null;
    claim: string;
    impact: string;
  }[];
  contradictions?: { findingId: string; earlierId: string; earlierClaim: string }[];
  hostRule?: { decision: string; rules: string[]; why: string };
}
export interface ClarificationBody {
  questions?: { id?: string; question: string; blocking?: boolean }[];
  findings?: { id?: string; kind?: string; description?: string; blocking?: boolean }[];
  taskId?: string;
}
export interface Question {
  key: string;
  text: string;
  blocking: boolean;
}

export const parse = <T>(json: string | null): T => {
  try {
    return (json ? JSON.parse(json) : {}) as T;
  } catch {
    return {} as T;
  }
};

/** Questions of a clarification request, as the terminal UI's decision prompt reads them. */
export function questionsOf(body: ClarificationBody): Question[] {
  if (body.questions?.length)
    return body.questions.map((q, i) => ({
      key: q.id ?? `Q${i + 1}`,
      text: q.question,
      blocking: q.blocking === true,
    }));
  if (body.findings?.length)
    return body.findings.map((f, i) => ({
      key: f.id ?? `F${i + 1}`,
      text: f.description ?? f.kind ?? "Finding",
      blocking: f.blocking === true,
    }));
  return [{ key: "Q1", text: "Clarify the request", blocking: true }];
}
/** Answer keys carry the question so the agents keep its meaning, as in the terminal UI. */
export function answersOf(questions: Question[], answers: string[]): Record<string, string> {
  return Object.fromEntries(
    questions.flatMap((q, i) => {
      const answer = answers[i]?.trim();
      return answer ? [[`${q.key}: ${q.text.slice(0, 160)}`, answer]] : [];
    }),
  );
}

/** Requests the run waits for, without the advisory acceptance decisions. */
export function blockingRequests(requests: readonly RunRequest[]): RunRequest[] {
  return requests.filter(
    (r) =>
      r.status === "pending" &&
      !(r.kind === "approval" && parse<ApprovalBody>(r.body_json).acceptance),
  );
}

export function clarificationTask(request: RunRequest): string | null {
  return request.kind === "clarification"
    ? (parse<ClarificationBody>(request.body_json).taskId ?? null)
    : null;
}
