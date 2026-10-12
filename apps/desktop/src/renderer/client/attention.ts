import type { RunSnapshot } from "../../shared/api.js";
import { call } from "./api.js";
import { workflow } from "./workflow.js";

/**
 * What "Needs you" reads and sends to answer an item: the run's durable requests, delivery plans
 * and chat prompts. Run decisions go through `client/workflow.ts`.
 */

/** A durable request as `GET /v1/workflow/runs/:id` lists it (a row of the `requests` table). */
export interface RunRequest {
  id: string;
  kind: string;
  status: string;
  digest: string;
  body_json: string;
}

export interface RunWithRequests extends RunSnapshot {
  requests: RunRequest[];
}

export interface ApprovalBody {
  writes?: { path: string; action: string }[];
  checks?: { id: string; command?: string }[];
  profiles?: string[];
  deferredCriteria?: string[];
  /** Defaults the agents chose instead of asking (`clarification: "assume"`). */
  assumptions?: string[];
  executionMode?: "inline" | "worktree";
  worktree?: { branch: string; userChangesInScope?: string[] };
}

export interface ClarificationBody {
  questions?: { id?: string; question: string; blocking?: boolean }[];
  findings?: { id?: string; kind?: string; description?: string; blocking?: boolean }[];
}

/** The summary of a delivery plan stored in its request (`src/core/workflows/delivery.ts`). */
export interface DeliveryBody {
  planId?: string;
  operations?: string[];
  remote?: { name: string; url: string };
  branch?: string;
  base?: { commit: string; branch: string };
  /** "add path", "modify path" or "delete path". */
  files?: string[];
  excluded?: { path: string; reason: string }[];
  userChanges?: string[];
  commitMessage?: string;
  pullRequest?: { repository: string; title: string; base: string; draft: boolean } | null;
}

export interface PreparedDelivery {
  requestId: string;
  digest: string;
  revision: number;
}

export interface DeliveryResult {
  branch: string;
  commit: string | null;
  pullRequest: { url?: string; number?: number } | null;
}

export type ChatPrompt = { id: string; createdAt: number } & (
  | { kind: "outside-cwd"; tool: string; path: string }
  | { kind: "destructive"; description: string }
  | { kind: "web-search"; query: string }
  | { kind: "fetch-page"; url: string }
  | {
      kind: "question";
      question: string;
      allowSkip: boolean;
      options: { label: string; value: string; description?: string }[];
    }
  | {
      kind: "plan-review";
      title: string;
      depth: "light" | "full";
      steps: { id: string; label: string }[];
      planFile: string;
      content: string;
    }
  | {
      kind: "split";
      title: string;
      mode: "runs" | "initiative";
      flows: {
        id: string;
        title: string;
        paths: string[];
        dependsOn: string[];
        /** The issue (`owner/name#N`), `new issue` or `local task`; missing from older servers. */
        task?: string;
      }[];
      digest: string;
    }
);

export interface SessionPrompts {
  id: string;
  title: string;
  prompts: ChatPrompt[];
}

export function parseBody<T>(request: Pick<RunRequest, "body_json"> | undefined): T {
  if (!request) return {} as T;
  try {
    return JSON.parse(request.body_json) as T;
  } catch {
    return {} as T;
  }
}

/** One question to answer, from research or spec questions or analysis findings. */
export interface Question {
  key: string;
  text: string;
  blocking: boolean;
}

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

/** Answer keys carry the question, as the terminal UI sends them, so agents keep its meaning. */
export function answersOf(questions: Question[], answers: string[]): Record<string, string> {
  return Object.fromEntries(
    questions.flatMap((q, i) => {
      const answer = answers[i]?.trim();
      return answer ? [[`${q.key}: ${q.text.slice(0, 160)}`, answer]] : [];
    }),
  );
}

const runPath = (runId: string, action?: string): string =>
  `/v1/workflow/runs/${encodeURIComponent(runId)}${action ? `/${action}` : ""}`;

export const attentionApi = {
  run: (key: string, runId: string) => call<RunWithRequests>(key, "GET", runPath(runId)),

  /** Approves a request by its own digest, then lets the run continue. */
  approve: async (key: string, runId: string, request: RunRequest, excludeUserChanges = false) => {
    const run = await attentionApi.run(key, runId);
    await workflow.approve(
      key,
      { ...run, approvalDigest: request.digest },
      request.id,
      excludeUserChanges,
    );
    return attentionApi.resume(key, runId);
  },

  reject: async (key: string, runId: string, requestId: string, reason: string) => {
    const run = await attentionApi.run(key, runId);
    return workflow.reject(key, run, requestId, reason);
  },

  answer: async (
    key: string,
    runId: string,
    requestId: string,
    answers: Record<string, string>,
  ) => {
    const run = await attentionApi.run(key, runId);
    await workflow.answer(key, run, requestId, answers);
    return attentionApi.resume(key, runId);
  },

  resume: async (key: string, runId: string) =>
    workflow.resume(key, await attentionApi.run(key, runId)),

  /** Prepares a new plan; it supersedes the pending one and waits for its own approval. */
  prepareDelivery: (
    key: string,
    runId: string,
    options: { pullRequest?: boolean; draft?: boolean; remote?: string; branch?: string },
  ) => call<PreparedDelivery>(key, "POST", runPath(runId, "deliver"), options),

  /** Approves the plan by its digest, then performs it. */
  deliver: async (key: string, runId: string, request: RunRequest) => {
    const run = await attentionApi.run(key, runId);
    await workflow.approve(key, { ...run, approvalDigest: request.digest }, request.id);
    const approved = await attentionApi.run(key, runId);
    return call<DeliveryResult>(key, "POST", runPath(runId, "deliver/execute"), {
      expectedRevision: approved.revision,
      requestId: request.id,
    });
  },

  session: (key: string, sessionId: string) =>
    call<SessionPrompts>(key, "GET", `/v1/sessions/${encodeURIComponent(sessionId)}`),

  answerPrompt: (
    key: string,
    sessionId: string,
    promptId: string,
    body:
      | { approve: boolean; digest?: string }
      | { answer: string }
      | { action: "execute" | "clear-execute" | "cancel" },
  ) =>
    call<{ resolved: true }>(
      key,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}`,
      body,
    ),
};

/** A file line of a delivery request ("modify src/a.ts"): its action and path. */
export function deliveryFile(line: string): { action: string; path: string } {
  const space = line.indexOf(" ");
  return space < 0
    ? { action: "modify", path: line }
    : { action: line.slice(0, space), path: line.slice(space + 1) };
}

const EXCLUSION: Record<string, string> = {
  secret: "excluded, looks like a secret",
  internal: "excluded, BAKED internal file",
  ignored: "excluded, ignored by Git",
  symlink: "excluded, symbolic link",
  unchanged: "excluded, unchanged",
};

export function exclusionReason(reason: string): string {
  return EXCLUSION[reason] ?? `excluded, ${reason}`;
}
